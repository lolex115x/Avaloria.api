// MDT – radio tekstowe (bez głosu): kanały z regułami dostępu, wiadomości zapisywane po stronie serwera,
// tożsamość nadawcy zawsze z sesji (klient nie może podać cudzej), limit tempa, odczyt przyrostowy (?since=).
const { clip, rankIdx } = require('./core.js');

const DEFAULT_CHANNELS = [
  { key: 'DISPATCH', name: 'Dispatch', allowed: ['LAPD', 'LAFD', 'EMS', 'DOT'], min_rank: 'PRACOWNIK', perm: null },
  { key: 'LAPD', name: 'Policja (LAPD)', allowed: ['LAPD'], min_rank: 'PRACOWNIK', perm: null },
  { key: 'LAFD', name: 'Straż (LAFD)', allowed: ['LAFD'], min_rank: 'PRACOWNIK', perm: null },
  { key: 'EMS', name: 'Medycy (EMS)', allowed: ['EMS'], min_rank: 'PRACOWNIK', perm: null },
  { key: 'DOT', name: 'Drogowcy (DOT)', allowed: ['DOT'], min_rank: 'PRACOWNIK', perm: null },
  { key: 'INTEROP', name: 'Interop (wspólny)', allowed: ['LAPD', 'LAFD', 'EMS', 'DOT'], min_rank: 'PRACOWNIK', perm: 'radio.interop' },
  { key: 'COMMAND', name: 'Command (dowództwo)', allowed: ['LAPD', 'LAFD', 'EMS', 'DOT', 'DOJ'], min_rank: 'SZEF', perm: 'radio.command' },
];
const RETENTION_DAYS = 7;

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS radio_channels (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, allowed_factions TEXT[] NOT NULL DEFAULT '{}', min_rank TEXT NOT NULL DEFAULT 'PRACOWNIK',
    require_perm TEXT, active BOOLEAN NOT NULL DEFAULT true
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS radio_messages (
    id BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL REFERENCES radio_channels(key), sender_customer_id INTEGER,
    sender_name TEXT NOT NULL, callsign TEXT, faction TEXT, kind TEXT NOT NULL DEFAULT 'MSG', body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS radio_messages_ch_idx ON radio_messages (channel, id DESC)`);
  for (const c of DEFAULT_CHANNELS) {
    await pool.query(`INSERT INTO radio_channels (key, name, allowed_factions, min_rank, require_perm) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [c.key, c.name, c.allowed, c.min_rank, c.perm]);
  }
}

// wspólny zapis wiadomości systemowej (alarmy, panic)
async function systemMessage(db, channel, kind, body) {
  await db.query(`INSERT INTO radio_messages (channel, sender_name, kind, body) VALUES ($1,'SYSTEM',$2,$3)`, [channel, kind, clip(body, 400)]);
}

function register(app, { pool }) {
  const { auth, need, wrap, audit } = app.locals.mdt;

  const canUse = (req, ch) => {
    const p = req.mdt.perms;
    if (!ch.active || !p.has('radio.access') || !p.has('radio.channel.join') || !req.faction) return false;
    if (ch.allowed_factions.length && !ch.allowed_factions.includes(req.faction)) return false;
    if (rankIdx(req.rank) < rankIdx(ch.min_rank)) return false;
    if (ch.require_perm && !p.has(ch.require_perm)) return false;
    return true;
  };
  const getChannel = async (req, res) => {
    const ch = (await pool.query('SELECT * FROM radio_channels WHERE key=$1', [String(req.params.key || '').toUpperCase()])).rows[0];
    if (!ch || !canUse(req, ch)) { res.status(403).json({ error: 'Nie masz dostępu do tego kanału.' }); return null; }
    return ch;
  };

  app.get('/mdt/radio/channels', auth, need('radio.access'), wrap(async (req, res) => {
    const all = (await pool.query('SELECT key, name, allowed_factions, min_rank, require_perm, active FROM radio_channels ORDER BY key')).rows;
    const out = [];
    for (const ch of all) if (canUse(req, { ...ch })) {
      const last = (await pool.query('SELECT COALESCE(MAX(id),0)::bigint AS id FROM radio_messages WHERE channel=$1', [ch.key])).rows[0].id;
      out.push({ key: ch.key, name: ch.name, last_id: Number(last) });
    }
    res.json(out);
  }));

  app.get('/mdt/radio/:key/messages', auth, need('radio.access'), wrap(async (req, res) => {
    const ch = await getChannel(req, res); if (!ch) return;
    const since = parseInt(req.query.since, 10) || 0;
    const r = since
      ? await pool.query(`SELECT id, sender_customer_id, sender_name, callsign, faction, kind, body, created_at FROM radio_messages WHERE channel=$1 AND id>$2 ORDER BY id LIMIT 200`, [ch.key, since])
      : await pool.query(`SELECT * FROM (SELECT id, sender_customer_id, sender_name, callsign, faction, kind, body, created_at FROM radio_messages WHERE channel=$1 ORDER BY id DESC LIMIT 60) x ORDER BY id`, [ch.key]);
    res.json({ messages: r.rows.map((m) => ({ ...m, id: Number(m.id) })), me: req.customerId });
  }));

  async function post(req, res, ch, kind, text) {
    const body = clip(text, 300);
    if (!body.length) return res.status(400).json({ error: 'Pusta wiadomość.' });
    const duty = (await pool.query('SELECT callsign FROM faction_duty WHERE customer_id=$1 AND faction=$2', [req.customerId, req.faction])).rows[0];
    if (!duty) return res.status(409).json({ error: 'Nadawać można tylko będąc na służbie.' });
    // limit: max 15 wiadomości na minutę na osobę
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM radio_messages WHERE sender_customer_id=$1 AND created_at > now() - interval '1 minute'`, [req.customerId])).rows[0].n;
    if (n >= 15) return res.status(429).json({ error: 'Za dużo wiadomości – zwolnij.' });
    const name = `${req.mdt.customer.first_name} ${req.mdt.customer.last_name}`;
    const r = await pool.query(`INSERT INTO radio_messages (channel, sender_customer_id, sender_name, callsign, faction, kind, body) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ch.key, req.customerId, name, duty.callsign, req.faction, kind, body]);
    res.json({ ok: true, id: Number(r.rows[0].id) });
  }
  app.post('/mdt/radio/:key/send', auth, need('radio.access'), wrap(async (req, res) => {
    const ch = await getChannel(req, res); if (!ch) return;
    await post(req, res, ch, 'MSG', req.body.text);
  }));

  // przycisk bezpieczeństwa: komunikat na kanale własnej frakcji i na Dispatch
  app.post('/mdt/radio/panic', auth, need('radio.access'), wrap(async (req, res) => {
    const duty = (await pool.query('SELECT callsign FROM faction_duty WHERE customer_id=$1 AND faction=$2', [req.customerId, req.faction])).rows[0];
    if (!duty) return res.status(409).json({ error: 'Panic działa tylko na służbie.' });
    const who = `${duty.callsign || ''} ${req.mdt.customer.first_name} ${req.mdt.customer.last_name}`.trim();
    const where = clip(req.body.location, 120);
    const text = `🆘 PANIC – ${who} (${req.faction})${where ? ' – ' + where : ''}`;
    for (const k of ['DISPATCH', req.faction]) {
      const ex = (await pool.query('SELECT 1 FROM radio_channels WHERE key=$1', [k])).rowCount;
      if (ex) await systemMessage(pool, k, 'PANIC', text);
    }
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'PANIC', objectType: 'unit', target: duty.callsign });
    res.json({ ok: true });
  }));

  // zarządzanie kanałami
  app.post('/mdt/radio/channels', auth, need('radio.channel.manage'), wrap(async (req, res) => {
    const key = clip(req.body.key, 20).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const name = clip(req.body.name, 40);
    if (!key || !name) return res.status(400).json({ error: 'Podaj key i name.' });
    const allowed = (Array.isArray(req.body.allowed_factions) ? req.body.allowed_factions : []).map((x) => String(x).toUpperCase()).filter((x) => ['LAPD', 'LAFD', 'EMS', 'DOT', 'DOJ'].includes(x));
    const minRank = ['PRACOWNIK', 'ZASTEPCA', 'SZEF'].includes(req.body.min_rank) ? req.body.min_rank : 'PRACOWNIK';
    const perm = req.body.require_perm ? clip(req.body.require_perm, 40) : null;
    await pool.query(`INSERT INTO radio_channels (key, name, allowed_factions, min_rank, require_perm, active) VALUES ($1,$2,$3,$4,$5,$6)
                      ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, allowed_factions=EXCLUDED.allowed_factions, min_rank=EXCLUDED.min_rank, require_perm=EXCLUDED.require_perm, active=EXCLUDED.active`,
      [key, name, allowed, minRank, perm, req.body.active !== false]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'KANAL_ZMIANA', objectType: 'radio', target: key });
    res.json({ ok: true });
  }));

  // sprzątanie starych wiadomości
  const t = setInterval(() => pool.query(`DELETE FROM radio_messages WHERE created_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]).catch(() => {}), 6 * 3600 * 1000);
  t.unref();
}
module.exports = { migrate, register, systemMessage };
