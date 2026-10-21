// Frakcje w telefonie: członkostwo (sync z Discorda), faktury EMS/DOT, skarbiec frakcji, numery usługowe (911, DOT).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const treasury = require('./treasury.js');

// invoices: true = frakcja ma appkę „Faktury”; pozostałe (LAPD/LAFD) są tu tylko po to, by odbierały połączenia służbowe
const FACTIONS = {
  EMS:  { label: 'EMS',  icon: '🚑', full: 'Emergency Medical Services', invoices: true },
  DOT:  { label: 'DOT',  icon: '🚧', full: 'Department of Transportation', invoices: true },
  LAPD: { label: 'LAPD', icon: '🚓', full: 'Los Angeles Police Department', invoices: true, invoiceKind: 'MANDAT' },
  LAFD: { label: 'LAFD', icon: '🚒', full: 'Los Angeles Fire Department', invoices: false },
  DOJ:  { label: 'DOJ',  icon: '⚖️', full: 'Department of Justice', invoices: false, panel: false },
};
// Panele frakcji w telefonie: domyślnie WŁĄCZONE (tryb przejściowy). PHONE_FACTION_PANELS=off chowa je z telefonu po przejściu na tablet MDT;
// kod i endpointy zostają, więc powrót to zmiana jednej zmiennej środowiskowej.
const MDT_TABLET = ['on', '1', 'true'].includes(String(process.env.MDT_TABLET_ENABLED || 'off').toLowerCase()); // tablet MDT wstrzymany – skrót w telefonie domyślnie ukryty
const PHONE_PANELS = String(process.env.PHONE_FACTION_PANELS || 'on').toLowerCase() !== 'off';
const kindOf = (f) => (FACTIONS[f] && FACTIONS[f].invoiceKind) || 'FAKTURA';
const RANKS = ['PRACOWNIK', 'ZASTEPCA', 'SZEF'];
const rankIdx = (r) => RANKS.indexOf(r);

const DOT_MAIN_PHONE = process.env.DOT_MAIN_PHONE || '555-0300';
const LAPD_MAIN_PHONE = process.env.LAPD_MAIN_PHONE || '555-0110';
const LAFD_MAIN_PHONE = process.env.LAFD_MAIN_PHONE || '555-0120';
const EMS_MAIN_PHONE = process.env.EMS_MAIN_PHONE || '555-0130';
const EMERGENCY_FACTIONS = (process.env.EMERGENCY_FACTIONS || 'LAPD,LAFD,EMS').split(',').map((s) => s.trim().toUpperCase()).filter((f) => FACTIONS[f]);

// numery fabryczne: numer -> { first, last, factions (kto odbiera połączenia) }
const SERVICE_NUMBERS = {
  '911': { first: 'Numer alarmowy', last: '911', factions: EMERGENCY_FACTIONS },
  [LAPD_MAIN_PHONE]: { first: 'LAPD', last: 'Numer główny', factions: ['LAPD'] },
  [LAFD_MAIN_PHONE]: { first: 'LAFD', last: 'Numer główny', factions: ['LAFD'] },
  [EMS_MAIN_PHONE]: { first: 'EMS', last: 'Numer główny', factions: ['EMS'] },
  [DOT_MAIN_PHONE]: { first: 'DOT', last: 'Numer główny', factions: ['DOT'] },
};

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_members (
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    faction TEXT NOT NULL,
    rank TEXT NOT NULL DEFAULT 'PRACOWNIK',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, faction)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_pending (
    discord_user_id TEXT NOT NULL, faction TEXT NOT NULL, rank TEXT NOT NULL DEFAULT 'PRACOWNIK',
    PRIMARY KEY (discord_user_id, faction)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_accounts (faction TEXT PRIMARY KEY, balance BIGINT NOT NULL DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS invoices (
    invoice_id SERIAL PRIMARY KEY,
    faction TEXT NOT NULL,
    issuer_customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OCZEKUJE',   -- OCZEKUJE | OPLACONA | ANULOWANA
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at TIMESTAMPTZ,
    cancelled_by INTEGER
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (customer_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS invoices_faction_idx ON invoices (faction, status)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS faction_transactions (
    id SERIAL PRIMARY KEY, faction TEXT NOT NULL, amount BIGINT NOT NULL, kind TEXT NOT NULL,
    ref TEXT, actor_customer_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

// kontakty usługowe (911, DOT) jako konta „NPC” – bez hasła, nie da się na nie zalogować
async function ensureServiceContacts(pool) {
  for (const [phone, s] of Object.entries(SERVICE_NUMBERS)) {
    const ex = await pool.query('SELECT customer_id FROM customers WHERE phone_number = $1', [phone]);
    if (ex.rows.length) continue;
    const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
    await pool.query(
      `INSERT INTO customers (first_name, last_name, username, password_hash, phone_number, status, must_change_password)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',false)`,
      [s.first, s.last, `svc_${phone.replace(/\W/g, '')}`, hash, phone]);
    console.log(`Utworzono numer usługowy ${phone} (${s.first} ${s.last}).`);
  }
}

// Frakcja jest przypisywana do KONKRETNEJ postaci komendą /frakcja przypisz (bot główny). Nic nie dziedziczy się automatycznie.
async function applyPending(pool, customerId, discordUserId) {
  if (discordUserId) await pool.query('DELETE FROM faction_pending WHERE discord_user_id = $1', [String(discordUserId)]).catch(() => {});
}

// wszyscy dyżurni (członkowie frakcji obsługujących numer), którzy są online i mają włączony telefon
async function dutyMembers(pool, phone, isOnline, excludeId) {
  const s = SERVICE_NUMBERS[phone];
  if (!s) return [];
  const r = await pool.query(
    `SELECT DISTINCT m.customer_id FROM faction_members m JOIN customers c ON c.customer_id = m.customer_id
     WHERE m.faction = ANY($1) AND c.phone_on = true`, [s.factions]);
  return r.rows.map((x) => x.customer_id).filter((id) => id !== excludeId && isOnline(id));
}

function register(app, { pool, requireCustomerAuth, requireInternalKey }) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Błąd serwera.' }); });

  // middleware: członek frakcji z min. rangą
  const member = (minRank = 'PRACOWNIK', needInvoices = false) => async (req, res, next) => {
    const f = String(req.params.faction || '').toUpperCase();
    if (!FACTIONS[f]) return res.status(404).json({ error: 'Nie ma takiej frakcji.' });
    const m = (await pool.query('SELECT rank FROM faction_members WHERE customer_id = $1 AND faction = $2 AND NOT suspended', [req.customerId, f])).rows[0];
    if (!m) return res.status(403).json({ error: 'Nie należysz do tej frakcji.' });
    if (needInvoices && !FACTIONS[f].invoices) return res.status(404).json({ error: 'Ta frakcja nie wystawia faktur.' });
    if (rankIdx(m.rank) < rankIdx(minRank)) return res.status(403).json({ error: 'Za niska ranga do tej akcji.' });
    req.faction = f; req.rank = m.rank;
    next();
  };

  // --- moje frakcje (appki odblokowują się na tej podstawie) ---
  app.get('/customer/factions/me', requireCustomerAuth, wrap(async (req, res) => {
    const r = await pool.query('SELECT faction, rank FROM faction_members WHERE customer_id = $1 ORDER BY faction', [req.customerId]);
    res.json(r.rows.map((x) => ({ ...x, ...FACTIONS[x.faction], panel: PHONE_PANELS && FACTIONS[x.faction].panel !== false, mdt_tablet: MDT_TABLET, ...(PHONE_PANELS ? {} : { invoices: false }) })));
  }));

  // --- podsumowanie ---
  app.get('/customer/factions/:faction/overview', requireCustomerAuth, member(), wrap(async (req, res) => {
    const f = req.faction;
    const mine = (await pool.query(
      `SELECT COUNT(*)::int AS issued,
              COUNT(*) FILTER (WHERE status='OPLACONA')::int AS paid,
              COUNT(*) FILTER (WHERE status='OCZEKUJE')::int AS pending,
              COALESCE(SUM(amount) FILTER (WHERE status='OPLACONA'),0)::bigint AS paid_sum
       FROM invoices WHERE faction=$1 AND issuer_customer_id=$2`, [f, req.customerId])).rows[0];
    const out = { faction: f, rank: req.rank, mine };
    if (rankIdx(req.rank) >= rankIdx('ZASTEPCA')) {
      out.treasury = Number((await pool.query('SELECT balance FROM faction_accounts WHERE faction=$1', [f])).rows[0]?.balance || 0);
      out.totals = (await pool.query(
        `SELECT COUNT(*)::int AS issued, COUNT(*) FILTER (WHERE status='OCZEKUJE')::int AS pending,
                COALESCE(SUM(amount) FILTER (WHERE status='OPLACONA'),0)::bigint AS paid_sum,
                COALESCE(SUM(amount) FILTER (WHERE status='OCZEKUJE'),0)::bigint AS pending_sum
         FROM invoices WHERE faction=$1`, [f])).rows[0];
      out.ranking = (await pool.query(
        `SELECT c.first_name, c.last_name, COUNT(*)::int AS n, COALESCE(SUM(i.amount),0)::bigint AS sum
         FROM invoices i JOIN customers c ON c.customer_id = i.issuer_customer_id
         WHERE i.faction=$1 AND i.status='OPLACONA' GROUP BY c.customer_id ORDER BY sum DESC LIMIT 5`, [f])).rows;
    }
    res.json(out);
  }));

  // --- wystawianie faktury ---
  app.post('/customer/factions/:faction/invoices', requireCustomerAuth, member('PRACOWNIK', true), wrap(async (req, res) => {
    const { to_phone_number } = req.body;
    const amount = Number(req.body.amount);
    const title = String(req.body.title || '').trim();
    if (!to_phone_number) return res.status(400).json({ error: 'Podaj numer telefonu klienta.' });
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000000000) return res.status(400).json({ error: 'Kwota: liczba całkowita, minimum 1.' });
    if (title.length < 2 || title.length > 120) return res.status(400).json({ error: 'Opis faktury: 2–120 znaków.' });
    if (SERVICE_NUMBERS[to_phone_number]) return res.status(400).json({ error: 'Nie wystawisz faktury na numer usługowy.' });
    const target = (await pool.query(`SELECT customer_id, first_name, last_name FROM customers WHERE phone_number = $1 AND username NOT LIKE 'svc\\_%' AND username <> 'npc_nieznajomy'`, [to_phone_number])).rows[0];
    if (!target) return res.status(404).json({ error: 'Nie znaleziono takiego numeru.' });
    if (target.customer_id === req.customerId) return res.status(400).json({ error: 'Nie możesz wystawić faktury samemu sobie.' });

    // opcjonalne powiązanie ze zgłoszeniem tej samej frakcji (kwotę zawsze podaje wystawiający – tu nie ma taryfikatora)
    let ticketId = null;
    if (req.body.ticket_id) {
      ticketId = parseInt(req.body.ticket_id, 10);
      const okT = Number.isInteger(ticketId) && (await pool.query('SELECT 1 FROM tickets WHERE ticket_id=$1 AND faction=$2', [ticketId, req.faction])).rowCount;
      if (!okT) return res.status(400).json({ error: 'Nie ma takiego zgłoszenia w tej frakcji.' });
    }
    const inv = (await pool.query(
      `INSERT INTO invoices (faction, issuer_customer_id, customer_id, amount, title, ticket_id, source, kind) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING *`,
      [req.faction, req.customerId, target.customer_id, amount, title, ticketId, kindOf(req.faction)])).rows[0];
    await pool.query(
      'INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3)',
      [req.customerId, target.customer_id, `🧾 ${kindOf(req.faction) === 'MANDAT' ? 'Mandat' : 'Faktura'} #${inv.invoice_id} od ${req.faction}: ${amount}$ — ${title}. Zapłać w appce Bank → zakładka Faktury.`]);
    res.json({ ok: true, invoice: inv, customer: `${target.first_name} ${target.last_name}` });
  }));

  // --- lista faktur frakcji ---
  app.get('/customer/factions/:faction/invoices', requireCustomerAuth, member('PRACOWNIK', true), wrap(async (req, res) => {
    const all = req.query.scope === 'all';
    if (all && rankIdx(req.rank) < rankIdx('ZASTEPCA')) return res.status(403).json({ error: 'Za niska ranga.' });
    const r = await pool.query(
      `SELECT i.invoice_id, i.amount, i.title, i.status, i.kind, i.created_at, i.paid_at,
              c.first_name AS c_first, c.last_name AS c_last, u.first_name AS i_first, u.last_name AS i_last
       FROM invoices i JOIN customers c ON c.customer_id = i.customer_id JOIN customers u ON u.customer_id = i.issuer_customer_id
       WHERE i.faction = $1 ${all ? '' : 'AND i.issuer_customer_id = $2'}
       ORDER BY i.created_at DESC LIMIT 40`, all ? [req.faction] : [req.faction, req.customerId]);
    res.json(r.rows);
  }));

  // historia mandatów/faktur danej osoby wystawionych przez tę frakcję (po numerze telefonu) – tylko dla frakcji z fakturami
  app.get('/customer/factions/:faction/invoices/history', requireCustomerAuth, member('PRACOWNIK', true), wrap(async (req, res) => {
    const ph = String(req.query.phone || '').trim();
    const c = (await pool.query(`SELECT customer_id, first_name, last_name FROM customers WHERE phone_number=$1 AND username NOT LIKE 'svc\\_%' AND username <> 'npc_nieznajomy'`, [ph])).rows[0];
    if (!c) return res.status(404).json({ error: 'Nie znaleziono takiego numeru.' });
    const rows = (await pool.query(
      `SELECT i.invoice_id, i.amount, i.title, i.status, i.kind, i.created_at, i.paid_at, u.first_name AS i_first, u.last_name AS i_last
       FROM invoices i JOIN customers u ON u.customer_id = i.issuer_customer_id WHERE i.customer_id=$1 AND i.faction=$2 ORDER BY i.created_at DESC LIMIT 30`, [c.customer_id, req.faction])).rows;
    res.json({ person: `${c.first_name} ${c.last_name}`, items: rows });
  }));

  app.post('/customer/factions/:faction/invoices/:id/cancel', requireCustomerAuth, member('PRACOWNIK', true), wrap(async (req, res) => {
    const inv = (await pool.query('SELECT * FROM invoices WHERE invoice_id = $1 AND faction = $2', [req.params.id, req.faction])).rows[0];
    if (!inv) return res.status(404).json({ error: 'Nie znaleziono faktury.' });
    if (inv.issuer_customer_id !== req.customerId && rankIdx(req.rank) < rankIdx('ZASTEPCA')) return res.status(403).json({ error: 'Możesz anulować tylko swoje faktury.' });
    const u = await pool.query(`UPDATE invoices SET status='ANULOWANA', cancelled_by=$2 WHERE invoice_id=$1 AND status='OCZEKUJE' RETURNING invoice_id`, [inv.invoice_id, req.customerId]);
    if (!u.rowCount) return res.status(400).json({ error: 'Ta faktura nie jest już do zapłaty.' });
    res.json({ ok: true });
  }));

  // --- ludzie (zastępca+) ---
  app.get('/customer/factions/:faction/members', requireCustomerAuth, member('ZASTEPCA'), wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT m.rank, c.customer_id, c.first_name, c.last_name, c.phone_number,
              (SELECT COUNT(*)::int FROM invoices i WHERE i.faction = m.faction AND i.issuer_customer_id = c.customer_id AND i.status='OPLACONA') AS paid_invoices
       FROM faction_members m JOIN customers c ON c.customer_id = m.customer_id
       WHERE m.faction = $1 ORDER BY CASE m.rank WHEN 'SZEF' THEN 0 WHEN 'ZASTEPCA' THEN 1 ELSE 2 END, c.last_name`, [req.faction]);
    res.json(r.rows);
  }));

  // --- wypłata ze skarbca na własne konto (szef) ---
  app.post('/customer/factions/:faction/payout', requireCustomerAuth, member('SZEF'), wrap(async (req, res) => {
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1) return res.status(400).json({ error: 'Podaj poprawną kwotę.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO faction_accounts (faction, balance) VALUES ($1,0) ON CONFLICT DO NOTHING', [req.faction]);
      const fa = (await client.query('SELECT balance FROM faction_accounts WHERE faction=$1 FOR UPDATE', [req.faction])).rows[0];
      if (Number(fa.balance) < amount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Za mało środków w skarbcu frakcji.' }); }
      const acc = (await client.query('SELECT account_id FROM accounts WHERE customer_id=$1 ORDER BY account_id LIMIT 1 FOR UPDATE', [req.customerId])).rows[0];
      if (!acc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie masz konta bankowego.' }); }
      await client.query('UPDATE faction_accounts SET balance = balance - $2 WHERE faction=$1', [req.faction, amount]);
      await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id=$1', [acc.account_id, amount]);
      await client.query(`INSERT INTO bank_transactions (receiver_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'FACTION_PAYOUT')`, [acc.account_id, amount, `Wypłata ze skarbca ${req.faction}`]);
      await client.query(`INSERT INTO faction_transactions (faction, amount, kind, actor_customer_id) VALUES ($1,$2,'PAYOUT',$3)`, [req.faction, -amount, req.customerId]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }));

  // --- skarbiec frakcji: numer konta, saldo, historia (zarząd) ---
  app.get('/customer/factions/:faction/treasury', requireCustomerAuth, member('ZASTEPCA'), wrap(async (req, res) => {
    const acc = (await pool.query('SELECT balance, account_number FROM faction_accounts WHERE faction=$1', [req.faction])).rows[0] || { balance: 0, account_number: treasury.HOLDERS[req.faction] };
    const hist = (await pool.query(
      `SELECT t.amount, t.kind, t.ref, t.counterparty, t.created_at, c.first_name, c.last_name FROM faction_transactions t
       LEFT JOIN customers c ON c.customer_id = t.actor_customer_id WHERE t.faction=$1 ORDER BY t.created_at DESC, t.id DESC LIMIT 40`, [req.faction])).rows;
    res.json({ balance: Number(acc.balance), account_number: acc.account_number, vat_pct: treasury.VAT_PCT, history: hist });
  }));

  // przelew ze skarbca na konto członka frakcji (ręczne wypłaty ustala zarząd); siebie może wypłacić tylko szef
  app.post('/customer/factions/:faction/transfer', requireCustomerAuth, member('ZASTEPCA'), wrap(async (req, res) => {
    const amount = Number(req.body.amount);
    const title = String(req.body.title || '').trim().slice(0, 120) || 'Wypłata ze skarbca';
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000000000) return res.status(400).json({ error: 'Kwota: liczba całkowita, minimum 1.' });
    const to = (await pool.query(
      `SELECT c.customer_id, c.first_name, c.last_name FROM faction_members m JOIN customers c ON c.customer_id = m.customer_id
       WHERE m.faction=$1 AND c.phone_number=$2`, [req.faction, String(req.body.to_phone_number || '').trim()])).rows[0];
    if (!to) return res.status(404).json({ error: 'Ten numer nie należy do pracownika tej frakcji.' });
    if (to.customer_id === req.customerId && req.rank !== 'SZEF') return res.status(403).json({ error: 'Sobie może wypłacić tylko szef.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const acc = (await client.query('SELECT account_id, status FROM accounts WHERE customer_id=$1 ORDER BY account_id LIMIT 1 FOR UPDATE', [to.customer_id])).rows[0];
      if (!acc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pracownik nie ma konta bankowego.' }); }
      if (acc.status !== 'ACTIVE') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Konto pracownika jest zablokowane.' }); }
      const okDebit = await treasury.debit(client, req.faction, amount, 'WYPLATA', title, req.customerId, `${to.first_name} ${to.last_name}`);
      if (!okDebit) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Za mało środków w skarbcu frakcji.' }); }
      await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id=$1', [acc.account_id, amount]);
      await client.query(`INSERT INTO bank_transactions (receiver_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'FACTION_PAYOUT')`, [acc.account_id, amount, `${req.faction}: ${title}`]);
      await client.query(`INSERT INTO faction_audit (faction, actor_customer_id, action, target, detail) VALUES ($1,$2,'WYPLATA',$3,$4)`, [req.faction, req.customerId, String(to.customer_id), `${amount}$ — ${title}`]).catch(() => {});
      await client.query('COMMIT');
      res.json({ ok: true, to: `${to.first_name} ${to.last_name}` });
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  }));

  // --- strona płacącego (appka Bank → Faktury) ---
  app.get('/customer/invoices', requireCustomerAuth, wrap(async (req, res) => {
    const base = `SELECT i.invoice_id, i.faction, i.amount, i.title, i.status, i.kind, i.created_at, i.paid_at, u.first_name AS i_first, u.last_name AS i_last
                  FROM invoices i JOIN customers u ON u.customer_id = i.issuer_customer_id WHERE i.customer_id = $1`;
    const pending = (await pool.query(`${base} AND i.status='OCZEKUJE' ORDER BY i.created_at DESC LIMIT 50`, [req.customerId])).rows;
    const recent = (await pool.query(`${base} AND i.status='OPLACONA' ORDER BY i.paid_at DESC LIMIT 10`, [req.customerId])).rows;
    res.json({ pending, recent });
  }));

  app.post('/customer/invoices/:id/pay', requireCustomerAuth, wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = (await client.query(`SELECT * FROM invoices WHERE invoice_id=$1 AND customer_id=$2 FOR UPDATE`, [req.params.id, req.customerId])).rows[0];
      if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono faktury.' }); }
      if (inv.status !== 'OCZEKUJE') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ta faktura nie jest do zapłaty.' }); }
      const acc = (await client.query(`SELECT account_id, balance, status FROM accounts WHERE customer_id=$1 ORDER BY account_id LIMIT 1 FOR UPDATE`, [req.customerId])).rows[0];
      if (!acc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie masz konta bankowego.' }); }
      if (acc.status !== 'ACTIVE') { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Twoje konto jest zablokowane.' }); }
      if (Number(acc.balance) < Number(inv.amount)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Niewystarczające środki.' }); }
      await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id=$1', [acc.account_id, inv.amount]);
      const vat = inv.kind === 'MANDAT' ? 0 : Math.min(treasury.vatOf(inv.amount), Number(inv.amount)); // mandat nie podlega VAT
      const net = Number(inv.amount) - vat;
      await treasury.credit(client, inv.faction, net, 'INVOICE', `${inv.kind === 'MANDAT' ? 'MANDAT' : 'FV'} #${inv.invoice_id}`, null, null);
      if (vat > 0) await treasury.credit(client, 'BANK', vat, 'VAT', `FV #${inv.invoice_id} (${inv.faction})`, null, inv.faction);
      await client.query(`INSERT INTO bank_transactions (sender_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'INVOICE')`, [acc.account_id, inv.amount, `${inv.kind === 'MANDAT' ? 'Mandat' : 'Faktura'} #${inv.invoice_id} (${inv.faction}): ${inv.title}`]);
      await client.query(`UPDATE invoices SET status='OPLACONA', paid_at=now(), vat=$2 WHERE invoice_id=$1`, [inv.invoice_id, vat]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }));

  // --- wewnętrzne (bot główny) ---
  // Synchronizacja z rolą Discorda: NIE przypisuje postaci. Rola ustawia tylko rangę tam, gdzie gracz już przypisał frakcję,
  // a zdjęcie roli odbiera frakcję wszystkim postaciom tego gracza.
  app.post('/internal/factions/sync', requireInternalKey, wrap(async (req, res) => {
    const { discord_user_id, faction } = req.body;
    const isMember = !!req.body.member;
    const rank = RANKS.includes(req.body.rank) ? req.body.rank : 'PRACOWNIK';
    const f = String(faction || '').toUpperCase();
    if (!discord_user_id || !FACTIONS[f]) return res.status(400).json({ error: 'Wymagane: discord_user_id, faction (EMS/DOT).' });
    const ids = (await pool.query(`SELECT customer_id FROM customers WHERE discord_user_id = $1 AND username NOT LIKE 'svc\\_%'`, [String(discord_user_id)])).rows.map((x) => x.customer_id);
    if (!ids.length) return res.json({ ok: true, linked: false });
    if (isMember) await pool.query('UPDATE faction_members SET rank=$3 WHERE customer_id = ANY($1) AND faction=$2', [ids, f, rank]);
    else {
      await pool.query('DELETE FROM faction_members WHERE customer_id = ANY($1) AND faction=$2', [ids, f]);
      await pool.query('DELETE FROM faction_duty WHERE customer_id = ANY($1) AND faction=$2', [ids, f]).catch(() => {});
      await pool.query('UPDATE ticket_units SET released_at=now() WHERE customer_id = ANY($1) AND faction=$2 AND released_at IS NULL', [ids, f]).catch(() => {});
    }
    res.json({ ok: true, linked: true });
  }));

  const normS = (v) => String(v || '').toUpperCase().replace(/[\s-]/g, '');
  const ownedBySsn = async (discordId, ssn) => (await pool.query(
    `SELECT customer_id, first_name, last_name FROM customers WHERE discord_user_id=$1 AND upper(replace(replace(ssn_rp,' ',''),'-',''))=$2 AND username NOT LIKE 'svc\\_%' LIMIT 1`,
    [String(discordId), normS(ssn)])).rows[0];

  // przypisz frakcję do postaci o danym SSN (bot sprawdza wcześniej rolę na Discordzie i podaje rangę)
  app.post('/internal/factions/assign', requireInternalKey, wrap(async (req, res) => {
    const { discord_user_id, ssn } = req.body;
    const f = String(req.body.faction || '').toUpperCase();
    const rank = RANKS.includes(req.body.rank) ? req.body.rank : 'PRACOWNIK';
    if (!discord_user_id || !ssn || !FACTIONS[f]) return res.status(400).json({ error: 'Wymagane: discord_user_id, ssn, faction.' });
    const c = await ownedBySsn(discord_user_id, ssn);
    if (!c) return res.status(404).json({ error: 'Nie ma twojej postaci z takim SSN i aktywnym telefonem. Najpierw /telefon aktywuj.' });
    const other = (await pool.query(`SELECT c.first_name, c.last_name FROM faction_members m JOIN customers c ON c.customer_id=m.customer_id
      WHERE m.faction=$2 AND c.discord_user_id=$1 AND m.customer_id<>$3 LIMIT 1`, [String(discord_user_id), f, c.customer_id])).rows[0];
    if (other) return res.status(409).json({ error: `Frakcja ${f} jest już przypisana do postaci ${other.first_name} ${other.last_name}. Najpierw ją zdejmij: /frakcja zdejmij.` });
    await pool.query(`INSERT INTO faction_members (customer_id, faction, rank) VALUES ($1,$2,$3) ON CONFLICT (customer_id, faction) DO UPDATE SET rank=EXCLUDED.rank`, [c.customer_id, f, rank]);
    res.json({ ok: true, character: `${c.first_name} ${c.last_name}`, faction: f, rank });
  }));

  app.post('/internal/factions/unassign', requireInternalKey, wrap(async (req, res) => {
    const { discord_user_id, ssn } = req.body;
    const f = String(req.body.faction || '').toUpperCase();
    if (!discord_user_id || !ssn || !FACTIONS[f]) return res.status(400).json({ error: 'Wymagane: discord_user_id, ssn, faction.' });
    const c = await ownedBySsn(discord_user_id, ssn);
    if (!c) return res.status(404).json({ error: 'Nie ma twojej postaci z takim SSN.' });
    const d = await pool.query('DELETE FROM faction_members WHERE customer_id=$1 AND faction=$2', [c.customer_id, f]);
    await pool.query('DELETE FROM faction_duty WHERE customer_id=$1 AND faction=$2', [c.customer_id, f]).catch(() => {});
    await pool.query('UPDATE ticket_units SET released_at=now() WHERE customer_id=$1 AND faction=$2 AND released_at IS NULL', [c.customer_id, f]).catch(() => {});
    res.json({ ok: true, removed: d.rowCount, character: `${c.first_name} ${c.last_name}` });
  }));

  app.get('/internal/factions/assignments/:discordId', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT c.first_name, c.last_name, c.ssn_rp, m.faction, m.rank FROM faction_members m JOIN customers c ON c.customer_id=m.customer_id
       WHERE c.discord_user_id=$1 ORDER BY m.faction`, [String(req.params.discordId)]);
    res.json(r.rows);
  }));

  // --- wewnętrzne: budżet państwa (komendy bota banku) ---
  app.get('/internal/treasury/overview', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(`SELECT faction, balance, account_number FROM faction_accounts WHERE faction = ANY($1) ORDER BY CASE faction WHEN 'BANK' THEN 0 ELSE 1 END, faction`, [Object.keys(treasury.HOLDERS)]);
    res.json({ vat_pct: treasury.VAT_PCT, accounts: r.rows.map((x) => ({ ...x, balance: Number(x.balance), label: treasury.LABEL[x.faction] })) });
  }));

  // dotacja z banku państwa dla frakcji (bank nie może zejść poniżej zera)
  app.post('/internal/treasury/grant', requireInternalKey, wrap(async (req, res) => {
    const f = String(req.body.faction || '').toUpperCase();
    const amount = Number(req.body.amount);
    const title = String(req.body.title || '').trim().slice(0, 120) || 'Dotacja';
    if (!treasury.HOLDERS[f] || f === 'BANK') return res.status(400).json({ error: 'Frakcja: EMS, DOT, LAPD albo LAFD.' });
    if (!Number.isInteger(amount) || amount < 1) return res.status(400).json({ error: 'Kwota: liczba całkowita, minimum 1.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ok = await treasury.debit(client, 'BANK', amount, 'DOTACJA', `${f}: ${title}`, null, f);
      if (!ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Za mało środków w banku państwa.' }); }
      await treasury.credit(client, f, amount, 'DOTACJA', title, null, 'BANK');
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  }));

  // zasilenie budżetu państwa (start gry / decyzja administracji) – zawsze z wpisem w historii
  app.post('/internal/treasury/mint', requireInternalKey, wrap(async (req, res) => {
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1) return res.status(400).json({ error: 'Kwota: liczba całkowita, minimum 1.' });
    await treasury.credit(pool, 'BANK', amount, 'ZASILENIE', String(req.body.title || req.body.actor || 'administracja').slice(0, 120), null, null);
    res.json({ ok: true });
  }));

  app.get('/internal/factions/:faction/members', requireInternalKey, wrap(async (req, res) => {
    const f = String(req.params.faction).toUpperCase();
    const r = await pool.query(
      `SELECT c.discord_user_id, m.rank FROM faction_members m JOIN customers c ON c.customer_id = m.customer_id WHERE m.faction = $1 AND c.discord_user_id IS NOT NULL`, [f]);
    res.json(r.rows);
  }));
}

module.exports = { FACTIONS, RANKS, SERVICE_NUMBERS, migrate, ensureServiceContacts, applyPending, dutyMembers, register };
