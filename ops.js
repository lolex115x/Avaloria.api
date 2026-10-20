// Panele operacyjne EMS / DOT: służba, zgłoszenia/zlecenia (dispatch), holowanie, kartoteka medyczna (EMS),
// zarządzanie rangami i dziennik zmian. Używa istniejących tabel: customers, faction_members, invoices.
// Wszystkie uprawnienia sprawdzane po stronie serwera; klient niczego nie "ustawia" sam (kwoty, role, statusy).

const OPS_FACTIONS = ['EMS', 'DOT', 'LAPD', 'LAFD'];
const RANKS = ['PRACOWNIK', 'ZASTEPCA', 'SZEF'];
const rankIdx = (r) => RANKS.indexOf(r);

const TICKET_KINDS = {
  EMS: ['Wypadek', 'Zasłabnięcie', 'Postrzał/rana', 'Transport', 'Inne'],
  DOT: ['Holowanie', 'Awaria pojazdu', 'Wypadek drogowy', 'Naprawa drogi', 'Inne'],
  LAPD: ['Napad', 'Pościg', 'Kolizja', 'Zakłócanie porządku', 'Inne'],
  LAFD: ['Pożar', 'Wypadek', 'Ratownictwo techniczne', 'Inne'],
};
const OPEN_STATUSES = ['NOWE', 'PRZYJETE', 'PRZYDZIELONE', 'W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE'];

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_duty (
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    faction TEXT NOT NULL,
    since TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, faction)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_duty_log (
    id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL, faction TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
    ticket_id SERIAL PRIMARY KEY,
    faction TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'NOWE',        -- NOWE | PRZYJETE | W_TRAKCIE | ZAKONCZONE | ANULOWANE
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    caller_customer_id INTEGER REFERENCES customers(customer_id),  -- zgłaszający (obywatel), jeśli z telefonu
    created_by INTEGER REFERENCES customers(customer_id),          -- pracownik, który wpisał zgłoszenie
    assigned_to INTEGER REFERENCES customers(customer_id),
    plate TEXT,                                  -- DOT: tablica rejestracyjna pojazdu (tekst wpisany przez pracownika)
    vehicle_note TEXT,
    tow_destination TEXT,
    actions_done TEXT,
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tickets_faction_idx ON tickets (faction, status, created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_log (
    id SERIAL PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id),
    actor_customer_id INTEGER, action TEXT NOT NULL, note TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS medical_records (
    record_id SERIAL PRIMARY KEY,
    patient_customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    ticket_id INTEGER REFERENCES tickets(ticket_id),
    author_customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS medrec_patient_idx ON medical_records (patient_customer_id, created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_audit (
    id SERIAL PRIMARY KEY, faction TEXT NOT NULL, actor_customer_id INTEGER,
    action TEXT NOT NULL, target TEXT, detail TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS faction_audit_idx ON faction_audit (faction, at DESC)`);
  // Przygotowanie pod przyszłe taryfikatory: faktura może wskazywać źródło kwoty i zgłoszenie. Niczego nie wypełniamy.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ticket_id INTEGER`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source TEXT`);      // np. 'manual' (dziś), 'tariff' (później)
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_ref TEXT`);  // id pozycji taryfikatora (później)
}

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function register(app, { pool, requireCustomerAuth }) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Błąd serwera.' }); });

  const audit = (faction, actor, action, target, detail) =>
    pool.query('INSERT INTO faction_audit (faction, actor_customer_id, action, target, detail) VALUES ($1,$2,$3,$4,$5)',
      [faction, actor, action, target == null ? null : String(target), detail ? clip(detail, 500) : null]).catch((e) => console.error('audit:', e.message));
  const tlog = (ticketId, actor, action, note) =>
    pool.query('INSERT INTO ticket_log (ticket_id, actor_customer_id, action, note) VALUES ($1,$2,$3,$4)', [ticketId, actor, action, note ? clip(note, 500) : null]);

  // członek EMS/DOT z min. rangą; ustawia req.faction, req.rank
  const member = (minRank = 'PRACOWNIK') => async (req, res, next) => {
    try {
      const f = String(req.params.faction || '').toUpperCase();
      if (!OPS_FACTIONS.includes(f)) return res.status(404).json({ error: 'Ta frakcja nie ma panelu.' });
      const m = (await pool.query('SELECT rank FROM faction_members WHERE customer_id = $1 AND faction = $2 AND NOT suspended', [req.customerId, f])).rows[0];
      if (!m) return res.status(403).json({ error: 'Nie należysz do tej frakcji.' });
      if (rankIdx(m.rank) < rankIdx(minRank)) return res.status(403).json({ error: 'Za niska ranga do tej akcji.' });
      req.faction = f; req.rank = m.rank;
      next();
    } catch (e) { next(e); }
  };
  const base = '/customer/factions/:faction/ops';

  // ---------- panel główny ----------
  app.get(`${base}/dashboard`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const f = req.faction;
    const duty = (await pool.query(
      `SELECT c.customer_id, c.first_name, c.last_name, m.rank, d.since
       FROM faction_duty d JOIN customers c ON c.customer_id = d.customer_id
       JOIN faction_members m ON m.customer_id = d.customer_id AND m.faction = d.faction
       WHERE d.faction = $1 AND c.phone_on = true ORDER BY d.since`, [f])).rows;
    const counts = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='NOWE')::int AS nowe,
              COUNT(*) FILTER (WHERE status='PRZYJETE')::int AS przyjete,
              COUNT(*) FILTER (WHERE status='W_TRAKCIE')::int AS w_trakcie,
              COUNT(*) FILTER (WHERE status='ZAKONCZONE' AND closed_at > now() - interval '24 hours')::int AS zakonczone_24h
       FROM tickets WHERE faction=$1`, [f])).rows[0];
    const active = (await pool.query(
      `SELECT t.ticket_id, t.kind, t.status, t.location, t.created_at, a.first_name AS a_first, a.last_name AS a_last
       FROM tickets t LEFT JOIN customers a ON a.customer_id = t.assigned_to
       WHERE t.faction=$1 AND t.status = ANY($2) ORDER BY t.created_at DESC LIMIT 5`, [f, OPEN_STATUSES])).rows;
    const myDuty = duty.some((d) => d.customer_id === req.customerId);
    const recent = (await pool.query(
      `SELECT a.action, a.target, a.detail, a.at, c.first_name, c.last_name
       FROM faction_audit a LEFT JOIN customers c ON c.customer_id = a.actor_customer_id
       WHERE a.faction=$1 ORDER BY a.at DESC LIMIT 6`, [f])).rows;
    res.json({ faction: f, rank: req.rank, me: req.customerId, on_duty: myDuty, duty, counts, active, recent, kinds: TICKET_KINDS[f] });
  }));

  // ---------- służba (idempotentna) ----------
  app.post(`${base}/duty`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const on = !!req.body.on;
    const f = req.faction;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (on) {
        const ph = (await client.query('SELECT phone_on FROM customers WHERE customer_id=$1', [req.customerId])).rows[0];
        if (!ph || !ph.phone_on) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Włącz telefon, żeby wejść na służbę.' }); }
        const ins = await client.query('INSERT INTO faction_duty (customer_id, faction) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [req.customerId, f]);
        if (ins.rowCount) await client.query(`INSERT INTO faction_audit (faction, actor_customer_id, action) VALUES ($1,$2,'DUTY_ON')`, [f, req.customerId]);
      } else {
        const del = await client.query('DELETE FROM faction_duty WHERE customer_id=$1 AND faction=$2 RETURNING since', [req.customerId, f]);
        if (del.rowCount) {
          await client.query('INSERT INTO faction_duty_log (customer_id, faction, started_at) VALUES ($1,$2,$3)', [req.customerId, f, del.rows[0].since]);
          await client.query(`INSERT INTO faction_audit (faction, actor_customer_id, action) VALUES ($1,$2,'DUTY_OFF')`, [f, req.customerId]);
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true, on_duty: on });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // ---------- zgłoszenia / zlecenia ----------
  app.get(`${base}/tickets`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const where = ['t.faction = $1']; const args = [req.faction];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
    if (req.query.status === 'open') where.push(`t.status = ANY('{NOWE,PRZYJETE,PRZYDZIELONE,W_DRODZE,NA_MIEJSCU,W_TRAKCIE}')`);
    else if (['NOWE', 'PRZYJETE', 'PRZYDZIELONE', 'W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'].includes(req.query.status)) add('t.status = ?', req.query.status);
    if (req.query.mine === '1') add('t.assigned_to = ?', req.customerId);
    if (req.query.kind) add('t.kind = ?', clip(req.query.kind, 40));
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) add('t.created_at >= ?', req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) add(`t.created_at < (?::date + 1)`, req.query.to);
    const r = await pool.query(
      `SELECT t.ticket_id, t.kind, t.status, t.location, t.description, t.plate, t.created_at, t.closed_at, t.assigned_to,
              a.first_name AS a_first, a.last_name AS a_last
       FROM tickets t LEFT JOIN customers a ON a.customer_id = t.assigned_to
       WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 60`, args);
    res.json(r.rows);
  }));

  app.post(`${base}/tickets`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const kind = clip(req.body.kind, 40);
    const location = clip(req.body.location, 120);
    const description = clip(req.body.description, 500);
    if (!TICKET_KINDS[req.faction].includes(kind)) return res.status(400).json({ error: 'Wybierz rodzaj zgłoszenia.' });
    if (location.length < 2) return res.status(400).json({ error: 'Podaj miejsce zdarzenia.' });
    if (description.length < 2) return res.status(400).json({ error: 'Opisz zgłoszenie.' });
    const plate = req.faction === 'DOT' ? clip(req.body.plate, 16).toUpperCase() || null : null;
    const t = (await pool.query(
      `INSERT INTO tickets (faction, kind, location, description, created_by, plate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.faction, kind, location, description, req.customerId, plate])).rows[0];
    await tlog(t.ticket_id, req.customerId, 'UTWORZONO', `${kind} — ${location}`);
    res.json({ ok: true, ticket: t });
  }));

  app.get(`${base}/tickets/:id`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const t = (await pool.query(
      `SELECT t.*, a.first_name AS a_first, a.last_name AS a_last, cr.first_name AS cr_first, cr.last_name AS cr_last, cl.first_name AS cl_first, cl.last_name AS cl_last, cl.phone_number AS cl_phone
       FROM tickets t LEFT JOIN customers a ON a.customer_id = t.assigned_to
       LEFT JOIN customers cr ON cr.customer_id = t.created_by LEFT JOIN customers cl ON cl.customer_id = t.caller_customer_id
       WHERE t.ticket_id=$1 AND t.faction=$2`, [req.params.id, req.faction])).rows[0];
    if (!t) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    const log = (await pool.query(
      `SELECT l.action, l.note, l.at, c.first_name, c.last_name FROM ticket_log l LEFT JOIN customers c ON c.customer_id = l.actor_customer_id
       WHERE l.ticket_id=$1 ORDER BY l.at, l.id`, [t.ticket_id])).rows;
    res.json({ ticket: t, log });
  }));

  // przejście statusów – każde przez UPDATE z warunkiem na aktualny status (bez wyścigów)
  app.post(`${base}/tickets/:id/action`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const action = String(req.body.action || '');
    const note = clip(req.body.note, 500);
    const t = (await pool.query('SELECT * FROM tickets WHERE ticket_id=$1 AND faction=$2', [id, req.faction])).rows[0];
    if (!t) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    const isLead = rankIdx(req.rank) >= rankIdx('ZASTEPCA');
    const mineOrLead = t.assigned_to === req.customerId || isLead;
    let r;
    if (action === 'take') {
      r = await pool.query(`UPDATE tickets SET status='PRZYJETE', assigned_to=$2, updated_at=now() WHERE ticket_id=$1 AND status='NOWE' AND assigned_to IS NULL RETURNING 1`, [id, req.customerId]);
      if (!r.rowCount) return res.status(409).json({ error: 'Ktoś już przejął to zgłoszenie.' });
      await tlog(id, req.customerId, 'PRZYJETO', note);
    } else if (action === 'assign') {
      if (!isLead) return res.status(403).json({ error: 'Przypisywać może zastępca lub szef.' });
      const to = parseInt(req.body.assignee_id, 10);
      const ok = (await pool.query('SELECT 1 FROM faction_members WHERE customer_id=$1 AND faction=$2', [to, req.faction])).rowCount;
      if (!ok) return res.status(400).json({ error: 'Ta osoba nie jest w tej frakcji.' });
      r = await pool.query(`UPDATE tickets SET assigned_to=$2, status=CASE WHEN status='NOWE' THEN 'PRZYJETE' ELSE status END, updated_at=now() WHERE ticket_id=$1 AND status = ANY('{NOWE,PRZYJETE,PRZYDZIELONE,W_DRODZE,NA_MIEJSCU,W_TRAKCIE}') RETURNING 1`, [id, to]);
      if (!r.rowCount) return res.status(409).json({ error: 'To zgłoszenie jest już zamknięte.' });
      await tlog(id, req.customerId, 'PRZYPISANO', 'user ' + to);
    } else if (action === 'start') {
      if (!mineOrLead) return res.status(403).json({ error: 'To zgłoszenie obsługuje ktoś inny.' });
      r = await pool.query(`UPDATE tickets SET status='W_TRAKCIE', updated_at=now() WHERE ticket_id=$1 AND status='PRZYJETE' RETURNING 1`, [id]);
      if (!r.rowCount) return res.status(409).json({ error: 'Najpierw trzeba przyjąć zgłoszenie.' });
      await tlog(id, req.customerId, 'W_TRAKCIE', note);
    } else if (action === 'close') {
      if (!mineOrLead) return res.status(403).json({ error: 'Zamknąć może osoba przypisana albo zastępca/szef.' });
      const result = clip(req.body.result, 500);
      if (result.length < 2) return res.status(400).json({ error: 'Wpisz wynik zgłoszenia.' });
      r = await pool.query(`UPDATE tickets SET status='ZAKONCZONE', result=$2, closed_at=now(), updated_at=now(), assigned_to=COALESCE(assigned_to,$3)
                            WHERE ticket_id=$1 AND status = ANY('{PRZYJETE,W_TRAKCIE}') RETURNING 1`, [id, result, req.customerId]);
      if (!r.rowCount) return res.status(409).json({ error: 'Zgłoszenie trzeba najpierw przyjąć (albo jest już zamknięte).' });
      await tlog(id, req.customerId, 'ZAKONCZONO', result);
    } else if (action === 'cancel') {
      if (!(isLead || t.created_by === req.customerId)) return res.status(403).json({ error: 'Anulować może autor zgłoszenia, zastępca lub szef.' });
      r = await pool.query(`UPDATE tickets SET status='ANULOWANE', closed_at=now(), updated_at=now() WHERE ticket_id=$1 AND status = ANY('{NOWE,PRZYJETE,PRZYDZIELONE,W_DRODZE,NA_MIEJSCU,W_TRAKCIE}') RETURNING 1`, [id]);
      if (!r.rowCount) return res.status(409).json({ error: 'To zgłoszenie jest już zamknięte.' });
      await tlog(id, req.customerId, 'ANULOWANO', note);
    } else return res.status(400).json({ error: 'Nieznana akcja.' });
    res.json({ ok: true });
  }));

  // uzupełnienie szczegółów (holowanie: pojazd, miejsce odholowania, czynności) – tylko osoba przypisana lub kierownictwo, tylko dla otwartych
  app.post(`${base}/tickets/:id/details`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = (await pool.query('SELECT * FROM tickets WHERE ticket_id=$1 AND faction=$2', [id, req.faction])).rows[0];
    if (!t) return res.status(404).json({ error: 'Nie znaleziono zgłoszenia.' });
    if (!OPEN_STATUSES.includes(t.status)) return res.status(409).json({ error: 'Zamkniętego zgłoszenia nie edytujemy.' });
    if (t.assigned_to !== req.customerId && rankIdx(req.rank) < rankIdx('ZASTEPCA')) return res.status(403).json({ error: 'Edytować może osoba przypisana albo zastępca/szef.' });
    const sets = []; const args = [id]; const changed = [];
    const put = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); changed.push(col); };
    if (req.body.actions_done !== undefined) put('actions_done', clip(req.body.actions_done, 500) || null);
    if (req.faction === 'DOT') {
      if (req.body.plate !== undefined) put('plate', clip(req.body.plate, 16).toUpperCase() || null);
      if (req.body.vehicle_note !== undefined) put('vehicle_note', clip(req.body.vehicle_note, 200) || null);
      if (req.body.tow_destination !== undefined) put('tow_destination', clip(req.body.tow_destination, 120) || null);
    }
    if (!sets.length) return res.status(400).json({ error: 'Brak zmian.' });
    await pool.query(`UPDATE tickets SET ${sets.join(', ')}, updated_at=now() WHERE ticket_id=$1`, args);
    await tlog(id, req.customerId, 'AKTUALIZACJA', changed.join(', '));
    res.json({ ok: true });
  }));

  // ---------- zgłoszenie od obywatela (z telefonu, bez bycia we frakcji) ----------
  app.post('/customer/dispatch/request', requireCustomerAuth, wrap(async (req, res) => {
    const f = String(req.body.faction || '').toUpperCase();
    if (!['EMS', 'DOT'].includes(f)) return res.status(400).json({ error: 'Zgłoszenia obywateli: EMS albo DOT (policja i straż: numer 911).' });
    const location = clip(req.body.location, 120);
    const description = clip(req.body.description, 500);
    if (location.length < 2 || description.length < 2) return res.status(400).json({ error: 'Podaj miejsce i opis.' });
    const open = (await pool.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE faction=$1 AND caller_customer_id=$2 AND status = ANY('{NOWE,PRZYJETE,PRZYDZIELONE,W_DRODZE,NA_MIEJSCU,W_TRAKCIE}')`, [f, req.customerId])).rows[0].n;
    if (open >= 2) return res.status(429).json({ error: 'Masz już otwarte zgłoszenia do tej służby.' });
    const t = (await pool.query(
      `INSERT INTO tickets (faction, kind, location, description, caller_customer_id) VALUES ($1,'Inne',$2,$3,$4) RETURNING ticket_id`,
      [f, location, description, req.customerId])).rows[0];
    await tlog(t.ticket_id, req.customerId, 'ZGLOSZENIE_OBYWATELA', null);
    res.json({ ok: true, ticket_id: t.ticket_id });
  }));

  // ---------- kartoteka medyczna (tylko EMS) ----------
  const emsOnly = (req, res, next) => (req.faction === 'EMS' ? next() : res.status(404).json({ error: 'Kartoteka medyczna jest tylko w EMS.' }));
  const findPatient = async (phone) => (await pool.query(
    `SELECT customer_id, first_name, last_name, phone_number FROM customers WHERE phone_number=$1 AND username NOT LIKE 'svc\\_%' AND username <> 'npc' LIMIT 1`, [clip(phone, 20)])).rows[0];

  app.get(`${base}/records`, requireCustomerAuth, member(), emsOnly, wrap(async (req, res) => {
    const p = await findPatient(req.query.phone);
    if (!p) return res.status(404).json({ error: 'Nie znaleziono pacjenta o tym numerze.' });
    const rows = (await pool.query(
      `SELECT r.record_id, r.content, r.ticket_id, r.created_at, r.updated_at, r.author_customer_id, c.first_name, c.last_name
       FROM medical_records r JOIN customers c ON c.customer_id = r.author_customer_id
       WHERE r.patient_customer_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [p.customer_id])).rows;
    await audit('EMS', req.customerId, 'KARTOTEKA_ODCZYT', p.customer_id, null);
    res.json({ patient: p, records: rows });
  }));

  app.post(`${base}/records`, requireCustomerAuth, member(), emsOnly, wrap(async (req, res) => {
    const p = await findPatient(req.body.phone);
    if (!p) return res.status(404).json({ error: 'Nie znaleziono pacjenta o tym numerze.' });
    const content = clip(req.body.content, 1500);
    if (content.length < 3) return res.status(400).json({ error: 'Wpisz treść dokumentacji.' });
    let ticketId = null;
    if (req.body.ticket_id) {
      ticketId = parseInt(req.body.ticket_id, 10);
      const ok = (await pool.query(`SELECT 1 FROM tickets WHERE ticket_id=$1 AND faction='EMS'`, [ticketId])).rowCount;
      if (!ok) return res.status(400).json({ error: 'Nie ma takiego zgłoszenia EMS.' });
    }
    const r = (await pool.query(
      `INSERT INTO medical_records (patient_customer_id, ticket_id, author_customer_id, content) VALUES ($1,$2,$3,$4) RETURNING record_id`,
      [p.customer_id, ticketId, req.customerId, content])).rows[0];
    await audit('EMS', req.customerId, 'KARTOTEKA_DODANO', p.customer_id, 'wpis #' + r.record_id);
    res.json({ ok: true, record_id: r.record_id });
  }));

  // edycja: autor lub zastępca+; poprzednia treść trafia do dziennika (ślad zmian)
  app.post(`${base}/records/:rid/edit`, requireCustomerAuth, member(), emsOnly, wrap(async (req, res) => {
    const content = clip(req.body.content, 1500);
    if (content.length < 3) return res.status(400).json({ error: 'Wpisz treść dokumentacji.' });
    const old = (await pool.query('SELECT * FROM medical_records WHERE record_id=$1', [req.params.rid])).rows[0];
    if (!old) return res.status(404).json({ error: 'Nie znaleziono wpisu.' });
    if (old.author_customer_id !== req.customerId && rankIdx(req.rank) < rankIdx('ZASTEPCA')) return res.status(403).json({ error: 'Edytować może autor albo zastępca/szef.' });
    await pool.query('UPDATE medical_records SET content=$2, updated_at=now() WHERE record_id=$1', [old.record_id, content]);
    await audit('EMS', req.customerId, 'KARTOTEKA_EDYCJA', old.patient_customer_id, `wpis #${old.record_id}, poprzednio: ${old.content}`);
    res.json({ ok: true });
  }));

  // ---------- ludzie i rangi ----------
  app.get(`${base}/people`, requireCustomerAuth, member(), wrap(async (req, res) => {
    const lead = rankIdx(req.rank) >= rankIdx('ZASTEPCA');
    const r = await pool.query(
      `SELECT c.customer_id, c.first_name, c.last_name, ${lead ? 'c.phone_number,' : ''} m.rank,
              (d.customer_id IS NOT NULL AND c.phone_on) AS on_duty, d.since,
              COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (l.ended_at - l.started_at)))::bigint FROM faction_duty_log l
                        WHERE l.customer_id = c.customer_id AND l.faction = m.faction AND l.ended_at > now() - interval '7 days'), 0) AS duty_sec_7d
       FROM faction_members m JOIN customers c ON c.customer_id = m.customer_id
       LEFT JOIN faction_duty d ON d.customer_id = m.customer_id AND d.faction = m.faction
       WHERE m.faction=$1 ORDER BY CASE m.rank WHEN 'SZEF' THEN 0 WHEN 'ZASTEPCA' THEN 1 ELSE 2 END, c.last_name`, [req.faction]);
    res.json({ people: r.rows, me: req.customerId });
  }));

  // Szef może awansować/degradować tylko osoby poniżej swojej rangi, do rangi niższej niż własna; siebie nie ruszy.
  app.post(`${base}/people/:cid/rank`, requireCustomerAuth, member('SZEF'), wrap(async (req, res) => {
    const target = parseInt(req.params.cid, 10);
    const rank = String(req.body.rank || '');
    if (!['PRACOWNIK', 'ZASTEPCA'].includes(rank)) return res.status(400).json({ error: 'Szef może nadać: Pracownik albo Zastępca.' });
    if (target === req.customerId) return res.status(403).json({ error: 'Nie zmienisz własnej rangi.' });
    const m = (await pool.query('SELECT rank FROM faction_members WHERE customer_id=$1 AND faction=$2', [target, req.faction])).rows[0];
    if (!m) return res.status(404).json({ error: 'Ta osoba nie jest w tej frakcji.' });
    if (m.rank === 'SZEF') return res.status(403).json({ error: 'Rangi szefa nie zmienisz z telefonu.' });
    if (m.rank === rank) return res.json({ ok: true, unchanged: true });
    await pool.query('UPDATE faction_members SET rank=$3 WHERE customer_id=$1 AND faction=$2', [target, req.faction, rank]);
    await audit(req.faction, req.customerId, 'ZMIANA_RANGI', target, `${m.rank} → ${rank}`);
    res.json({ ok: true });
  }));

  // ---------- dziennik zmian (zastępca+) ----------
  app.get(`${base}/audit`, requireCustomerAuth, member('ZASTEPCA'), wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT a.action, a.target, a.detail, a.at, c.first_name, c.last_name FROM faction_audit a
       LEFT JOIN customers c ON c.customer_id = a.actor_customer_id WHERE a.faction=$1 ORDER BY a.at DESC LIMIT 60`, [req.faction]);
    res.json(r.rows);
  }));
}

module.exports = { migrate, register };
