// MDT – alarmy napadowe. Brak automatycznego odczytu pozycji z ER:LC: lokalizacja pochodzi z listy zweryfikowanych miejsc
// (mdt_locations) albo z tekstu podanego przez człowieka. Alarm cichy ma opóźnienie liczone WYŁĄCZNIE po stronie serwera.
// Idempotencja: ten sam idempotency_key nigdy nie utworzy drugiego alarmu ani zgłoszenia.
const { clip } = require('./core.js');
const radio = require('./radio.js');

const DELAY = Math.max(0, Math.min(600, parseInt(process.env.ALARM_SILENT_DELAY_SECONDS || '90', 10) || 90));
const ALSO = (process.env.ALARM_ALSO_FACTIONS || 'EMS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS mdt_locations (
    id SERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'INNE', description TEXT, active BOOLEAN NOT NULL DEFAULT true
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS robbery_alarms (
    id SERIAL PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, location_id INTEGER REFERENCES mdt_locations(id), location_text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'INNE', source TEXT NOT NULL DEFAULT 'BOT', silent BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'OCZEKUJE',   -- OCZEKUJE | WYSLANY | ANULOWANY | POTWIERDZONY | ZAMKNIETY
    fire_at TIMESTAMPTZ NOT NULL, fired_at TIMESTAMPTZ, ticket_id INTEGER, created_by INTEGER, handled_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS robbery_alarms_due_idx ON robbery_alarms (fire_at) WHERE status='OCZEKUJE'`);
}

// wysyłka należnych alarmów: jedna transakcja = zmiana statusu + zgłoszenie + komunikat radiowy (albo nic)
async function fireDue(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = (await client.query(
      `UPDATE robbery_alarms SET status='WYSLANY', fired_at=now() WHERE id IN
         (SELECT id FROM robbery_alarms WHERE status='OCZEKUJE' AND fire_at <= now() ORDER BY fire_at FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING *`)).rows;
    for (const a of due) {
      const t = await client.query(
        `INSERT INTO tickets (faction, kind, status, location, description, priority, source, also_factions, alarm_id)
         VALUES ('LAPD', $1, 'NOWE', $2, $3, 1, 'ALARM', $4, $5) RETURNING ticket_id`,
        ['Alarm napadowy – ' + a.kind, a.location_text, `Alarm napadowy (${a.kind}) – ${a.location_text}. Źródło: ${a.source}.`, ALSO.filter((x) => x !== 'LAPD'), a.id]);
      await client.query('UPDATE robbery_alarms SET ticket_id=$2 WHERE id=$1', [a.id, t.rows[0].ticket_id]);
      await client.query(`INSERT INTO ticket_log (ticket_id, action, note) VALUES ($1,'UTWORZONO','Alarm #' || $2)`, [t.rows[0].ticket_id, String(a.id)]);
      await radio.systemMessage(client, 'DISPATCH', 'ALARM', `🚨 ALARM NAPADOWY (${a.kind}) – ${a.location_text} – zgłoszenie #${t.rows[0].ticket_id}`);
    }
    await client.query('COMMIT');
    return due.length;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('alarm scheduler:', e.message); return 0; } finally { client.release(); }
}

function register(app, { pool, requireInternalKey }) {
  const { auth, need, wrap, audit } = app.locals.mdt;

  async function create({ key, locationKey, locationText, kind, source, silent, createdBy }) {
    let loc = null;
    if (locationKey) loc = (await pool.query('SELECT id, name FROM mdt_locations WHERE key=$1 AND active', [clip(locationKey, 40)])).rows[0] || null;
    if (locationKey && !loc) return { status: 404, error: 'Nieznana lokalizacja (dodaj ją do listy zweryfikowanych miejsc).' };
    const text = loc ? loc.name : clip(locationText, 160);
    if (!text || text.length < 2) return { status: 400, error: 'Podaj lokalizację (location_key albo location_text).' };
    const delay = silent ? DELAY : 0;
    const r = await pool.query(
      `INSERT INTO robbery_alarms (idempotency_key, location_id, location_text, kind, source, silent, fire_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval, $8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [clip(key, 80), loc ? loc.id : null, text, clip(kind, 20).toUpperCase() || 'INNE', source, !!silent, String(delay), createdBy || null]);
    if (!r.rowCount) {
      const ex = (await pool.query('SELECT id, status, ticket_id FROM robbery_alarms WHERE idempotency_key=$1', [clip(key, 80)])).rows[0];
      return { status: 200, body: { ok: true, duplicate: true, alarm_id: ex.id, alarm_status: ex.status, ticket_id: ex.ticket_id } };
    }
    if (delay === 0) await fireDue(pool);
    const a = (await pool.query('SELECT id, status, ticket_id, fire_at FROM robbery_alarms WHERE id=$1', [r.rows[0].id])).rows[0];
    return { status: 200, body: { ok: true, duplicate: false, alarm_id: a.id, alarm_status: a.status, ticket_id: a.ticket_id, fire_at: a.fire_at } };
  }

  // punkt integracji dla przyszłego systemu napadów (bot / API): klucz idempotencji obowiązkowy
  app.post('/internal/mdt/alarms', requireInternalKey, wrap(async (req, res) => {
    if (!clip(req.body.idempotency_key, 80)) return res.status(400).json({ error: 'Wymagane: idempotency_key.' });
    const r = await create({ key: req.body.idempotency_key, locationKey: req.body.location_key, locationText: req.body.location_text, kind: req.body.kind, source: clip(req.body.source, 20) || 'BOT', silent: req.body.silent !== false });
    res.status(r.status).json(r.body || { error: r.error });
  }));
  app.post('/internal/mdt/alarms/:key/cancel', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(`UPDATE robbery_alarms SET status='ANULOWANY' WHERE idempotency_key=$1 AND status='OCZEKUJE' RETURNING id`, [clip(req.params.key, 80)]);
    res.json({ ok: true, cancelled: r.rowCount > 0 });
  }));

  // ręczny alarm z tabletu (testy / zgłoszenie od człowieka)
  app.post('/mdt/alarms', auth, need('alarms.manage'), wrap(async (req, res) => {
    const key = 'mdt-' + req.customerId + '-' + (clip(req.body.client_key, 40) || Date.now());
    const r = await create({ key, locationKey: req.body.location_key, locationText: req.body.location_text, kind: req.body.kind, source: 'MDT', silent: req.body.silent !== false && req.body.silent !== 'false' && !req.body.immediate, createdBy: req.customerId });
    if (r.status === 200) await audit(null, { faction: req.faction, actor: req.customerId, action: 'ALARM_RECZNY', objectType: 'alarm', target: r.body.alarm_id });
    res.status(r.status).json(r.body || { error: r.error });
  }));
  app.get('/mdt/alarms', auth, need('alarms.read'), wrap(async (req, res) => {
    const r = await pool.query(`SELECT id, kind, location_text, source, silent, status, fire_at, fired_at, ticket_id, created_at FROM robbery_alarms ORDER BY id DESC LIMIT 50`);
    res.json(r.rows);
  }));
  app.post('/mdt/alarms/:id/status', auth, need('alarms.manage'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); const st = String(req.body.status || '');
    const allowed = { ANULOWANY: ['OCZEKUJE'], POTWIERDZONY: ['WYSLANY'], ZAMKNIETY: ['WYSLANY', 'POTWIERDZONY'] };
    if (!allowed[st]) return res.status(400).json({ error: 'Status: ANULOWANY | POTWIERDZONY | ZAMKNIETY' });
    const r = await pool.query(`UPDATE robbery_alarms SET status=$2, handled_by=$3 WHERE id=$1 AND status = ANY($4) RETURNING 1`, [id, st, req.customerId, allowed[st]]);
    if (!r.rowCount) return res.status(409).json({ error: 'Ta zmiana nie jest teraz możliwa.' });
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'ALARM_' + st, objectType: 'alarm', target: id });
    res.json({ ok: true });
  }));

  // zweryfikowane lokalizacje
  app.get('/mdt/locations', auth, need('alarms.read'), wrap(async (req, res) => {
    res.json((await pool.query('SELECT key, name, kind, description FROM mdt_locations WHERE active ORDER BY name')).rows);
  }));
  app.post('/mdt/locations', auth, need('alarms.manage'), wrap(async (req, res) => {
    const key = clip(req.body.key, 40).toLowerCase().replace(/[^a-z0-9_-]/g, ''); const name = clip(req.body.name, 100);
    if (!key || !name) return res.status(400).json({ error: 'Podaj key i name.' });
    await pool.query(`INSERT INTO mdt_locations (key, name, kind, description) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, description=EXCLUDED.description, active=true`,
      [key, name, clip(req.body.kind, 20).toUpperCase() || 'INNE', clip(req.body.description, 200) || null]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'LOKALIZACJA_ZAPIS', objectType: 'location', target: key });
    res.json({ ok: true });
  }));

  // harmonogram (co 5 s); wiele instancji jest bezpiecznych (SKIP LOCKED)
  const t = setInterval(() => fireDue(pool), 5000); t.unref();
}
module.exports = { migrate, register, fireDue, DELAY };
