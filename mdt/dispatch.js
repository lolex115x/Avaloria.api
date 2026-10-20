// MDT – Dispatch Center: zgłoszenia (rozszerzona tabela tickets), jednostki (faction_duty + znak wywoławczy/status),
// przydziały (ticket_units). Wszystkie przejścia statusów i przydziały są atomowe i sprawdzane na serwerze.
const { clip, rankIdx } = require('./core.js');

const DISPATCH_FACTIONS = ['LAPD', 'LAFD', 'EMS', 'DOT'];
const OPEN = ['NOWE', 'PRZYJETE', 'PRZYDZIELONE', 'W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE'];
const NEXT = {
  NOWE: ['PRZYJETE', 'ANULOWANE'],
  PRZYJETE: ['W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'],
  PRZYDZIELONE: ['W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'],
  W_DRODZE: ['NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'],
  NA_MIEJSCU: ['W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'],
  W_TRAKCIE: ['NA_MIEJSCU', 'ZAKONCZONE', 'ANULOWANE'],
};
const UNIT_FOR = { W_DRODZE: 'W_DRODZE', NA_MIEJSCU: 'NA_MIEJSCU', W_TRAKCIE: 'ZAJETY' };

async function migrate(pool) {
  await pool.query(`ALTER TABLE faction_duty ADD COLUMN IF NOT EXISTS callsign TEXT`);
  await pool.query(`ALTER TABLE faction_duty ADD COLUMN IF NOT EXISTS unit_status TEXT NOT NULL DEFAULT 'DOSTEPNY'`);
  await pool.query(`ALTER TABLE faction_duty ADD COLUMN IF NOT EXISTS status_note TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS faction_duty_callsign_uq ON faction_duty (faction, callsign) WHERE callsign IS NOT NULL`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 3`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'TELEFON'`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS also_factions TEXT[] NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS alarm_id INTEGER`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_units (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id),
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    faction TEXT NOT NULL,
    assigned_by INTEGER, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ, released_by INTEGER
  )`);
  // jedna jednostka = jedno aktywne zgłoszenie; jedna jednostka nie może być dwa razy w tym samym zgłoszeniu
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ticket_units_active_unit_uq ON ticket_units (customer_id) WHERE released_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ticket_units_ticket_idx ON ticket_units (ticket_id) WHERE released_at IS NULL`);
  // licznik rewizji: tani polling (klient pyta ?rev=, serwer odpowiada pełnym stanem tylko gdy się zmienił)
  await pool.query(`CREATE TABLE IF NOT EXISTS mdt_rev (id INTEGER PRIMARY KEY, rev BIGINT NOT NULL)`);
  await pool.query(`INSERT INTO mdt_rev (id, rev) VALUES (1, 1) ON CONFLICT DO NOTHING`);
  await pool.query(`CREATE OR REPLACE FUNCTION mdt_bump() RETURNS trigger AS $$ BEGIN UPDATE mdt_rev SET rev = rev + 1 WHERE id = 1; RETURN NULL; END $$ LANGUAGE plpgsql`);
  for (const t of ['tickets', 'ticket_units', 'faction_duty']) {
    await pool.query(`DROP TRIGGER IF EXISTS mdt_bump_${t} ON ${t}`);
    await pool.query(`CREATE TRIGGER mdt_bump_${t} AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION mdt_bump()`);
  }
}

function register(app, { pool }) {
  const { auth, need, wrap, audit } = app.locals.mdt;
  const tlog = (db, id, actor, action, note) => db.query('INSERT INTO ticket_log (ticket_id, actor_customer_id, action, note) VALUES ($1,$2,$3,$4)', [id, actor, action, note || null]);

  // zgłoszenie widoczne: główna frakcja albo dodatkowa; wszystkie – tylko z dispatch.calls.view_all
  const visibleSql = (req, args) => {
    if (req.mdt.perms.has('dispatch.calls.view_all')) return 'TRUE';
    args.push(req.faction);
    return `(t.faction = $${args.length} OR $${args.length} = ANY(t.also_factions))`;
  };
  const canSee = (req, t) => req.mdt.perms.has('dispatch.calls.view_all') || t.faction === req.faction || (t.also_factions || []).includes(req.faction);
  const canManageCall = (req, t) => req.mdt.perms.has('dispatch.calls.manage') && canSee(req, t);

  app.get('/mdt/dispatch/state', auth, need('dispatch.access'), wrap(async (req, res) => {
    const rev = Number((await pool.query('SELECT rev FROM mdt_rev WHERE id=1')).rows[0].rev);
    if (String(req.query.rev || '') === String(rev)) return res.json({ rev, unchanged: true });
    const args = []; const vis = visibleSql(req, args);
    const calls = (await pool.query(
      `SELECT t.ticket_id, t.faction, t.also_factions, t.kind, t.status, t.priority, t.source, t.location, t.description, t.created_at, t.updated_at, t.alarm_id,
              (SELECT COALESCE(json_agg(json_build_object('customer_id', u.customer_id, 'faction', u.faction, 'callsign', d.callsign, 'name', c.first_name || ' ' || c.last_name)), '[]'::json)
                 FROM ticket_units u JOIN customers c ON c.customer_id = u.customer_id
                 LEFT JOIN faction_duty d ON d.customer_id = u.customer_id AND d.faction = u.faction
                WHERE u.ticket_id = t.ticket_id AND u.released_at IS NULL) AS units
       FROM tickets t WHERE ${vis} AND (t.status = ANY($${args.length + 1}) OR t.closed_at > now() - interval '30 minutes')
       ORDER BY (t.status = ANY($${args.length + 2})) ASC, t.priority ASC, t.created_at DESC LIMIT 100`, [...args, OPEN, ['ZAKONCZONE', 'ANULOWANE']])).rows;
    const uargs = []; let ufilter = 'TRUE';
    if (!req.mdt.perms.has('dispatch.calls.view_all')) { uargs.push(req.faction); ufilter = `d.faction = $1`; }
    const units = (await pool.query(
      `SELECT d.customer_id, d.faction, d.callsign, d.unit_status, d.status_note, d.since, c.first_name || ' ' || c.last_name AS name,
              (SELECT u.ticket_id FROM ticket_units u WHERE u.customer_id = d.customer_id AND u.released_at IS NULL) AS ticket_id
       FROM faction_duty d JOIN customers c ON c.customer_id = d.customer_id WHERE ${ufilter} AND d.faction = ANY($${uargs.length + 1}) ORDER BY d.faction, d.callsign NULLS LAST`,
      [...uargs, DISPATCH_FACTIONS])).rows;
    res.json({ rev, calls, units, me: req.customerId });
  }));

  app.get('/mdt/dispatch/calls/:id', auth, need('dispatch.access'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = (await pool.query('SELECT * FROM tickets WHERE ticket_id=$1', [id])).rows[0];
    if (!t || !canSee(req, t)) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    const log = (await pool.query(`SELECT l.action, l.note, l.at, c.first_name || ' ' || c.last_name AS who FROM ticket_log l LEFT JOIN customers c ON c.customer_id = l.actor_customer_id WHERE l.ticket_id=$1 ORDER BY l.id`, [id])).rows;
    res.json({ call: t, log });
  }));

  app.post('/mdt/dispatch/calls', auth, need('dispatch.access', 'dispatch.calls.create'), wrap(async (req, res) => {
    const b = req.body;
    let faction = String(b.faction || req.faction).toUpperCase();
    if (!DISPATCH_FACTIONS.includes(faction)) return res.status(400).json({ error: 'Zgłoszenie można skierować do: ' + DISPATCH_FACTIONS.join(', ') });
    if (faction !== req.faction && !req.mdt.perms.has('dispatch.calls.manage')) return res.status(403).json({ error: 'Tylko własna frakcja jest dostępna jako główna.' });
    const also = [...new Set((Array.isArray(b.also_factions) ? b.also_factions : []).map((x) => String(x).toUpperCase()))].filter((x) => DISPATCH_FACTIONS.includes(x) && x !== faction);
    const location = clip(b.location, 160); const description = clip(b.description, 800); const kind = clip(b.kind, 60) || 'Zgłoszenie';
    const priority = Math.max(1, Math.min(4, parseInt(b.priority, 10) || 3));
    if (location.length < 2 || description.length < 3) return res.status(400).json({ error: 'Podaj lokalizację i opis.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO tickets (faction, kind, status, location, description, created_by, priority, source, also_factions) VALUES ($1,$2,'NOWE',$3,$4,$5,$6,'MDT',$7) RETURNING ticket_id`,
        [faction, kind, location, description, req.customerId, priority, also]);
      const id = r.rows[0].ticket_id;
      await tlog(client, id, req.customerId, 'UTWORZONO', `P${priority} → ${[faction, ...also].join(', ')}`);
      await audit(client, { faction: req.faction, actor: req.customerId, action: 'ZGLOSZENIE_UTWORZONE', objectType: 'ticket', target: id });
      await client.query('COMMIT');
      res.json({ ok: true, ticket_id: id });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // zmiana statusu: tylko dozwolone przejście, atomowo; przydzielona jednostka albo osoba z calls.manage
  app.post('/mdt/dispatch/calls/:id/status', auth, need('dispatch.access'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); const to = String(req.body.status || '');
    const result = clip(req.body.result, 500);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = (await client.query('SELECT * FROM tickets WHERE ticket_id=$1 FOR UPDATE', [id])).rows[0];
      if (!t || !canSee(req, t)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' }); }
      const mine = (await client.query('SELECT 1 FROM ticket_units WHERE ticket_id=$1 AND customer_id=$2 AND released_at IS NULL', [id, req.customerId])).rowCount > 0;
      const manage = canManageCall(req, t);
      if (!(NEXT[t.status] || []).includes(to)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Zmiana ${t.status} → ${to} nie jest dozwolona.` }); }
      if (to === 'ANULOWANE') {
        if (!(manage || t.created_by === req.customerId)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Anulować może autor lub kierownictwo.' }); }
      } else if (to === 'PRZYJETE') {
        if (t.faction !== req.faction && !manage) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Przyjąć może frakcja główna.' }); }
      } else if (!(mine || manage)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Status zmienia przydzielona jednostka lub kierownictwo.' }); }
      if (to === 'ZAKONCZONE' && result.length < 2) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Wpisz wynik zgłoszenia.' }); }
      const closing = to === 'ZAKONCZONE' || to === 'ANULOWANE';
      const u = await client.query(
        `UPDATE tickets SET status=$2, updated_at=now(), closed_at=CASE WHEN $3 THEN now() END, result=CASE WHEN $2='ZAKONCZONE' THEN $4 ELSE result END
         WHERE ticket_id=$1 AND status=$5 RETURNING 1`, [id, to, closing, result, t.status]);
      if (!u.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Zgłoszenie właśnie ktoś zmienił – odśwież.' }); }
      if (closing) {
        await client.query('UPDATE faction_duty SET unit_status=\'DOSTEPNY\' WHERE customer_id IN (SELECT customer_id FROM ticket_units WHERE ticket_id=$1 AND released_at IS NULL)', [id]);
        await client.query('UPDATE ticket_units SET released_at=now(), released_by=$2 WHERE ticket_id=$1 AND released_at IS NULL', [id, req.customerId]);
      } else if (UNIT_FOR[to]) {
        await client.query('UPDATE faction_duty SET unit_status=$2 WHERE customer_id IN (SELECT customer_id FROM ticket_units WHERE ticket_id=$1 AND released_at IS NULL)', [id, UNIT_FOR[to]]);
      }
      await tlog(client, id, req.customerId, to, closing ? result : clip(req.body.note, 300));
      await audit(client, { faction: req.faction, actor: req.customerId, action: 'ZGLOSZENIE_' + to, objectType: 'ticket', target: id });
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // przydział jednostki: kierownictwo przydziela dowolną jednostkę widocznych frakcji; jednostka może przydzielić tylko siebie
  app.post('/mdt/dispatch/calls/:id/assign', auth, need('dispatch.access'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cid = req.body.customer_id == null ? req.customerId : parseInt(req.body.customer_id, 10);
    if (!Number.isInteger(cid)) return res.status(400).json({ error: 'Zły identyfikator jednostki.' });
    if (cid !== req.customerId && !req.mdt.perms.has('dispatch.units.assign')) return res.status(403).json({ error: 'Brak uprawnienia do przydzielania innych jednostek.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = (await client.query('SELECT * FROM tickets WHERE ticket_id=$1 FOR UPDATE', [id])).rows[0];
      if (!t || !canSee(req, t)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' }); }
      if (!OPEN.includes(t.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Zgłoszenie jest zamknięte.' }); }
      const d = (await client.query(`SELECT d.faction, d.callsign FROM faction_duty d JOIN faction_members m ON m.customer_id=d.customer_id AND m.faction=d.faction
                                      WHERE d.customer_id=$1 AND NOT m.suspended AND d.faction = ANY($2)`, [cid, [t.faction, ...(t.also_factions || [])]])).rows[0];
      if (!d) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Ta jednostka nie jest na służbie we frakcji obsługującej zgłoszenie.' }); }
      try {
        await client.query('INSERT INTO ticket_units (ticket_id, customer_id, faction, assigned_by) VALUES ($1,$2,$3,$4)', [id, cid, d.faction, req.customerId]);
      } catch (e) {
        if (e.code === '23505') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Ta jednostka obsługuje już inne zgłoszenie (zwolnij ją najpierw).' }); }
        throw e;
      }
      await client.query(`UPDATE tickets SET status=CASE WHEN status IN ('NOWE','PRZYJETE') THEN 'PRZYDZIELONE' ELSE status END, assigned_to=COALESCE(assigned_to,$2), updated_at=now() WHERE ticket_id=$1`, [id, cid]);
      await tlog(client, id, req.customerId, 'PRZYDZIELONO', d.callsign || ('user ' + cid));
      await audit(client, { faction: req.faction, actor: req.customerId, action: 'JEDNOSTKA_PRZYDZIELONA', objectType: 'ticket', target: id, detail: `unit ${cid}` });
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  app.post('/mdt/dispatch/calls/:id/release', auth, need('dispatch.access'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cid = req.body.customer_id == null ? req.customerId : parseInt(req.body.customer_id, 10);
    if (cid !== req.customerId && !req.mdt.perms.has('dispatch.units.assign')) return res.status(403).json({ error: 'Brak uprawnienia do zwalniania innych jednostek.' });
    const t = (await pool.query('SELECT * FROM tickets WHERE ticket_id=$1', [id])).rows[0];
    if (!t || !canSee(req, t)) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    const r = await pool.query('UPDATE ticket_units SET released_at=now(), released_by=$3 WHERE ticket_id=$1 AND customer_id=$2 AND released_at IS NULL RETURNING 1', [id, cid, req.customerId]);
    if (!r.rowCount) return res.status(409).json({ error: 'Ta jednostka nie jest przydzielona.' });
    await pool.query(`UPDATE faction_duty SET unit_status='DOSTEPNY' WHERE customer_id=$1`, [cid]);
    await tlog(pool, id, req.customerId, 'ZWOLNIONO', 'user ' + cid);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'JEDNOSTKA_ZWOLNIONA', objectType: 'ticket', target: id, detail: `unit ${cid}` });
    res.json({ ok: true });
  }));

  app.post('/mdt/dispatch/calls/:id/note', auth, need('dispatch.access'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); const note = clip(req.body.note, 500);
    if (note.length < 2) return res.status(400).json({ error: 'Pusta notatka.' });
    const t = (await pool.query('SELECT * FROM tickets WHERE ticket_id=$1', [id])).rows[0];
    if (!t || !canSee(req, t)) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    await tlog(pool, id, req.customerId, 'NOTATKA', note);
    res.json({ ok: true });
  }));

  // priorytet i frakcje dodatkowe (współpraca służb): tylko kierownictwo dispatchu
  app.post('/mdt/dispatch/calls/:id/edit', auth, need('dispatch.calls.manage'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = (await pool.query('SELECT * FROM tickets WHERE ticket_id=$1', [id])).rows[0];
    if (!t || !canSee(req, t)) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    if (!OPEN.includes(t.status)) return res.status(409).json({ error: 'Zgłoszenie jest zamknięte.' });
    const sets = []; const args = [id]; const ch = [];
    if (req.body.priority !== undefined) { args.push(Math.max(1, Math.min(4, parseInt(req.body.priority, 10) || 3))); sets.push(`priority=$${args.length}`); ch.push('priorytet'); }
    if (Array.isArray(req.body.also_factions)) {
      const also = [...new Set(req.body.also_factions.map((x) => String(x).toUpperCase()))].filter((x) => DISPATCH_FACTIONS.includes(x) && x !== t.faction);
      args.push(also); sets.push(`also_factions=$${args.length}`); ch.push('frakcje: ' + also.join(','));
    }
    if (!sets.length) return res.status(400).json({ error: 'Brak zmian.' });
    await pool.query(`UPDATE tickets SET ${sets.join(', ')}, updated_at=now() WHERE ticket_id=$1`, args);
    await tlog(pool, id, req.customerId, 'EDYCJA', ch.join('; '));
    res.json({ ok: true });
  }));
}

module.exports = { migrate, register, OPEN, NEXT, DISPATCH_FACTIONS };
