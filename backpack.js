// Plecak w RP: gracz udostępnia plecak do przeszukania (/plecak daj), PD przeszukuje, konfiskuje i oddaje,
// a administracja może zajrzeć do plecaka w każdej chwili. Cały ruch przedmiotów odbywa się po stronie serwera
// (tabela inventory), a każde działanie zostawia ślad w backpack_log (gracz widzi swoją historię w telefonie).

const MINUTES = Math.max(1, Math.min(120, parseInt(process.env.BACKPACK_SEARCH_MINUTES || '15', 10) || 15));
const normS = (v) => String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS backpack_access (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(customer_id),
    opened_by TEXT,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS backpack_log (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    action TEXT NOT NULL,
    actor TEXT,
    item_name TEXT,
    qty INTEGER,
    visible BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS backpack_log_cust_idx ON backpack_log (customer_id, id DESC)');
}

function register(app, { pool, requireCustomerAuth, requireInternalKey }) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Błąd serwera.' }); });

  const SQL_SSN = `upper(replace(replace(ssn_rp,' ',''),'-',''))`;
  const bySsn = async (db, ssn) => (await db.query(
    `SELECT customer_id, first_name, last_name, phone_number, discord_user_id FROM customers
     WHERE ${SQL_SSN} = $1 AND username NOT LIKE 'svc\\_%' AND username NOT LIKE 'npc\\_%' LIMIT 1`, [normS(ssn)])).rows[0];
  const ownedBySsn = async (db, discordId, ssn) => (await db.query(
    `SELECT customer_id, first_name, last_name FROM customers
     WHERE discord_user_id = $1 AND ${SQL_SSN} = $2 AND username NOT LIKE 'svc\\_%' LIMIT 1`, [String(discordId), normS(ssn)])).rows[0];
  const items = async (db, id) => (await db.query('SELECT item_id, item_name, category, qty FROM inventory WHERE customer_id = $1 AND qty > 0 ORDER BY category, item_name', [id])).rows;
  const openAccess = async (db, id) => (await db.query('SELECT opened_by, expires_at FROM backpack_access WHERE customer_id = $1 AND expires_at > now()', [id])).rows[0];
  const log = (db, id, action, actor, name, qty, visible = true) =>
    db.query('INSERT INTO backpack_log (customer_id, action, actor, item_name, qty, visible) VALUES ($1,$2,$3,$4,$5,$6)', [id, action, clip(actor, 80) || null, name ? clip(name, 120) : null, qty == null ? null : qty, visible]);

  const NO_ACCESS = 'Ten gracz nie udostępnił plecaka (musi użyć /plecak daj) albo czas przeszukania minął.';

  // --- gracz udostępnia plecak do przeszukania ---
  app.post('/internal/backpack/give', requireInternalKey, wrap(async (req, res) => {
    const { discord_user_id, ssn, actor } = req.body;
    if (!discord_user_id || !ssn) return res.status(400).json({ error: 'Wymagane: discord_user_id, ssn.' });
    const c = await ownedBySsn(pool, discord_user_id, ssn);
    if (!c) return res.status(404).json({ error: 'Nie ma twojej postaci z takim SSN.' });
    const exp = (await pool.query(
      `INSERT INTO backpack_access (customer_id, opened_by, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)
       ON CONFLICT (customer_id) DO UPDATE SET opened_by = EXCLUDED.opened_by, expires_at = EXCLUDED.expires_at RETURNING expires_at`,
      [c.customer_id, clip(actor, 80) || null, String(MINUTES)])).rows[0].expires_at;
    await log(pool, c.customer_id, 'UDOSTEPNIONY', actor, null, null);
    res.json({ ok: true, character: `${c.first_name} ${c.last_name}`, minutes: MINUTES, expires_at: exp });
  }));

  // --- PD: przeszukanie (tylko gdy plecak jest udostępniony) ---
  app.post('/internal/backpack/search', requireInternalKey, wrap(async (req, res) => {
    const c = await bySsn(pool, req.body.ssn);
    if (!c) return res.status(404).json({ error: 'Nie ma postaci z takim SSN.' });
    const acc = await openAccess(pool, c.customer_id);
    if (!acc) return res.status(409).json({ error: NO_ACCESS });
    await log(pool, c.customer_id, 'PRZESZUKANIE', req.body.actor, null, null);
    res.json({ character: `${c.first_name} ${c.last_name}`, expires_at: acc.expires_at, items: await items(pool, c.customer_id) });
  }));

  // --- PD: konfiskata przedmiotu (qty 0 = całość danej pozycji) ---
  app.post('/internal/backpack/seize', requireInternalKey, wrap(async (req, res) => {
    const q = clip(req.body.item, 100).trim();
    let qty = parseInt(req.body.qty, 10);
    if (!q) return res.status(400).json({ error: 'Podaj przedmiot (id albo nazwę z /plecak przeszukaj).' });
    if (!Number.isInteger(qty) || qty < 0) qty = 1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = await bySsn(client, req.body.ssn);
      if (!c) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie ma postaci z takim SSN.' }); }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['backpack:' + c.customer_id]);
      if (!(await openAccess(client, c.customer_id))) { await client.query('ROLLBACK'); return res.status(409).json({ error: NO_ACCESS }); }
      const all = (await client.query('SELECT item_id, item_name, qty FROM inventory WHERE customer_id = $1 AND qty > 0 FOR UPDATE', [c.customer_id])).rows;
      const low = q.toLowerCase();
      let hit = all.filter((x) => x.item_id.toLowerCase() === low || x.item_name.toLowerCase() === low);
      if (!hit.length) hit = all.filter((x) => x.item_name.toLowerCase().includes(low));
      if (!hit.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'W plecaku nie ma takiego przedmiotu.' }); }
      if (hit.length > 1) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Pasuje kilka przedmiotów: ${hit.map((x) => x.item_name).join(', ')}. Podaj dokładniejszą nazwę.` }); }
      const it = hit[0];
      const take = qty === 0 ? it.qty : Math.min(qty, it.qty);
      await client.query('UPDATE inventory SET qty = qty - $3 WHERE customer_id = $1 AND item_id = $2', [c.customer_id, it.item_id, take]);
      await log(client, c.customer_id, 'KONFISKATA', req.body.actor, it.item_name, take);
      await client.query('COMMIT');
      res.json({ ok: true, character: `${c.first_name} ${c.last_name}`, item: it.item_name, qty: take, left: it.qty - take });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // --- PD: oddanie plecaka (kończy przeszukanie) ---
  app.post('/internal/backpack/return', requireInternalKey, wrap(async (req, res) => {
    const c = await bySsn(pool, req.body.ssn);
    if (!c) return res.status(404).json({ error: 'Nie ma postaci z takim SSN.' });
    const d = await pool.query('DELETE FROM backpack_access WHERE customer_id = $1', [c.customer_id]);
    if (d.rowCount) await log(pool, c.customer_id, 'ZWROT', req.body.actor, null, null);
    res.json({ ok: true, was_open: d.rowCount > 0, character: `${c.first_name} ${c.last_name}` });
  }));

  // --- administracja: podgląd w każdej chwili (gracz tego nie widzi w historii) ---
  app.post('/internal/backpack/inspect', requireInternalKey, wrap(async (req, res) => {
    const c = await bySsn(pool, req.body.ssn);
    if (!c) return res.status(404).json({ error: 'Nie ma postaci z takim SSN.' });
    await log(pool, c.customer_id, 'PODGLAD_ADMIN', req.body.actor, null, null, false);
    const acc = await openAccess(pool, c.customer_id);
    res.json({ character: `${c.first_name} ${c.last_name}`, phone: c.phone_number, shared: !!acc, items: await items(pool, c.customer_id) });
  }));

  // --- telefon gracza: czy plecak jest udostępniony + historia ---
  app.get('/customer/backpack/status', requireCustomerAuth, wrap(async (req, res) => {
    const acc = await openAccess(pool, req.customerId);
    const hist = (await pool.query(
      'SELECT action, actor, item_name, qty, created_at FROM backpack_log WHERE customer_id = $1 AND visible ORDER BY id DESC LIMIT 15', [req.customerId])).rows;
    res.json({ open: !!acc, expires_at: acc ? acc.expires_at : null, history: hist });
  }));

  // gracz może sam zabrać plecak z powrotem
  app.post('/customer/backpack/close', requireCustomerAuth, wrap(async (req, res) => {
    const d = await pool.query('DELETE FROM backpack_access WHERE customer_id = $1', [req.customerId]);
    if (d.rowCount) await log(pool, req.customerId, 'ZABRANY', 'właściciel', null, null);
    res.json({ ok: true });
  }));
}

module.exports = { migrate, register, MINUTES };
