// MDT – DOJ: sprawy (JAWNA/POUFNA), notatki, podpinanie raportów udostępnionych DOJ. Dostęp wyłącznie przez uprawnienia doj.*.
const { clip } = require('./core.js');

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS doj_cases (
    id SERIAL PRIMARY KEY, title TEXT NOT NULL, subject_customer_id INTEGER REFERENCES customers(customer_id), subject_name TEXT,
    status TEXT NOT NULL DEFAULT 'OTWARTA', classification TEXT NOT NULL DEFAULT 'JAWNA', summary TEXT,
    created_by INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS doj_case_notes (
    id SERIAL PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES doj_cases(id), author_customer_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS doj_case_reports (
    case_id INTEGER NOT NULL REFERENCES doj_cases(id), report_id INTEGER NOT NULL REFERENCES mdt_reports(id), attached_by INTEGER NOT NULL, attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (case_id, report_id)
  )`);
}

function register(app, { pool }) {
  const { auth, need, wrap, audit } = app.locals.mdt;
  const label = (id) => `DOJ-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
  const canSee = (req, c) => c.classification === 'JAWNA' || req.mdt.perms.has('doj.cases.classified');

  app.get('/mdt/doj/cases', auth, need('doj.cases.read'), wrap(async (req, res) => {
    const cls = req.mdt.perms.has('doj.cases.classified');
    const r = await pool.query(
      `SELECT d.id, d.title, d.status, d.classification, d.created_at, d.updated_at, COALESCE(c.first_name || ' ' || c.last_name, d.subject_name) AS subject,
              (SELECT COUNT(*)::int FROM doj_case_reports x WHERE x.case_id=d.id) AS reports
       FROM doj_cases d LEFT JOIN customers c ON c.customer_id=d.subject_customer_id WHERE ($1 OR d.classification='JAWNA') ORDER BY d.updated_at DESC LIMIT 100`, [cls]);
    res.json(r.rows.map((x) => ({ ...x, number: label(x.id) })));
  }));
  app.get('/mdt/doj/cases/:id', auth, need('doj.cases.read'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = (await pool.query(`SELECT d.*, COALESCE(p.first_name || ' ' || p.last_name, d.subject_name) AS subject FROM doj_cases d LEFT JOIN customers p ON p.customer_id=d.subject_customer_id WHERE d.id=$1`, [id])).rows[0];
    if (!c || !canSee(req, c)) {
      if (c) await audit(null, { faction: req.faction, actor: req.customerId, action: 'SPRAWA_ODMOWA', objectType: 'doj_case', target: id, result: 'DENIED' });
      return res.status(404).json({ error: 'Nie znaleziono sprawy.' });
    }
    const notes = (await pool.query(`SELECT n.id, n.body, n.created_at, a.first_name || ' ' || a.last_name AS author FROM doj_case_notes n LEFT JOIN customers a ON a.customer_id=n.author_customer_id WHERE n.case_id=$1 ORDER BY n.id`, [id])).rows;
    // raporty podpięte: tylko jawne albo udostępnione DOJ
    const reports = (await pool.query(`SELECT r.id, r.title, r.faction, r.kind, r.created_at FROM doj_case_reports x JOIN mdt_reports r ON r.id=x.report_id WHERE x.case_id=$1 ORDER BY x.attached_at`, [id])).rows;
    res.json({ case: { ...c, number: label(c.id) }, notes, reports, can_manage: req.mdt.perms.has('doj.cases.manage') });
  }));
  app.post('/mdt/doj/cases', auth, need('doj.cases.manage'), wrap(async (req, res) => {
    const title = clip(req.body.title, 160);
    if (title.length < 3) return res.status(400).json({ error: 'Podaj tytuł sprawy.' });
    let cls = req.body.classification === 'POUFNA' ? 'POUFNA' : 'JAWNA';
    if (cls === 'POUFNA' && !req.mdt.perms.has('doj.cases.classified')) return res.status(403).json({ error: 'Brak uprawnienia do spraw poufnych.' });
    const subj = req.body.subject_customer_id ? parseInt(req.body.subject_customer_id, 10) : null;
    const r = await pool.query(`INSERT INTO doj_cases (title, subject_customer_id, subject_name, classification, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [title, subj, clip(req.body.subject_name, 80) || null, cls, clip(req.body.summary, 2000) || null, req.customerId]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'SPRAWA_UTWORZONA', objectType: 'doj_case', target: r.rows[0].id, detail: cls });
    res.json({ ok: true, id: r.rows[0].id, number: label(r.rows[0].id) });
  }));
  app.post('/mdt/doj/cases/:id/status', auth, need('doj.cases.manage'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); const st = String(req.body.status || '');
    if (!['OTWARTA', 'W_TOKU', 'ZAMKNIETA'].includes(st)) return res.status(400).json({ error: 'Zły status.' });
    const c = (await pool.query('SELECT classification FROM doj_cases WHERE id=$1', [id])).rows[0];
    if (!c || !canSee(req, c)) return res.status(404).json({ error: 'Nie znaleziono sprawy.' });
    await pool.query(`UPDATE doj_cases SET status=$2, updated_at=now(), closed_at=CASE WHEN $2='ZAMKNIETA' THEN now() END WHERE id=$1`, [id, st]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'SPRAWA_STATUS', objectType: 'doj_case', target: id, detail: st });
    res.json({ ok: true });
  }));
  app.post('/mdt/doj/cases/:id/notes', auth, need('doj.cases.manage'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); const body = clip(req.body.body, 3000);
    if (body.length < 2) return res.status(400).json({ error: 'Pusta notatka.' });
    const c = (await pool.query('SELECT classification FROM doj_cases WHERE id=$1', [id])).rows[0];
    if (!c || !canSee(req, c)) return res.status(404).json({ error: 'Nie znaleziono sprawy.' });
    await pool.query('INSERT INTO doj_case_notes (case_id, author_customer_id, body) VALUES ($1,$2,$3)', [id, req.customerId, body]);
    await pool.query('UPDATE doj_cases SET updated_at=now() WHERE id=$1', [id]);
    res.json({ ok: true });
  }));
  // podpięcie raportu: tylko taki, który DOJ może czytać (własny DOJ albo jawny i udostępniony DOJ-owi)
  app.post('/mdt/doj/cases/:id/reports', auth, need('doj.cases.manage'), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); const rid = parseInt(req.body.report_id, 10);
    const c = (await pool.query('SELECT classification FROM doj_cases WHERE id=$1', [id])).rows[0];
    if (!c || !canSee(req, c)) return res.status(404).json({ error: 'Nie znaleziono sprawy.' });
    const r = (await pool.query('SELECT faction, classification, shared_with FROM mdt_reports WHERE id=$1', [rid])).rows[0];
    const ok = r && ((r.faction === 'DOJ') || (r.classification === 'JAWNA' && (r.shared_with || []).includes('DOJ')));
    if (!ok) return res.status(403).json({ error: 'Ten raport nie został udostępniony DOJ (autor musi go udostępnić).' });
    await pool.query('INSERT INTO doj_case_reports (case_id, report_id, attached_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, rid, req.customerId]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'SPRAWA_RAPORT_PODPIETY', objectType: 'doj_case', target: id, detail: 'raport ' + rid });
    res.json({ ok: true });
  }));
}
module.exports = { migrate, register };
