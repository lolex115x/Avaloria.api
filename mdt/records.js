// MDT – kartoteki: osoby (customers), pojazdy, poszukiwani/alerty, raporty. Brak automatycznego odczytu pozycji z ER:LC.
const { clip } = require('./core.js');
const normPlate = (s) => clip(s, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
const VEH_STATUS = ['OK', 'SKRADZIONY', 'POSZUKIWANY', 'ZHOLOWANY', 'KONFISKOWANY'];
const FACTIONS = ['LAPD', 'LAFD', 'EMS', 'DOT', 'DOJ'];

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS vehicles (
    vehicle_id SERIAL PRIMARY KEY, plate TEXT NOT NULL UNIQUE, model TEXT, color TEXT,
    owner_customer_id INTEGER REFERENCES customers(customer_id), owner_text TEXT,
    status TEXT NOT NULL DEFAULT 'OK', note TEXT,
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS vehicles_owner_idx ON vehicles (owner_customer_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mdt_warrants (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'POSZUKIWANY',
    subject_customer_id INTEGER REFERENCES customers(customer_id), subject_name TEXT, plate TEXT,
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'AKTYWNY',
    created_by INTEGER NOT NULL, created_faction TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_by INTEGER, closed_at TIMESTAMPTZ, close_note TEXT
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mdt_warrants_subject_idx ON mdt_warrants (subject_customer_id, status)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mdt_reports (
    id SERIAL PRIMARY KEY, faction TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'RAPORT',
    author_customer_id INTEGER NOT NULL, subject_customer_id INTEGER REFERENCES customers(customer_id), ticket_id INTEGER,
    title TEXT NOT NULL, body TEXT NOT NULL, classification TEXT NOT NULL DEFAULT 'JAWNA', status TEXT NOT NULL DEFAULT 'ZLOZONY',
    shared_with TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mdt_reports_faction_idx ON mdt_reports (faction, created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mdt_report_edits (
    id SERIAL PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES mdt_reports(id), editor_customer_id INTEGER NOT NULL,
    old_title TEXT, old_body TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

function register(app, { pool }) {
  const { auth, need, wrap, audit } = app.locals.mdt;
  const SQL_SSN = `upper(replace(replace(c.ssn_rp,' ',''),'-',''))`;
  const REAL = `c.username NOT LIKE 'svc\\_%' AND c.username NOT LIKE 'npc\\_%' AND c.status='ACTIVE'`;

  // ---------- osoby ----------
  app.get('/mdt/persons', auth, need('mdt.persons.read'), wrap(async (req, res) => {
    const q = clip(req.query.q, 60);
    if (q.length < 2) return res.json([]);
    const norm = q.toUpperCase().replace(/[\s-]+/g, '');
    const r = await pool.query(
      `SELECT c.customer_id, c.first_name, c.last_name, c.phone_number, c.ssn_rp,
              (SELECT COUNT(*)::int FROM mdt_warrants w WHERE w.subject_customer_id=c.customer_id AND w.status='AKTYWNY') AS warrants
       FROM customers c WHERE ${REAL} AND (lower(c.first_name || ' ' || c.last_name) LIKE '%' || lower($1) || '%' OR ${SQL_SSN} = $2 OR c.phone_number = $3)
       ORDER BY c.last_name, c.first_name LIMIT 20`, [q, norm, q]);
    res.json(r.rows);
  }));
  app.get('/mdt/persons/:id', auth, need('mdt.persons.read'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const p = (await pool.query(`SELECT c.customer_id, c.first_name, c.last_name, c.phone_number, c.ssn_rp FROM customers c WHERE c.customer_id=$1 AND ${REAL}`, [id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Nie znaleziono osoby.' });
    const vehicles = (await pool.query('SELECT vehicle_id, plate, model, color, status FROM vehicles WHERE owner_customer_id=$1 ORDER BY plate', [id])).rows;
    const warrants = req.mdt.perms.has('mdt.warrants.read')
      ? (await pool.query(`SELECT id, kind, reason, status, created_faction, created_at FROM mdt_warrants WHERE subject_customer_id=$1 ORDER BY (status='AKTYWNY') DESC, created_at DESC LIMIT 20`, [id])).rows : [];
    const reports = (await visibleReports(req, 'r.subject_customer_id=$X', id)).slice(0, 20);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'OSOBA_PODGLAD', objectType: 'person', target: id });
    res.json({ person: p, vehicles, warrants, reports });
  }));

  // ---------- pojazdy ----------
  app.get('/mdt/vehicles', auth, need('mdt.vehicles.read'), wrap(async (req, res) => {
    const q = clip(req.query.q, 40); if (q.length < 2) return res.json([]);
    const plate = normPlate(q);
    const r = await pool.query(
      `SELECT v.vehicle_id, v.plate, v.model, v.color, v.status, v.note, v.owner_customer_id, COALESCE(c.first_name || ' ' || c.last_name, v.owner_text) AS owner,
              (SELECT COUNT(*)::int FROM mdt_warrants w WHERE w.plate = v.plate AND w.status='AKTYWNY') AS warrants
       FROM vehicles v LEFT JOIN customers c ON c.customer_id = v.owner_customer_id
       WHERE v.plate LIKE '%' || $1 || '%' OR lower(v.model) LIKE '%' || lower($2) || '%' ORDER BY v.plate LIMIT 25`, [plate || '~', q]);
    res.json(r.rows);
  }));
  app.post('/mdt/vehicles', auth, need('mdt.vehicles.manage'), wrap(async (req, res) => {
    const plate = normPlate(req.body.plate);
    if (plate.length < 3) return res.status(400).json({ error: 'Podaj tablicę rejestracyjną.' });
    let owner = null;
    if (req.body.owner_customer_id) {
      owner = parseInt(req.body.owner_customer_id, 10);
      if (!(await pool.query('SELECT 1 FROM customers c WHERE c.customer_id=$1 AND ' + REAL, [owner])).rowCount) return res.status(400).json({ error: 'Nie ma takiego właściciela.' });
    }
    try {
      const r = await pool.query(`INSERT INTO vehicles (plate, model, color, owner_customer_id, owner_text, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING vehicle_id`,
        [plate, clip(req.body.model, 60) || null, clip(req.body.color, 30) || null, owner, owner ? null : clip(req.body.owner_text, 80) || null, clip(req.body.note, 300) || null, req.customerId]);
      await audit(null, { faction: req.faction, actor: req.customerId, action: 'POJAZD_DODANY', objectType: 'vehicle', target: plate });
      res.json({ ok: true, vehicle_id: r.rows[0].vehicle_id });
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Pojazd z taką tablicą już jest w rejestrze.' }); throw e; }
  }));
  app.post('/mdt/vehicles/:id/status', auth, need('mdt.vehicles.manage'), wrap(async (req, res) => {
    const st = String(req.body.status || ''); const id = parseInt(req.params.id, 10);
    if (!VEH_STATUS.includes(st)) return res.status(400).json({ error: 'Status: ' + VEH_STATUS.join(', ') });
    const r = await pool.query('UPDATE vehicles SET status=$2, note=COALESCE($3, note), updated_at=now() WHERE vehicle_id=$1 RETURNING plate', [id, st, req.body.note ? clip(req.body.note, 300) : null]);
    if (!r.rowCount) return res.status(404).json({ error: 'Nie znaleziono pojazdu.' });
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'POJAZD_STATUS', objectType: 'vehicle', target: r.rows[0].plate, detail: st });
    res.json({ ok: true });
  }));

  // ---------- poszukiwani / alerty ----------
  app.get('/mdt/warrants', auth, need('mdt.warrants.read'), wrap(async (req, res) => {
    const all = String(req.query.all || '') === '1';
    const r = await pool.query(
      `SELECT w.id, w.kind, w.subject_customer_id, COALESCE(c.first_name || ' ' || c.last_name, w.subject_name) AS subject, w.plate, w.reason, w.status, w.created_faction, w.created_at,
              a.first_name || ' ' || a.last_name AS author
       FROM mdt_warrants w LEFT JOIN customers c ON c.customer_id = w.subject_customer_id LEFT JOIN customers a ON a.customer_id = w.created_by
       WHERE ($1 OR w.status='AKTYWNY') ORDER BY (w.status='AKTYWNY') DESC, w.created_at DESC LIMIT 100`, [all]);
    res.json(r.rows);
  }));
  app.post('/mdt/warrants', auth, need('mdt.warrants.create'), wrap(async (req, res) => {
    const kind = ['POSZUKIWANY', 'NAKAZ', 'ALERT'].includes(req.body.kind) ? req.body.kind : 'POSZUKIWANY';
    const reason = clip(req.body.reason, 500); const plate = normPlate(req.body.plate) || null;
    const subj = req.body.subject_customer_id ? parseInt(req.body.subject_customer_id, 10) : null;
    const name = clip(req.body.subject_name, 80) || null;
    if (reason.length < 3) return res.status(400).json({ error: 'Podaj powód.' });
    if (!subj && !name && !plate) return res.status(400).json({ error: 'Podaj osobę, nazwę albo tablicę.' });
    if (subj && !(await pool.query('SELECT 1 FROM customers c WHERE c.customer_id=$1 AND ' + REAL, [subj])).rowCount) return res.status(400).json({ error: 'Nie ma takiej osoby.' });
    const r = await pool.query(`INSERT INTO mdt_warrants (kind, subject_customer_id, subject_name, plate, reason, created_by, created_faction) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [kind, subj, name, plate, reason, req.customerId, req.faction]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'POSZUKIWANIE_WYSTAWIONE', objectType: 'warrant', target: r.rows[0].id, detail: kind });
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.post('/mdt/warrants/:id/close', auth, need('mdt.warrants.read'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const st = req.body.status === 'ANULOWANY' ? 'ANULOWANY' : 'ZREALIZOWANY';
    const w = (await pool.query('SELECT created_by FROM mdt_warrants WHERE id=$1', [id])).rows[0];
    if (!w) return res.status(404).json({ error: 'Nie znaleziono wpisu.' });
    if (w.created_by !== req.customerId && !req.mdt.perms.has('mdt.warrants.manage')) return res.status(403).json({ error: 'Zamknąć może autor albo osoba z uprawnieniem zarządzania.' });
    const r = await pool.query(`UPDATE mdt_warrants SET status=$2, closed_by=$3, closed_at=now(), close_note=$4 WHERE id=$1 AND status='AKTYWNY' RETURNING 1`, [id, st, req.customerId, clip(req.body.note, 300) || null]);
    if (!r.rowCount) return res.status(409).json({ error: 'Wpis jest już zamknięty.' });
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'POSZUKIWANIE_' + st, objectType: 'warrant', target: id });
    res.json({ ok: true });
  }));

  // ---------- raporty ----------
  // widoczne: własnej frakcji (poufne tylko autor/zarządzający) + udostępnione jawnie mojej frakcji (tylko jawne)
  async function visibleReports(req, cond, arg) {
    const manage = req.mdt.perms.has('mdt.reports.manage');
    const args = [req.faction, req.customerId, manage];
    let where = `((r.faction = $1 AND (r.classification='JAWNA' OR r.author_customer_id=$2 OR $3)) OR ($1 = ANY(r.shared_with) AND r.classification='JAWNA'))`;
    if (cond) { args.push(arg); where += ' AND ' + cond.replace('$X', '$' + args.length); }
    if (!req.mdt.perms.has('mdt.reports.read') && !manage) where += ` AND r.author_customer_id=$2`;
    return (await pool.query(
      `SELECT r.id, r.faction, r.kind, r.title, r.classification, r.status, r.shared_with, r.created_at, r.ticket_id, r.subject_customer_id,
              a.first_name || ' ' || a.last_name AS author, r.author_customer_id
       FROM mdt_reports r LEFT JOIN customers a ON a.customer_id = r.author_customer_id WHERE ${where} ORDER BY r.created_at DESC LIMIT 100`, args)).rows;
  }
  app.get('/mdt/reports', auth, need('mdt.reports.create'), wrap(async (req, res) => {
    res.json(await visibleReports(req, req.query.subject ? 'r.subject_customer_id=$X' : null, parseInt(req.query.subject, 10)));
  }));
  app.get('/mdt/reports/:id', auth, need('mdt.reports.create'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = (await pool.query(`SELECT r.*, a.first_name || ' ' || a.last_name AS author FROM mdt_reports r LEFT JOIN customers a ON a.customer_id=r.author_customer_id WHERE r.id=$1`, [id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Nie znaleziono raportu.' });
    const manage = req.mdt.perms.has('mdt.reports.manage');
    const own = r.faction === req.faction && (r.classification === 'JAWNA' || r.author_customer_id === req.customerId || manage);
    const shared = (r.shared_with || []).includes(req.faction) && r.classification === 'JAWNA';
    // DOJ: raport podpięty do sprawy, do której ma dostęp, też jest czytelny (obsługa w doj.js przez sharing)
    if (!(own || shared)) { await audit(null, { faction: req.faction, actor: req.customerId, action: 'RAPORT_ODMOWA', objectType: 'report', target: id, result: 'DENIED' }); return res.status(404).json({ error: 'Nie znaleziono raportu.' }); }
    const edits = own ? (await pool.query('SELECT e.at, c.first_name || \' \' || c.last_name AS who FROM mdt_report_edits e LEFT JOIN customers c ON c.customer_id=e.editor_customer_id WHERE e.report_id=$1 ORDER BY e.id DESC', [id])).rows : [];
    res.json({ report: r, edits, can_edit: own && (r.author_customer_id === req.customerId || manage) && r.status !== 'ZAMKNIETY' || (own && manage) });
  }));
  app.post('/mdt/reports', auth, need('mdt.reports.create'), wrap(async (req, res) => {
    const title = clip(req.body.title, 120); const body = clip(req.body.body, 6000);
    if (title.length < 3 || body.length < 3) return res.status(400).json({ error: 'Podaj tytuł i treść.' });
    const kind = ['RAPORT', 'NOTATKA', 'ARESZTOWANIE', 'INCYDENT'].includes(req.body.kind) ? req.body.kind : 'RAPORT';
    const cls = req.body.classification === 'POUFNA' ? 'POUFNA' : 'JAWNA';
    const subj = req.body.subject_customer_id ? parseInt(req.body.subject_customer_id, 10) : null;
    const tid = req.body.ticket_id ? parseInt(req.body.ticket_id, 10) : null;
    const r = await pool.query(`INSERT INTO mdt_reports (faction, kind, author_customer_id, subject_customer_id, ticket_id, title, body, classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.faction, kind, req.customerId, subj, tid, title, body, cls]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'RAPORT_UTWORZONY', objectType: 'report', target: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.post('/mdt/reports/:id/edit', auth, need('mdt.reports.create'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = (await client.query('SELECT * FROM mdt_reports WHERE id=$1 AND faction=$2 FOR UPDATE', [id, req.faction])).rows[0];
      if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono raportu.' }); }
      const manage = req.mdt.perms.has('mdt.reports.manage');
      if (!(manage || (r.author_customer_id === req.customerId && r.status !== 'ZAMKNIETY'))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Nie możesz edytować tego raportu.' }); }
      const title = req.body.title !== undefined ? clip(req.body.title, 120) : r.title;
      const body = req.body.body !== undefined ? clip(req.body.body, 6000) : r.body;
      if (title.length < 3 || body.length < 3) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Za krótki tytuł lub treść.' }); }
      let status = r.status;
      if (req.body.status !== undefined) {
        if (!['SZKIC', 'ZLOZONY', 'ZAMKNIETY'].includes(req.body.status)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Zły status.' }); }
        if (req.body.status === 'ZAMKNIETY' && !manage) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Zamknąć raport może kierownictwo.' }); }
        status = req.body.status;
      }
      let cls = r.classification; let shared = r.shared_with;
      if (req.body.classification !== undefined) cls = req.body.classification === 'POUFNA' ? 'POUFNA' : 'JAWNA';
      if (Array.isArray(req.body.shared_with)) {
        if (!manage && r.author_customer_id !== req.customerId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Udostępniać może autor lub kierownictwo.' }); }
        shared = [...new Set(req.body.shared_with.map((x) => String(x).toUpperCase()))].filter((x) => FACTIONS.includes(x) && x !== req.faction);
      }
      await client.query('INSERT INTO mdt_report_edits (report_id, editor_customer_id, old_title, old_body) VALUES ($1,$2,$3,$4)', [id, req.customerId, r.title, r.body]);
      await client.query('UPDATE mdt_reports SET title=$2, body=$3, status=$4, classification=$5, shared_with=$6, updated_at=now() WHERE id=$1', [id, title, body, status, cls, shared]);
      await audit(client, { faction: req.faction, actor: req.customerId, action: 'RAPORT_EDYTOWANY', objectType: 'report', target: id, detail: status });
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
}

module.exports = { migrate, register, normPlate };
