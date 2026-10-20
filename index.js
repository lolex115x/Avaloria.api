require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, initDb, logAction } = require('./db.js');
const factions = require('./factions.js');
const ops = require('./ops.js');
const treasury = require('./treasury.js');
const shop = require('./shop.js');
const backpack = require('./backpack.js');
const mdt = require('./mdt/index.js');

const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const INITIAL_ACCOUNT_BALANCE = parseInt(process.env.INITIAL_ACCOUNT_BALANCE || '5000', 10);
const DARKWEB_SECRET_PHRASE = (process.env.DARKWEB_SECRET_PHRASE || 'szukam towaru').toLowerCase().trim();
const DARKWEB_NPC_PHONE = '666-0000';
const DARKWEB_NPC_NAME = ['Nieznajomy', ''];
const DISCORD_ORDERS_WEBHOOK_URL = process.env.DISCORD_ORDERS_WEBHOOK_URL || null;

// ====== BEZPIECZEŃSTWO: klucz wewnętrzny dla bota bankowego ======
// Bank bot musi wysyłać nagłówek: x-api-key: <INTERNAL_API_KEY z .env>
function requireInternalKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Brak autoryzacji.' });
  }
  next();
}

async function requireCustomerAuth(req, res, next) {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Brak tokenu.' });

  const result = await pool.query(
    `SELECT s.customer_id, s.expires_at FROM sessions s WHERE s.token = $1`,
    [token]
  );
  if (result.rows.length === 0 || new Date(result.rows[0].expires_at) < new Date()) {
    return res.status(401).json({ error: 'Sesja wygasła, zaloguj się ponownie.' });
  }
  req.customerId = result.rows[0].customer_id;
  next();
}

function generateAccountNumber() {
  const part = () => crypto.randomInt(1000, 9999);
  return `AFB-${part()}-${part()}-${part()}`;
}

function generateTempPassword() {
  return crypto.randomBytes(6).toString('hex'); // 12 znaków, czytelne, hex
}

function generatePhoneNumber() {
  const line = () => crypto.randomInt(1000, 9999);
  return `555-${line()}`;
}

async function ensureNpcContact() {
  const existing = await pool.query('SELECT customer_id FROM customers WHERE phone_number = $1', [DARKWEB_NPC_PHONE]);
  if (existing.rows.length > 0) return existing.rows[0].customer_id;

  const fakeHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
  const result = await pool.query(
    `INSERT INTO customers (first_name, last_name, username, password_hash, phone_number, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING customer_id`,
    [DARKWEB_NPC_NAME[0], DARKWEB_NPC_NAME[1], 'npc_nieznajomy', fakeHash, DARKWEB_NPC_PHONE]
  );
  console.log('Utworzono kontakt NPC "Nieznajomy" (darkweb).');
  return result.rows[0].customer_id;
}

// ====== HEALTHCHECK ======
app.get('/health', (req, res) => res.json({ ok: true }));

// ====== PULA SSN (numery nadawane po kolei, w kolejności dołączania) ======
const SSN_PER_PLAYER = parseInt(process.env.MAX_CHARACTERS_PER_DISCORD || '3', 10);
const SSN_POOL_REQUIRED = process.env.SSN_POOL_REQUIRED !== 'false';
async function migrateSsnPool() {
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ssn_seq START 1`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ssn_pool (
    ssn TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ssn_pool_discord_idx ON ssn_pool(discord_user_id)`);
}
async function ssnsOf(db, discordId) {
  const r = await db.query(
    `SELECT p.ssn, c.customer_id IS NOT NULL AS used
     FROM ssn_pool p LEFT JOIN customers c ON upper(replace(replace(c.ssn_rp, ' ', ''), '-', '')) = p.ssn
     WHERE p.discord_user_id = $1 ORDER BY p.ssn`, [String(discordId)]);
  return r.rows;
}
// idempotentne: gracz dostaje swoje SSN tylko raz, kolejne wywołania zwracają te same numery
app.post('/internal/ssn/allocate', requireInternalKey, async (req, res) => {
  const discordId = String(req.body.discord_user_id || '');
  if (!discordId) return res.status(400).json({ error: 'Wymagane: discord_user_id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ssnalloc:' + discordId]);
    let created = false;
    let rows = await ssnsOf(client, discordId);
    if (rows.length === 0) {
      for (let i = 0; i < SSN_PER_PLAYER; i++) {
        const n = await client.query(`SELECT nextval('ssn_seq') AS n`);
        await client.query('INSERT INTO ssn_pool (ssn, discord_user_id) VALUES ($1,$2)', [String(n.rows[0].n).padStart(4, '0'), discordId]);
      }
      rows = await ssnsOf(client, discordId);
      created = true;
    }
    await client.query('COMMIT');
    res.json({ created, ssns: rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Błąd nadawania SSN.' });
  } finally { client.release(); }
});
app.get('/internal/ssn/:discordId', requireInternalKey, async (req, res) => {
  res.json({ ssns: await ssnsOf(pool, req.params.discordId) });
});

// ====== AKTYWACJA TELEFONU (bez wizyty w banku) ======
const MAX_CHARACTERS_PER_DISCORD = parseInt(process.env.MAX_CHARACTERS_PER_DISCORD || '3', 10);
const normSsn = (v) => String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '');

async function newUniquePhone(client) {
  let phoneNumber = generatePhoneNumber();
  for (let i = 0; i < 8; i++) {
    const exists = await client.query('SELECT 1 FROM customers WHERE phone_number = $1', [phoneNumber]);
    if (exists.rows.length === 0) break;
    phoneNumber = generatePhoneNumber();
  }
  return phoneNumber;
}

// Gracz aktywuje telefon swojej postaci (identyfikacja: SSN postaci + Discord). Konto bankowe zakłada się później w banku.
app.post('/internal/customers/activate-phone', requireInternalKey, async (req, res) => {
  const { discord_user_id, first_name, last_name, date_of_birth, actor } = req.body;
  const ssn = normSsn(req.body.ssn_rp);
  if (!discord_user_id || !first_name || !last_name || !ssn) {
    return res.status(400).json({ error: 'Wymagane: discord_user_id, first_name, last_name, ssn_rp.' });
  }
  if (ssn.length < 4 || ssn.length > 24) return res.status(400).json({ error: 'Nieprawidłowy SSN postaci.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // blokada na SSN i na gracza - dwa jednoczesne wywołania nie utworzą duplikatu
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ssn:' + ssn]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dc:' + discord_user_id]);

    if (SSN_POOL_REQUIRED) {
      const owned = await client.query('SELECT 1 FROM ssn_pool WHERE ssn = $1 AND discord_user_id = $2', [ssn, String(discord_user_id)]);
      if (owned.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Ten SSN nie należy do Ciebie. Swoje numery sprawdzisz komendą /telefon ssn.' });
      }
    }
    const dupSsn = await client.query('SELECT customer_id, discord_user_id FROM customers WHERE upper(replace(replace(ssn_rp, \' \', \'\'), \'-\', \'\')) = $1', [ssn]);
    if (dupSsn.rows.length > 0) {
      await client.query('ROLLBACK');
      const same = dupSsn.rows[0].discord_user_id === String(discord_user_id);
      return res.status(409).json({ error: same
        ? 'Ta postać ma już aktywny telefon. Jeśli nie pamiętasz hasła, poproś pracownika banku o reset.'
        : 'Ten SSN jest już przypisany do innej osoby.' });
    }
    // limit postaci pilnuje już pula SSN (max. tyle numerów, ile jest w puli gracza); starych kont testowych bez SSN z puli nie liczymy
    const count = SSN_POOL_REQUIRED
      ? { rows: [{ n: 0 }] }
      : await client.query('SELECT COUNT(*)::int AS n FROM customers WHERE discord_user_id = $1', [String(discord_user_id)]);
    if (count.rows[0].n >= MAX_CHARACTERS_PER_DISCORD) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Masz już aktywne telefony dla maksymalnej liczby postaci (${MAX_CHARACTERS_PER_DISCORD}).` });
    }

    const username = `${first_name}.${last_name}${crypto.randomInt(100, 999)}`.toLowerCase().replace(/\s+/g, '');
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const phoneNumber = await newUniquePhone(client);

    const ins = await client.query(
      `INSERT INTO customers (discord_user_id, first_name, last_name, date_of_birth, ssn_rp, username, password_hash, phone_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING customer_id`,
      [String(discord_user_id), String(first_name).trim(), String(last_name).trim(), date_of_birth || null, ssn, username, passwordHash, phoneNumber]
    );
    await client.query('COMMIT');
    const customerId = ins.rows[0].customer_id;
    await factions.applyPending(pool, customerId, String(discord_user_id)).catch((e) => console.error('applyPending:', e.message));
    await logAction(actor || 'system', 'ACTIVATE_PHONE', `customer_id=${customerId}`, 'OK');
    res.json({ customer_id: customerId, phone_number: phoneNumber, username, temp_password: tempPassword });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Błąd aktywacji telefonu.' });
  } finally {
    client.release();
  }
});

// Pracownik banku zakłada konto dla klienta, który ma już aktywny telefon
async function openAccountFor(client, customerId) {
  const exists = await client.query('SELECT 1 FROM accounts WHERE customer_id = $1', [customerId]);
  if (exists.rows.length > 0) return null;
  let accountNumber = generateAccountNumber();
  for (let i = 0; i < 5; i++) {
    const dup = await client.query('SELECT 1 FROM accounts WHERE account_number = $1', [accountNumber]);
    if (dup.rows.length === 0) break;
    accountNumber = generateAccountNumber();
  }
  await client.query('INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1,$2,$3)', [customerId, accountNumber, INITIAL_ACCOUNT_BALANCE]);
  return accountNumber;
}
app.post('/internal/customers/:id/open-account', requireInternalKey, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acc:' + req.params.id]);
    const cust = await client.query('SELECT customer_id, first_name, last_name, phone_number FROM customers WHERE customer_id = $1', [req.params.id]);
    if (cust.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono klienta.' }); }
    const accountNumber = await openAccountFor(client, cust.rows[0].customer_id);
    if (!accountNumber) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Ten klient ma już konto bankowe.' }); }
    await client.query('COMMIT');
    await logAction(req.body.actor || 'system', 'OPEN_ACCOUNT', `customer_id=${req.params.id}`, 'OK');
    res.json({ account_number: accountNumber, initial_balance: INITIAL_ACCOUNT_BALANCE, customer: cust.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Błąd zakładania konta.' });
  } finally {
    client.release();
  }
});

// ====== TWORZENIE KLIENTA + KONTA (pracownik banku w RP) ======
app.post('/internal/customers', requireInternalKey, async (req, res) => {
  const { character_id, discord_user_id, first_name, middle_name, last_name, date_of_birth, ssn_rp, actor } = req.body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Wymagane: first_name, last_name.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // postać z aktywowanym telefonem (ten sam SSN) dostaje tylko konto, bez duplikowania klienta
    if (ssn_rp) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ssn:' + normSsn(ssn_rp)]);
      const ex = await client.query('SELECT customer_id, username, phone_number FROM customers WHERE upper(replace(replace(ssn_rp, \' \', \'\'), \'-\', \'\')) = $1', [normSsn(ssn_rp)]);
      if (ex.rows.length > 0) {
        const accountNumber = await openAccountFor(client, ex.rows[0].customer_id);
        if (!accountNumber) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Ta postać (SSN) ma już klienta i konto bankowe.' }); }
        await client.query('COMMIT');
        await logAction(actor || 'system', 'OPEN_ACCOUNT', `customer_id=${ex.rows[0].customer_id}`, 'OK');
        return res.json({ customer_id: ex.rows[0].customer_id, account_number: accountNumber, phone_number: ex.rows[0].phone_number,
          username: ex.rows[0].username, temp_password: null, initial_balance: INITIAL_ACCOUNT_BALANCE, existing: true });
      }
    }

    const username = `${first_name}.${last_name}${crypto.randomInt(100, 999)}`.toLowerCase().replace(/\s+/g, '');
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    let phoneNumber = generatePhoneNumber();
    for (let i = 0; i < 5; i++) {
      const exists = await client.query('SELECT 1 FROM customers WHERE phone_number = $1', [phoneNumber]);
      if (exists.rows.length === 0) break;
      phoneNumber = generatePhoneNumber();
    }

    const customerRes = await client.query(
      `INSERT INTO customers (character_id, discord_user_id, first_name, middle_name, last_name, date_of_birth, ssn_rp, username, password_hash, phone_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING customer_id`,
      [character_id || null, discord_user_id || null, first_name, middle_name || null, last_name, date_of_birth || null, ssn_rp || null, username, passwordHash, phoneNumber]
    );
    const customerId = customerRes.rows[0].customer_id;

    let accountNumber = generateAccountNumber();
    // upewnij się, że numer konta jest unikalny (bardzo mało prawdopodobna kolizja, ale sprawdzamy)
    for (let i = 0; i < 5; i++) {
      const exists = await client.query('SELECT 1 FROM accounts WHERE account_number = $1', [accountNumber]);
      if (exists.rows.length === 0) break;
      accountNumber = generateAccountNumber();
    }

    await client.query(
      `INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1,$2,$3)`,
      [customerId, accountNumber, INITIAL_ACCOUNT_BALANCE]
    );

    await client.query('COMMIT');
    await factions.applyPending(pool, customerId, discord_user_id).catch((e) => console.error('applyPending:', e.message));
    await logAction(actor || 'system', 'CREATE_CUSTOMER', `customer_id=${customerId}`, 'OK');

    res.json({
      customer_id: customerId,
      account_number: accountNumber,
      phone_number: phoneNumber,
      username,
      temp_password: tempPassword,
      initial_balance: INITIAL_ACCOUNT_BALANCE,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Błąd tworzenia klienta.' });
  } finally {
    client.release();
  }
});

// ====== WYSZUKIWANIE KLIENTA ======
app.get('/internal/customers/search', requireInternalKey, async (req, res) => {
  const q = (req.query.query || '').trim();
  if (!q) return res.status(400).json({ error: 'Brak parametru query.' });

  const result = await pool.query(
    `SELECT c.customer_id, c.first_name, c.last_name, c.discord_user_id, c.ssn_rp, c.status, c.username, c.phone_number,
            a.account_number, a.balance, a.status AS account_status
     FROM customers c
     LEFT JOIN accounts a ON a.customer_id = c.customer_id
     WHERE c.username NOT LIKE 'svc\\_%' AND c.username <> 'npc_nieznajomy' AND (c.discord_user_id = $1
        OR c.ssn_rp ILIKE $2
        OR c.first_name ILIKE $2
        OR c.last_name ILIKE $2
        OR (c.first_name || ' ' || c.last_name) ILIKE $2
        OR c.username ILIKE $2
        OR c.phone_number ILIKE $2
        OR a.account_number ILIKE $2)
     ORDER BY c.customer_id DESC
     LIMIT 20`,
    [q, `%${q}%`]
  );
  res.json(result.rows);
});

// ====== PEŁNY PROFIL KLIENTA ======
app.get('/internal/customers/:id', requireInternalKey, async (req, res) => {
  const customerId = req.params.id;
  const customer = await pool.query('SELECT * FROM customers WHERE customer_id = $1', [customerId]);
  if (customer.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const accounts = await pool.query('SELECT * FROM accounts WHERE customer_id = $1', [customerId]);
  const accountIds = accounts.rows.map(a => a.account_id);

  let transactions = [];
  if (accountIds.length > 0) {
    const txRes = await pool.query(
      `SELECT * FROM bank_transactions WHERE sender_account_id = ANY($1) OR receiver_account_id = ANY($1)
       ORDER BY created_at DESC LIMIT 20`,
      [accountIds]
    );
    transactions = txRes.rows;
  }

  const { password_hash, ...customerSafe } = customer.rows[0];
  res.json({ customer: customerSafe, accounts: accounts.rows, transactions });
});

// ====== PRZELEW ======
app.post('/internal/transfer', requireInternalKey, async (req, res) => {
  const { from_account_number, to_account_number, amount, title, actor } = req.body;
  const amt = parseInt(amount, 10);

  if (!from_account_number || !to_account_number || !amt || amt <= 0) {
    return res.status(400).json({ error: 'Wymagane: from_account_number, to_account_number, amount > 0.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fromRes = await client.query('SELECT * FROM accounts WHERE account_number = $1 FOR UPDATE', [from_account_number]);
    const toRes = await client.query('SELECT * FROM accounts WHERE account_number = $1 FOR UPDATE', [to_account_number]);

    if (fromRes.rows.length === 0 || toRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nie znaleziono jednego z kont.' });
    }

    const fromAcc = fromRes.rows[0];
    const toAcc = toRes.rows[0];

    if (fromAcc.status !== 'ACTIVE' || toAcc.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Jedno z kont nie jest aktywne (zamrożone/zamknięte).' });
    }
    if (Number(fromAcc.balance) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Niewystarczające środki.' });
    }

    await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id = $1', [fromAcc.account_id, amt]);
    await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id = $1', [toAcc.account_id, amt]);

    await client.query(
      `INSERT INTO bank_transactions (sender_account_id, receiver_account_id, amount, title, transaction_type)
       VALUES ($1,$2,$3,$4,'TRANSFER')`,
      [fromAcc.account_id, toAcc.account_id, amt, title || null]
    );

    await client.query('COMMIT');
    await logAction(actor || 'system', 'TRANSFER', `${from_account_number} -> ${to_account_number}`, `OK ${amt}`);

    res.json({ ok: true, new_balance_sender: Number(fromAcc.balance) - amt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Błąd przelewu.' });
  } finally {
    client.release();
  }
});

// ====== RESET HASŁA ======
app.post('/internal/customers/:id/reset-password', requireInternalKey, async (req, res) => {
  const customerId = req.params.id;
  const { actor } = req.body;

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const result = await pool.query(
    'UPDATE customers SET password_hash = $2, must_change_password = true WHERE customer_id = $1 RETURNING username',
    [customerId, passwordHash]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  await logAction(actor || 'system', 'RESET_PASSWORD', `customer_id=${customerId}`, 'OK');
  res.json({ username: result.rows[0].username, temp_password: tempPassword });
});

// ====== ZAMROŻENIE / ODBLOKOWANIE KONTA ======
app.post('/internal/accounts/:accountNumber/status', requireInternalKey, async (req, res) => {
  const { accountNumber } = req.params;
  const { status, actor } = req.body; // 'ACTIVE' | 'FROZEN' | 'CLOSED'

  if (!['ACTIVE', 'FROZEN', 'CLOSED'].includes(status)) {
    return res.status(400).json({ error: 'Nieprawidłowy status.' });
  }

  const result = await pool.query(
    'UPDATE accounts SET status = $2 WHERE account_number = $1 RETURNING account_number',
    [accountNumber, status]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono konta.' });

  await logAction(actor || 'system', 'SET_ACCOUNT_STATUS', accountNumber, status);
  res.json({ ok: true, account_number: accountNumber, status });
});

// ====== KREDYTY ======

// pracownik tworzy wniosek kredytowy (status PENDING) - jeszcze nie przyznaje kasy
app.post('/internal/loans', requireInternalKey, async (req, res) => {
  const { account_number, amount, interest_rate, actor } = req.body;
  const amt = parseInt(amount, 10);
  const rate = parseFloat(interest_rate);

  if (!account_number || !amt || amt <= 0 || isNaN(rate) || rate < 0) {
    return res.status(400).json({ error: 'Wymagane: account_number, amount > 0, interest_rate >= 0.' });
  }

  const accRes = await pool.query('SELECT * FROM accounts WHERE account_number = $1', [account_number]);
  if (accRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono konta.' });
  const account = accRes.rows[0];

  const remainingBalance = Math.round(amt * (1 + rate / 100));

  const loanRes = await pool.query(
    `INSERT INTO loans (account_id, amount, interest_rate, remaining_balance, status)
     VALUES ($1,$2,$3,$4,'PENDING') RETURNING loan_id`,
    [account.account_id, amt, rate, remainingBalance]
  );

  await logAction(actor || 'system', 'LOAN_REQUEST', `account=${account_number}`, `kwota ${amt}, oproc. ${rate}%`);
  res.json({ loan_id: loanRes.rows[0].loan_id, status: 'PENDING', remaining_balance: remainingBalance });
});

// zatwierdzenie kredytu - przelewa kwotę na konto i ustawia harmonogram spłaty
app.post('/internal/loans/:id/approve', requireInternalKey, async (req, res) => {
  const loanId = req.params.id;
  const { actor } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loanRes = await client.query('SELECT * FROM loans WHERE loan_id = $1 FOR UPDATE', [loanId]);
    if (loanRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono kredytu.' }); }
    const loan = loanRes.rows[0];
    if (loan.status !== 'PENDING') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Kredyt już ma status ${loan.status}.` }); }

    await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id = $1', [loan.account_id, loan.amount]);
    await client.query(
      `INSERT INTO bank_transactions (receiver_account_id, amount, title, transaction_type) VALUES ($1,$2,'Wypłata kredytu','LOAN')`,
      [loan.account_id, loan.amount]
    );
    await client.query(
      `UPDATE loans SET status = 'APPROVED', approved_by = $2, decided_at = now() WHERE loan_id = $1`,
      [loanId, actor || 'system']
    );

    await client.query('COMMIT');
    await logAction(actor || 'system', 'LOAN_APPROVE', `loan_id=${loanId}`, 'OK');
    res.json({ ok: true, status: 'APPROVED' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Błąd zatwierdzania kredytu.' });
  } finally {
    client.release();
  }
});

// odrzucenie kredytu
app.post('/internal/loans/:id/reject', requireInternalKey, async (req, res) => {
  const loanId = req.params.id;
  const { actor } = req.body;

  const result = await pool.query(
    `UPDATE loans SET status = 'REJECTED', approved_by = $2, decided_at = now() WHERE loan_id = $1 AND status = 'PENDING' RETURNING loan_id`,
    [loanId, actor || 'system']
  );
  if (result.rows.length === 0) return res.status(400).json({ error: 'Nie znaleziono kredytu albo już rozpatrzony.' });

  await logAction(actor || 'system', 'LOAN_REJECT', `loan_id=${loanId}`, 'OK');
  res.json({ ok: true, status: 'REJECTED' });
});

// lista oczekujących wniosków kredytowych
app.get('/internal/loans/pending', requireInternalKey, async (req, res) => {
  const result = await pool.query(
    `SELECT l.*, a.account_number, c.first_name, c.last_name
     FROM loans l
     JOIN accounts a ON a.account_id = l.account_id
     JOIN customers c ON c.customer_id = a.customer_id
     WHERE l.status = 'PENDING'
     ORDER BY l.created_at ASC`
  );
  res.json(result.rows);
});

// spłata raty kredytu
app.post('/internal/loans/:id/repay', requireInternalKey, async (req, res) => {
  const loanId = req.params.id;
  const { amount, actor } = req.body;
  const amt = parseInt(amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Wymagane: amount > 0.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loanRes = await client.query('SELECT * FROM loans WHERE loan_id = $1 FOR UPDATE', [loanId]);
    if (loanRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono kredytu.' }); }
    const loan = loanRes.rows[0];

    const accRes = await client.query('SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE', [loan.account_id]);
    const account = accRes.rows[0];
    if (Number(account.balance) < amt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Niewystarczające środki na koncie.' }); }

    const newRemaining = Math.max(0, Number(loan.remaining_balance) - amt);

    await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id = $1', [loan.account_id, amt]);
    await client.query(
      `INSERT INTO bank_transactions (sender_account_id, amount, title, transaction_type) VALUES ($1,$2,'Spłata kredytu','LOAN_REPAYMENT')`,
      [loan.account_id, amt]
    );
    await client.query(
      `UPDATE loans SET remaining_balance = $2, status = $3 WHERE loan_id = $1`,
      [loanId, newRemaining, newRemaining === 0 ? 'PAID' : loan.status]
    );

    await client.query('COMMIT');
    await logAction(actor || 'system', 'LOAN_REPAYMENT', `loan_id=${loanId}`, `${amt}, pozostało ${newRemaining}`);
    res.json({ ok: true, remaining_balance: newRemaining });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Błąd spłaty kredytu.' });
  } finally {
    client.release();
  }
});

// ====== TRANSPORTY PIENIĘDZY ======

// zgłoszenie wyjazdu transportu (np. konwój z gotówką między oddziałami)
app.post('/internal/transports', requireInternalKey, async (req, res) => {
  const { amount, route, actor } = req.body;
  const amt = parseInt(amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Wymagane: amount > 0.' });

  const result = await pool.query(
    `INSERT INTO cash_transports (amount, route, reported_by) VALUES ($1,$2,$3) RETURNING transport_id`,
    [amt, route || null, actor || 'system']
  );

  await logAction(actor || 'system', 'TRANSPORT_REPORT', `transport_id=${result.rows[0].transport_id}`, `${amt}, trasa: ${route || '-'}`);
  res.json({ transport_id: result.rows[0].transport_id, status: 'W_TRASIE' });
});

// rozstrzygnięcie transportu: DOSTARCZONY albo OKRADZIONY
app.post('/internal/transports/:id/resolve', requireInternalKey, async (req, res) => {
  const transportId = req.params.id;
  const { outcome, actor } = req.body; // 'DOSTARCZONY' | 'OKRADZIONY'

  if (!['DOSTARCZONY', 'OKRADZIONY'].includes(outcome)) {
    return res.status(400).json({ error: 'outcome musi być DOSTARCZONY lub OKRADZIONY.' });
  }

  const result = await pool.query(
    `UPDATE cash_transports SET status = $2, resolved_by = $3, resolved_at = now()
     WHERE transport_id = $1 AND status = 'W_TRASIE' RETURNING *`,
    [transportId, outcome, actor || 'system']
  );
  if (result.rows.length === 0) return res.status(400).json({ error: 'Nie znaleziono transportu albo już rozstrzygnięty.' });

  await logAction(actor || 'system', 'TRANSPORT_RESOLVE', `transport_id=${transportId}`, outcome);
  res.json({ ok: true, transport: result.rows[0] });
});

// lista aktywnych transportów (w trasie)
app.get('/internal/transports/active', requireInternalKey, async (req, res) => {
  const result = await pool.query(`SELECT * FROM cash_transports WHERE status = 'W_TRASIE' ORDER BY created_at ASC`);
  res.json(result.rows);
});

// ====== LOGOWANIE I PANEL KLIENTA (strona internetowa) ======

app.post('/customer/login', async (req, res) => {
  const { username, password } = req.body;
  const remember = req.body.remember === true; // „zapamiętaj postać na tym urządzeniu”: dłuższa sesja
  if (!username || !password) return res.status(400).json({ error: 'Wymagane: username, password.' });

  const result = await pool.query('SELECT * FROM customers WHERE username = $1', [username]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

  const customer = result.rows[0];
  const match = await bcrypt.compare(password, customer.password_hash || '');
  if (!match) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
  if (customer.status !== 'ACTIVE') return res.status(403).json({ error: 'Konto nieaktywne, skontaktuj się z bankiem.' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * (remember ? 24 * 30 : 12)); // 12 h, a przy zapamiętanej postaci 30 dni
  await pool.query('INSERT INTO sessions (token, customer_id, expires_at) VALUES ($1,$2,$3)', [token, customer.customer_id, expiresAt]);

  res.json({ token, must_change_password: customer.must_change_password });
});

// wylogowanie z telefonu (zmiana postaci): kasuje sesję, schodzi ze służby i zrywa połączenia
app.post('/customer/logout', requireCustomerAuth, async (req, res) => {
  const token = (req.header('authorization') || '').slice(7);
  if (!(req.body && req.body.keep_session === true)) await pool.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  await pool.query('INSERT INTO faction_duty_log (customer_id, faction, started_at) SELECT customer_id, faction, since FROM faction_duty WHERE customer_id=$1', [req.customerId]).catch(() => {});
  await pool.query('DELETE FROM faction_duty WHERE customer_id=$1', [req.customerId]).catch(() => {});
  dropCallsOf(req.customerId);
  const w = callSockets.get(req.customerId);
  if (w) { callSockets.delete(req.customerId); try { w.close(); } catch {} }
  res.json({ ok: true });
});

app.post('/customer/change-password', requireCustomerAuth, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Hasło musi mieć min. 6 znaków.' });

  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE customers SET password_hash = $2, must_change_password = false WHERE customer_id = $1', [req.customerId, hash]);
  res.json({ ok: true });
});

app.get('/customer/me', requireCustomerAuth, async (req, res) => {
  const customerRes = await pool.query('SELECT customer_id, first_name, last_name, status, phone_number, darkweb_unlocked, phone_on FROM customers WHERE customer_id = $1', [req.customerId]);
  const accountsRes = await pool.query('SELECT * FROM accounts WHERE customer_id = $1', [req.customerId]);
  const accountIds = accountsRes.rows.map(a => a.account_id);

  let transactions = [];
  if (accountIds.length > 0) {
    const txRes = await pool.query(
      `SELECT * FROM bank_transactions WHERE sender_account_id = ANY($1) OR receiver_account_id = ANY($1) ORDER BY created_at DESC LIMIT 15`,
      [accountIds]
    );
    transactions = txRes.rows.map(t => ({
      ...t,
      direction: accountIds.includes(t.sender_account_id) ? 'OUT' : 'IN',
    }));
  }

  const loansRes = accountIds.length > 0
    ? await pool.query('SELECT * FROM loans WHERE account_id = ANY($1) ORDER BY created_at DESC', [accountIds])
    : { rows: [] };

  res.json({ customer: customerRes.rows[0], accounts: accountsRes.rows, transactions, loans: loansRes.rows });
});

app.post('/customer/transfer', requireCustomerAuth, async (req, res) => {
  const { to_account_number, amount, title } = req.body;
  const amt = parseInt(amount, 10);
  if (!to_account_number || !amt || amt <= 0) return res.status(400).json({ error: 'Wymagane: to_account_number, amount > 0.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fromRes = await client.query('SELECT * FROM accounts WHERE customer_id = $1 FOR UPDATE', [req.customerId]);
    if (fromRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie masz konta.' }); }
    const fromAcc = fromRes.rows[0];

    const toRes = await client.query('SELECT * FROM accounts WHERE account_number = $1 FOR UPDATE', [to_account_number]);
    if (toRes.rows.length === 0) {
      // numer konta frakcji / banku państwa (AFB-GOV-xxxx)
      const holder = await treasury.byNumber(client, to_account_number);
      if (holder) {
        if (fromAcc.status !== 'ACTIVE') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Twoje konto nie jest aktywne.' }); }
        if (Number(fromAcc.balance) < amt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Niewystarczające środki.' }); }
        await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id = $1', [fromAcc.account_id, amt]);
        await treasury.credit(client, holder, amt, 'PRZELEW', title || 'Przelew od klienta', req.customerId);
        await client.query(`INSERT INTO bank_transactions (sender_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'TRANSFER')`, [fromAcc.account_id, amt, `${treasury.LABEL[holder]}: ${title || 'przelew'}`]);
        await client.query('COMMIT');
        return res.json({ ok: true, new_balance: Number(fromAcc.balance) - amt });
      }
      await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono konta odbiorcy.' });
    }
    const toAcc = toRes.rows[0];

    if (fromAcc.status !== 'ACTIVE' || toAcc.status !== 'ACTIVE') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Jedno z kont nie jest aktywne.' }); }
    if (Number(fromAcc.balance) < amt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Niewystarczające środki.' }); }
    if (fromAcc.account_id === toAcc.account_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nie możesz przelać sam sobie.' }); }

    await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id = $1', [fromAcc.account_id, amt]);
    await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id = $1', [toAcc.account_id, amt]);
    await client.query(
      `INSERT INTO bank_transactions (sender_account_id, receiver_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,$4,'TRANSFER')`,
      [fromAcc.account_id, toAcc.account_id, amt, title || null]
    );

    await client.query('COMMIT');
    res.json({ ok: true, new_balance: Number(fromAcc.balance) - amt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Błąd przelewu.' });
  } finally {
    client.release();
  }
});

// ====== TWITTER ======

app.post('/customer/tweets', requireCustomerAuth, async (req, res) => {
  const { content, image } = req.body;
  if ((!content || content.trim().length === 0) && !image) return res.status(400).json({ error: 'Dodaj treść albo zdjęcie.' });
  if (content && content.length > 280) return res.status(400).json({ error: 'Maksymalnie 280 znaków.' });
  if (image && image.length > 700000) return res.status(400).json({ error: 'Zdjęcie jest za duże.' });

  const result = await pool.query(
    'INSERT INTO tweets (customer_id, content, image) VALUES ($1,$2,$3) RETURNING tweet_id, created_at',
    [req.customerId, (content || '').trim(), image || null]
  );
  res.json({ tweet_id: result.rows[0].tweet_id, created_at: result.rows[0].created_at });
});

app.get('/customer/tweets', requireCustomerAuth, async (req, res) => {
  const byUser = req.query.customer_id;
  const result = await pool.query(
    `SELECT t.tweet_id, t.content, t.image, t.created_at, c.first_name, c.last_name, c.customer_id,
            (SELECT COUNT(*) FROM tweet_likes tl WHERE tl.tweet_id = t.tweet_id) AS like_count,
            (SELECT COUNT(*) FROM tweet_comments tc WHERE tc.tweet_id = t.tweet_id) AS comment_count,
            EXISTS(SELECT 1 FROM tweet_likes tl2 WHERE tl2.tweet_id = t.tweet_id AND tl2.customer_id = $1) AS liked_by_me
     FROM tweets t JOIN customers c ON c.customer_id = t.customer_id
     ${byUser ? 'WHERE t.customer_id = $2' : ''}
     ORDER BY t.created_at DESC LIMIT 50`,
    byUser ? [req.customerId, byUser] : [req.customerId]
  );
  res.json(result.rows);
});

app.post('/customer/tweets/:id/like', requireCustomerAuth, async (req, res) => {
  const tweetId = req.params.id;
  const existing = await pool.query('SELECT 1 FROM tweet_likes WHERE tweet_id = $1 AND customer_id = $2', [tweetId, req.customerId]);
  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM tweet_likes WHERE tweet_id = $1 AND customer_id = $2', [tweetId, req.customerId]);
    res.json({ liked: false });
  } else {
    await pool.query('INSERT INTO tweet_likes (tweet_id, customer_id) VALUES ($1,$2)', [tweetId, req.customerId]);
    res.json({ liked: true });
  }
});

app.get('/customer/tweets/:id/comments', requireCustomerAuth, async (req, res) => {
  const tweetId = req.params.id;
  const result = await pool.query(
    `SELECT tc.comment_id, tc.content, tc.created_at, tc.parent_comment_id, c.first_name, c.last_name, c.customer_id,
            (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = tc.comment_id) AS like_count,
            EXISTS(SELECT 1 FROM comment_likes cl2 WHERE cl2.comment_id = tc.comment_id AND cl2.customer_id = $1) AS liked_by_me
     FROM tweet_comments tc JOIN customers c ON c.customer_id = tc.customer_id
     WHERE tc.tweet_id = $2 ORDER BY tc.created_at ASC`,
    [req.customerId, tweetId]
  );
  res.json(result.rows);
});

app.post('/customer/tweets/:id/comments', requireCustomerAuth, async (req, res) => {
  const tweetId = req.params.id;
  const { content, parent_comment_id } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Treść komentarza nie może być pusta.' });

  const result = await pool.query(
    'INSERT INTO tweet_comments (tweet_id, customer_id, parent_comment_id, content) VALUES ($1,$2,$3,$4) RETURNING comment_id, created_at',
    [tweetId, req.customerId, parent_comment_id || null, content.trim()]
  );
  res.json(result.rows[0]);
});

app.post('/customer/comments/:id/like', requireCustomerAuth, async (req, res) => {
  const commentId = req.params.id;
  const existing = await pool.query('SELECT 1 FROM comment_likes WHERE comment_id = $1 AND customer_id = $2', [commentId, req.customerId]);
  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM comment_likes WHERE comment_id = $1 AND customer_id = $2', [commentId, req.customerId]);
    res.json({ liked: false });
  } else {
    await pool.query('INSERT INTO comment_likes (comment_id, customer_id) VALUES ($1,$2)', [commentId, req.customerId]);
    res.json({ liked: true });
  }
});

app.get('/customer/profile/:customerId', requireCustomerAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT customer_id, first_name, last_name, phone_number,
            (SELECT COUNT(*) FROM tweets WHERE customer_id = customers.customer_id) AS tweet_count
     FROM customers WHERE customer_id = $1`,
    [req.params.customerId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono profilu.' });
  res.json(result.rows[0]);
});

// ====== KONTAKTY ======

app.get('/customer/contacts', requireCustomerAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT co.contact_customer_id, co.label, c.phone_number, c.first_name, c.last_name
     FROM contacts co JOIN customers c ON c.customer_id = co.contact_customer_id
     WHERE co.customer_id = $1 ORDER BY co.label ASC`,
    [req.customerId]
  );
  // numery fabryczne (911, DOT) – zawsze na górze listy, nie da się ich usunąć
  const phones = Object.keys(factions.SERVICE_NUMBERS);
  const sys = await pool.query('SELECT customer_id, first_name, last_name, phone_number FROM customers WHERE phone_number = ANY($1)', [phones]);
  const systemRows = phones.map((p) => sys.rows.find((r) => r.phone_number === p)).filter(Boolean).map((r) => ({
    contact_customer_id: r.customer_id, label: `${r.first_name} ${r.last_name}`.trim(), phone_number: r.phone_number,
    first_name: r.first_name, last_name: r.last_name, system: true,
  }));
  res.json([...systemRows, ...result.rows.filter((r) => !phones.includes(r.phone_number))]);
});

app.post('/customer/contacts', requireCustomerAuth, async (req, res) => {
  const { phone_number, label } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'Wymagany numer telefonu.' });

  const target = await pool.query('SELECT customer_id, first_name, last_name FROM customers WHERE phone_number = $1', [phone_number]);
  if (target.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono numeru.' });
  const targetCustomer = target.rows[0];
  if (targetCustomer.customer_id === req.customerId) return res.status(400).json({ error: 'Nie możesz dodać samego siebie.' });

  await pool.query(
    `INSERT INTO contacts (customer_id, contact_customer_id, label) VALUES ($1,$2,$3)
     ON CONFLICT (customer_id, contact_customer_id) DO UPDATE SET label = EXCLUDED.label`,
    [req.customerId, targetCustomer.customer_id, label || `${targetCustomer.first_name} ${targetCustomer.last_name}`]
  );
  res.json({ ok: true });
});

// ====== WIADOMOŚCI ======

app.get('/customer/messages/conversations', requireCustomerAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT DISTINCT ON (other_id) other_id, content, created_at, direction FROM (
       SELECT to_customer_id AS other_id, content, created_at, 'OUT' AS direction FROM messages WHERE from_customer_id = $1
       UNION ALL
       SELECT from_customer_id AS other_id, content, created_at, 'IN' AS direction FROM messages WHERE to_customer_id = $1
     ) t
     ORDER BY other_id, created_at DESC`,
    [req.customerId]
  );

  const withNames = await Promise.all(result.rows.map(async (r) => {
    const c = await pool.query('SELECT first_name, last_name, phone_number FROM customers WHERE customer_id = $1', [r.other_id]);
    return { ...r, contact: c.rows[0] };
  }));

  withNames.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(withNames);
});

app.get('/customer/messages/:otherCustomerId', requireCustomerAuth, async (req, res) => {
  const otherId = req.params.otherCustomerId;
  const result = await pool.query(
    `SELECT * FROM messages
     WHERE (from_customer_id = $1 AND to_customer_id = $2) OR (from_customer_id = $2 AND to_customer_id = $1)
     ORDER BY created_at ASC LIMIT 100`,
    [req.customerId, otherId]
  );
  await pool.query(`UPDATE messages SET read_at = now() WHERE to_customer_id = $1 AND from_customer_id = $2 AND read_at IS NULL`, [req.customerId, otherId]);
  res.json(result.rows);
});

app.post('/customer/messages', requireCustomerAuth, async (req, res) => {
  const { to_customer_id } = req.body;
  const content = String(req.body.content || '').trim();
  let to_phone_number = req.body.to_phone_number;
  if ((!to_phone_number && !to_customer_id) || !content) return res.status(400).json({ error: 'Wymagane: odbiorca i treść.' });
  if (content.length > 500) return res.status(400).json({ error: 'Wiadomość jest za długa (max 500 znaków).' });

  const target = to_customer_id
    ? await pool.query('SELECT customer_id, phone_number FROM customers WHERE customer_id = $1', [to_customer_id])
    : await pool.query('SELECT customer_id, phone_number FROM customers WHERE phone_number = $1', [to_phone_number]);
  if (target.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono numeru.' });
  const toId = target.rows[0].customer_id;
  to_phone_number = target.rows[0].phone_number;
  if (toId === req.customerId) return res.status(400).json({ error: 'Nie możesz napisać do siebie.' });

  const result = await pool.query(
    'INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3) RETURNING message_id, created_at',
    [req.customerId, toId, content]
  );

  // ===== sekretna wiadomosc do NPC odblokowuje darkweb =====
  if (to_phone_number === DARKWEB_NPC_PHONE) {
    const alreadyUnlocked = await pool.query('SELECT darkweb_unlocked FROM customers WHERE customer_id = $1', [req.customerId]);
    const isUnlocked = alreadyUnlocked.rows[0]?.darkweb_unlocked;

    if (content.toLowerCase().trim() === DARKWEB_SECRET_PHRASE && !isUnlocked) {
      await pool.query('UPDATE customers SET darkweb_unlocked = true WHERE customer_id = $1', [req.customerId]);
      await pool.query(
        'INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3)',
        [toId, req.customerId, 'Wiem kim jesteś. Teraz wiesz gdzie szukać. Nie zawiedź mnie.']
      );
    } else if (!isUnlocked) {
      await pool.query(
        'INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3)',
        [toId, req.customerId, '...']
      );
    }
  }

  if (factions.SERVICE_NUMBERS[to_phone_number]) {
    await pool.query(
      'INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3)',
      [toId, req.customerId, 'Ten numer obsługuje tylko połączenia głosowe. Zadzwoń, a dyżurny odbierze, jeśli jest na służbie.']);
  }

  res.json({ message_id: result.rows[0].message_id, created_at: result.rows[0].created_at, to_customer_id: toId });
});

factions.register(app, { pool, requireCustomerAuth, requireInternalKey });
ops.register(app, { pool, requireCustomerAuth });
shop.register(app, { pool, requireCustomerAuth, requireInternalKey });
backpack.register(app, { pool, requireCustomerAuth, requireInternalKey });
mdt.register(app, { pool, requireCustomerAuth, requireInternalKey });

// ====== SERWER SYGNALIZACYJNY WEBRTC (dzwonienie) ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/call-signal' });

const callSockets = new Map(); // customerId -> ws
const calls = new Map();       // callId -> { caller, targets:Set, answered, timer, service }
const RING_TIMEOUT_MS = 45000;

const isOnline = (id) => { const w = callSockets.get(id); return !!(w && w.readyState === 1); };
const sendTo = (id, payload) => { const w = callSockets.get(id); if (w && w.readyState === 1) w.send(JSON.stringify(payload)); };

function endCall(callId) {
  const c = calls.get(callId);
  if (!c) return;
  clearTimeout(c.timer);
  calls.delete(callId);
}

// czyści połączenia, w których uczestniczył klient (rozłączenie gniazda / wyłączenie telefonu)
function dropCallsOf(customerId) {
  for (const [callId, c] of [...calls]) {
    if (c.caller === customerId) {
      c.targets.forEach((t) => sendTo(t, { type: 'call-hangup', callId }));
      endCall(callId);
    } else if (c.targets.has(customerId)) {
      if (c.answered === customerId) { sendTo(c.caller, { type: 'call-hangup', callId }); endCall(callId); }
      else {
        c.targets.delete(customerId);
        if (!c.answered && c.targets.size === 0) { sendTo(c.caller, { type: 'call-error', callId, error: 'Abonent niedostępny.' }); endCall(callId); }
      }
    }
  }
}

// serwery ICE dla rozmów (STUN + opcjonalnie TURN z env: TURN_URL, TURN_USERNAME, TURN_CREDENTIAL)
app.get('/customer/ice-servers', requireCustomerAuth, (req, res) => {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map(x => x.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  res.json({ iceServers: servers });
});

// zamknięcie aplikacji telefonu (jak „wyjdź z gry”): zejście ze służby i zerwanie połączeń, ale telefon NIE zostaje „wyłączony” na stałe
app.post('/customer/phone/close', requireCustomerAuth, async (req, res) => {
  await pool.query('INSERT INTO faction_duty_log (customer_id, faction, started_at) SELECT customer_id, faction, since FROM faction_duty WHERE customer_id=$1', [req.customerId]).catch(() => {});
  await pool.query('DELETE FROM faction_duty WHERE customer_id=$1', [req.customerId]).catch(() => {});
  dropCallsOf(req.customerId);
  const w = callSockets.get(req.customerId);
  if (w) { callSockets.delete(req.customerId); try { w.close(); } catch {} }
  res.json({ ok: true });
});

app.post('/customer/phone/power', requireCustomerAuth, async (req, res) => {
  const on = !!req.body.on;
  await pool.query('UPDATE customers SET phone_on = $2 WHERE customer_id = $1', [req.customerId, on]);
  if (!on) {
    // wyłączony telefon = zejście ze służby (z zapisem czasu)
    await pool.query('INSERT INTO faction_duty_log (customer_id, faction, started_at) SELECT customer_id, faction, since FROM faction_duty WHERE customer_id=$1', [req.customerId]).catch(() => {});
    await pool.query('DELETE FROM faction_duty WHERE customer_id=$1', [req.customerId]).catch(() => {});
    dropCallsOf(req.customerId);
    const w = callSockets.get(req.customerId);
    if (w) { callSockets.delete(req.customerId); try { w.close(); } catch {} }
  }
  res.json({ ok: true, phone_on: on });
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) { ws.close(); return; }

  const sessionRes = await pool.query(
    `SELECT s.customer_id, s.expires_at, c.phone_on FROM sessions s JOIN customers c ON c.customer_id = s.customer_id WHERE s.token = $1`, [token]);
  if (sessionRes.rows.length === 0 || new Date(sessionRes.rows[0].expires_at) < new Date()) { ws.close(); return; }
  if (sessionRes.rows[0].phone_on === false) { ws.close(); return; } // wyłączony telefon nie odbiera niczego

  const customerId = sessionRes.rows[0].customer_id;
  const old = callSockets.get(customerId);
  if (old && old !== ws) { try { old.close(); } catch {} }
  callSockets.set(customerId, ws);
  ws.customerId = customerId;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'call-offer') {
        if (!msg.toPhoneNumber) return;
        const phone = String(msg.toPhoneNumber);
        let targetIds;
        const service = !!factions.SERVICE_NUMBERS[phone];
        if (service) {
          targetIds = await factions.dutyMembers(pool, phone, isOnline, customerId);
          if (!targetIds.length) { ws.send(JSON.stringify({ type: 'call-error', error: 'Brak dyżurnych na służbie.' })); return; }
        } else {
          const t = await pool.query('SELECT customer_id FROM customers WHERE phone_number = $1', [phone]);
          if (!t.rows.length) { ws.send(JSON.stringify({ type: 'call-error', error: 'Nie znaleziono numeru.' })); return; }
          if (t.rows[0].customer_id === customerId) { ws.send(JSON.stringify({ type: 'call-error', error: 'Nie możesz zadzwonić do siebie.' })); return; }
          if (!isOnline(t.rows[0].customer_id)) { ws.send(JSON.stringify({ type: 'call-error', error: 'Abonent niedostępny.' })); return; }
          targetIds = [t.rows[0].customer_id];
        }
        // jeden aktywny telefon na raz: zajęty abonent = sygnał zajętości
        const busy = new Set();
        for (const c of calls.values()) { if (c.answered) { busy.add(c.caller); busy.add(c.answered); } }
        targetIds = targetIds.filter((id) => !busy.has(id));
        if (!targetIds.length) { ws.send(JSON.stringify({ type: 'call-error', error: service ? 'Wszyscy dyżurni są zajęci.' : 'Abonent zajęty.' })); return; }

        const callId = crypto.randomBytes(8).toString('hex');
        const call = { caller: customerId, targets: new Set(targetIds), answered: null, service };
        call.timer = setTimeout(() => {
          const c = calls.get(callId);
          if (!c || c.answered) return;
          sendTo(c.caller, { type: 'call-error', callId, error: 'Brak odpowiedzi.' });
          c.targets.forEach((t) => sendTo(t, { type: 'call-hangup', callId }));
          endCall(callId);
        }, RING_TIMEOUT_MS);
        calls.set(callId, call);

        const callerRes = await pool.query('SELECT first_name, last_name, phone_number FROM customers WHERE customer_id = $1', [customerId]);
        ws.send(JSON.stringify({ type: 'call-ringing', callId }));
        targetIds.forEach((t) => sendTo(t, { type: 'call-offer', callId, offer: msg.offer, fromCustomerId: customerId, fromCaller: callerRes.rows[0], viaNumber: service ? phone : null }));
        return;
      }

      const call = calls.get(msg.callId);
      if (!call) return;

      if (msg.type === 'call-answer') {
        if (!call.targets.has(customerId)) return;
        if (call.answered) { sendTo(customerId, { type: 'call-taken', callId: msg.callId }); return; } // ktoś był szybszy
        call.answered = customerId;
        clearTimeout(call.timer);
        sendTo(call.caller, { type: 'call-answer', callId: msg.callId, answer: msg.answer, fromCustomerId: customerId });
        call.targets.forEach((t) => { if (t !== customerId) sendTo(t, { type: 'call-taken', callId: msg.callId }); });
        call.targets = new Set([customerId]);
        return;
      }

      if (msg.type === 'ice-candidate') {
        if (customerId === call.caller) {
          const dest = call.answered ? [call.answered] : [...call.targets];
          dest.forEach((t) => sendTo(t, { type: 'ice-candidate', callId: msg.callId, candidate: msg.candidate }));
        } else if (call.answered === customerId) {
          sendTo(call.caller, { type: 'ice-candidate', callId: msg.callId, candidate: msg.candidate });
        }
        return;
      }

      if (msg.type === 'call-hangup') {
        if (customerId === call.caller) {
          call.targets.forEach((t) => sendTo(t, { type: 'call-hangup', callId: msg.callId }));
          endCall(msg.callId);
        } else if (call.targets.has(customerId)) {
          if (call.answered === customerId) { sendTo(call.caller, { type: 'call-hangup', callId: msg.callId }); endCall(msg.callId); }
          else {
            call.targets.delete(customerId); // odrzucenie dzwoniącego połączenia – reszta dyżurnych dzwoni dalej
            if (!call.answered && call.targets.size === 0) { sendTo(call.caller, { type: 'call-error', callId: msg.callId, error: 'Połączenie odrzucone.' }); endCall(msg.callId); }
          }
        }
      }
    } catch (err) { console.error('Błąd sygnalizacji połączeń:', err.message); }
  });

  ws.on('close', () => {
    if (callSockets.get(customerId) === ws) { callSockets.delete(customerId); dropCallsOf(customerId); }
  });
});

// ====== SKLEP / DARKWEB ======

app.get('/internal/shop/orders/pending', requireInternalKey, async (req, res) => {
  const result = await pool.query(
    `SELECT o.*, c.first_name, c.last_name, c.discord_user_id
     FROM shop_orders o JOIN customers c ON c.customer_id = o.customer_id
     WHERE o.status = 'OCZEKUJE' AND o.category = 'sklep' ORDER BY o.created_at ASC`
  );
  res.json(result.rows);
});

app.post('/internal/shop/orders/:id/fulfill', requireInternalKey, async (req, res) => {
  const { actor } = req.body;
  const result = await pool.query(
    `UPDATE shop_orders SET status = 'ZREALIZOWANE', fulfilled_by = $2, fulfilled_at = now()
     WHERE order_id = $1 AND status = 'OCZEKUJE' AND category = 'sklep' RETURNING *`,
    [req.params.id, actor || 'system']
  );
  if (result.rows.length === 0) return res.status(400).json({ error: 'Nie znaleziono zamówienia albo już zrealizowane.' });
  res.json({ ok: true, order: result.rows[0] });
});

// ====== START SERWERA ======
const PORT = process.env.PORT || 3001;
initDb().then(async () => {
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_on BOOLEAN NOT NULL DEFAULT true');
  await migrateSsnPool();
  await factions.migrate(pool);
  await ops.migrate(pool);
  await treasury.migrate(pool);
  await shop.migrate(pool);
  await backpack.migrate(pool);
  await mdt.migrate(pool);
  await shop.ensureShopContact(pool);
  shop.startDelivery(pool);
  await factions.ensureServiceContacts(pool);
  await ensureNpcContact();
  server.listen(PORT, () => console.log(`Avaloria API (+ sygnalizacja połączeń) działa na porcie ${PORT}`));
});
