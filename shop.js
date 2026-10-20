// Sklep, darkweb (krypto AVC + zlecenia między graczami), zdrapki.
// To gra RP: przedmioty są fikcyjnymi towarami; wydaje je ekipa w RP komendą z Discorda, zdrapki losują się od razu.
const crypto = require('crypto');
const treasury = require('./treasury.js');

const CRYPTO_RATE_USD = parseFloat(process.env.CRYPTO_RATE_USD || '10'); // 1 AVC = tyle $
const CRYPTO_FEE_PCT = parseFloat(process.env.CRYPTO_FEE_PCT || '5');     // prowizja kantoru w każdą stronę
const CONTRACT_MIN_REWARD = parseInt(process.env.CONTRACT_MIN_REWARD || '50', 10); // AVC
const MAX_TAKEN_CONTRACTS = parseInt(process.env.MAX_TAKEN_CONTRACTS || '2', 10);
// powiadomienia: sklep -> kanał banku; darkweb -> OSOBNY webhook dla administracji/opiekuna crime (bez fallbacku na webhook banku)
const DELIVERY_DELAY_SECONDS = parseInt(process.env.DELIVERY_DELAY_SECONDS || '120', 10); // po tylu sekundach zamówienie samo trafia do gracza
const SHOP_PHONE = '555-0400';
const NPC_PHONE = '666-0000';
const WEBHOOK = process.env.DISCORD_ORDERS_WEBHOOK_URL || null;
const DARKWEB_WEBHOOK = process.env.DISCORD_DARKWEB_WEBHOOK_URL || null;

// ====== KATALOGI (edytuj swobodnie) ======
const CATALOG = {
  sklep: {
    currency: 'USD',
    items: [
      { id: 'prawo-jazdy', group: 'Dokumenty', name: 'Prawo jazdy', price: 1500, once: true, bound: true, desc: 'Egzamin zdany? Dokument wydaje urząd po zamówieniu.' },
      { id: 'dron', group: 'Sprzęt', name: 'Dron', price: 3500, desc: 'Dron z kamerą, zasięg ok. 500 m.' },
      { id: 'mlotek', group: 'Narzędzia', name: 'Młotek', price: 120, desc: 'Solidny młotek stolarski.' },
      { id: 'kij-bejsbolowy', group: 'Narzędzia', name: 'Kij bejsbolowy', price: 250, desc: 'Drewniany kij bejsbolowy.' },
      { id: 'lom', group: 'Narzędzia', name: 'Łom', price: 180, desc: 'Stalowy łom 60 cm.' },
      { id: 'czesci-silnik', group: 'Pojazdy', name: 'Części silnikowe (naprawa)', price: 1200, desc: 'Zestaw części do naprawy pojazdu służbowego lub cywilnego.' },
      { id: 'opony', group: 'Pojazdy', name: 'Komplet opon', price: 800, desc: 'Cztery opony, montaż we własnym zakresie.' },
      { id: 'radio-sluzbowe', group: 'Sprzęt', name: 'Radio służbowe (zapasowe)', price: 450, desc: 'Dodatkowa jednostka radiowa dla frakcji.' },
      { id: 'kamizelka', group: 'Sprzęt', name: 'Kamizelka kuloodporna', price: 1500, desc: 'Standardowe wyposażenie ochronne.' },
      // zdrapki: losowanie od razu po zakupie; prize = [kwota $, szansa %]
      { id: 'zdrapka-mala', group: 'Zdrapki', name: 'Zdrapka „Szczęściarz"', price: 100, instant: 'scratch', desc: 'Główna wygrana 2 000 $.',
        prizes: [[0, 60], [100, 25], [200, 10], [500, 4.5], [2000, 0.5]] },
      { id: 'zdrapka-zlota', group: 'Zdrapki', name: 'Zdrapka „Złoto"', price: 500, instant: 'scratch', desc: 'Główna wygrana 10 000 $.',
        prizes: [[0, 65], [500, 20], [1000, 9], [2500, 5], [10000, 1]] },
      { id: 'zdrapka-diament', group: 'Zdrapki', name: 'Zdrapka „Diament"', price: 2000, instant: 'scratch', desc: 'Główna wygrana 50 000 $.',
        prizes: [[0, 70], [2000, 18], [5000, 8], [10000, 3.5], [50000, 0.5]] },
    ],
  },
  darkweb: {
    currency: 'AVC',
    items: [
      { id: 'marihuana', consumable: true, group: 'Substancje', name: 'Marihuana', unit: 'torebka', price: 15, desc: 'Towar rekreacyjny. Bez gwarancji jakości.' },
      { id: 'heroina', consumable: true, group: 'Substancje', name: 'Heroina', unit: 'działka', price: 60, desc: 'Wysokie ryzyko. Dla stałych klientów.' },
      { id: 'kwas', consumable: true, group: 'Substancje', name: 'Kwas (LSD)', unit: 'znaczek', price: 35, desc: 'Znaczki, partia sprawdzona.' },
      { id: 'fentanyl', consumable: true, group: 'Substancje', name: 'Fentanyl', unit: 'dawka', price: 90, desc: 'Bardzo niebezpieczny. Sprzedajemy na własną odpowiedzialność.' },
      { id: 'pistolet', group: 'Broń', name: 'Pistolet (nielegalny)', price: 350, desc: 'Bez numeru seryjnego. Towar wysokiego ryzyka.' },
      { id: 'amunicja', consumable: true, group: 'Broń', name: 'Amunicja (skrzynka)', price: 90, desc: '50 sztuk, mieszany kaliber.' },
      { id: 'kamizelka-nielegalna', group: 'Broń', name: 'Kamizelka taktyczna (czarny rynek)', price: 220, desc: 'Lepsza ochrona, zero pytań.' },
      { id: 'urzadzenie-hakerskie', group: 'Sprzęt', name: 'Urządzenie hakerskie', price: 500, once: false, desc: 'Przenośny zestaw do włamań do sieci i zamków elektronicznych.' },
      { id: 'bomba', consumable: true, group: 'Sprzęt', name: 'Bomba', price: 900, desc: 'Ładunek z zapalnikiem czasowym. Używać z głową.' },
      { id: 'wycinarka-szkla', group: 'Sprzęt', name: 'Wycinarka do szkła', price: 180, desc: 'Cicha, szybka, nie zostawia śladów.' },
    ],
  },
};

const ok = (v) => Number.isFinite(v) && v > 0;
const money = (n) => `${Number(n).toLocaleString('pl-PL')}$`;

function rollPrize(prizes) {
  // crypto.randomInt na setnych procenta - uczciwe losowanie po stronie serwera
  const r = crypto.randomInt(0, 10000) / 100;
  let acc = 0;
  for (const [amount, chance] of prizes) { acc += chance; if (r < acc) return amount; }
  return prizes[0][0];
}

async function migrate(pool) {
  await pool.query(`ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crypto_wallets (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(customer_id),
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crypto_ledger (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    amount BIGINT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contracts (
    contract_id SERIAL PRIMARY KEY,
    poster_id INTEGER NOT NULL REFERENCES customers(customer_id),
    target_name TEXT NOT NULL,
    target_customer_id INTEGER REFERENCES customers(customer_id),
    description TEXT NOT NULL,
    reward BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    taker_id INTEGER REFERENCES customers(customer_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    taken_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    closed_by TEXT
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS contracts_status_idx ON contracts(status)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS darkchat_handles (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(customer_id),
    handle TEXT NOT NULL,
    renamed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS darkchat_handle_uq ON darkchat_handles (lower(handle))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS darkchat (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    handle TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS item_id TEXT`);
  await pool.query(`ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory (
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    item_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    category TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 0),
    PRIMARY KEY (customer_id, item_id)
  )`);
}

// kontakt „Sklep Avaloria”, z którego przychodzą powiadomienia o dostawie
async function ensureShopContact(pool) {
  const ex = await pool.query('SELECT customer_id FROM customers WHERE phone_number = $1', [SHOP_PHONE]);
  if (ex.rows.length) return;
  const hash = await require('bcryptjs').hash(crypto.randomBytes(16).toString('hex'), 10);
  await pool.query(`INSERT INTO customers (first_name, last_name, username, password_hash, phone_number, status, must_change_password)
    VALUES ('Sklep','Avaloria','svc_sklep',$1,$2,'ACTIVE',false)`, [hash, SHOP_PHONE]);
}

// automatyczna dostawa: zamówienia starsze niż DELIVERY_DELAY_SECONDS są dostarczane i gracz dostaje wiadomość
async function deliverDue(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `UPDATE shop_orders SET status='ZREALIZOWANE', fulfilled_by='dostawa automatyczna', fulfilled_at=now()
       WHERE order_id IN (SELECT order_id FROM shop_orders WHERE status='OCZEKUJE' AND created_at <= now() - ($1 || ' seconds')::interval FOR UPDATE SKIP LOCKED)
       RETURNING order_id, customer_id, category, item_name, item_id, qty`, [String(DELIVERY_DELAY_SECONDS)]);
    if (due.rows.length) {
      const senders = {};
      for (const ph of [SHOP_PHONE, NPC_PHONE]) {
        const r = await client.query('SELECT customer_id FROM customers WHERE phone_number = $1', [ph]);
        senders[ph] = r.rows[0]?.customer_id;
      }
      for (const o of due.rows) {
        const dark = o.category === 'darkweb';
        const def = o.item_id && CATALOG[dark ? 'darkweb' : 'sklep'].items.find((i) => i.id === o.item_id);
        if (def) {
          await client.query(`INSERT INTO inventory (customer_id, item_id, item_name, category, qty) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (customer_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`, [o.customer_id, def.id, def.name, o.category, o.qty || 1]);
        }
        const from = senders[dark ? NPC_PHONE : SHOP_PHONE];
        if (!from) continue;
        const text = dark
          ? `Towar czeka na Ciebie: ${o.item_name} (zam. #${o.order_id}). Masz to w aplikacji Plecak. Żadnych pytań.`
          : `📦 Zamówienie #${o.order_id}: ${o.item_name} - dostarczone. Znajdziesz to w aplikacji Plecak.`;
        await client.query('INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3)', [from, o.customer_id, text]);
      }
    }
    await client.query('COMMIT');
    return due.rows.length;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('[dostawa]', e.message); return 0; }
  finally { client.release(); }
}
function startDelivery(pool) {
  setInterval(() => deliverDue(pool), 15000).unref?.();
  console.log(`Automatyczna dostawa zamówień po ${DELIVERY_DELAY_SECONDS}s.`);
}

async function addCrypto(db, customerId, amount, reason) {
  await db.query('INSERT INTO crypto_wallets (customer_id, balance) VALUES ($1, 0) ON CONFLICT (customer_id) DO NOTHING', [customerId]);
  const r = await db.query('UPDATE crypto_wallets SET balance = balance + $2 WHERE customer_id = $1 RETURNING balance', [customerId, amount]);
  await db.query('INSERT INTO crypto_ledger (customer_id, amount, reason) VALUES ($1,$2,$3)', [customerId, amount, reason]);
  return Number(r.rows[0].balance);
}
// zwraca nowe saldo albo null gdy brak środków
async function spendCrypto(db, customerId, amount, reason) {
  await db.query('INSERT INTO crypto_wallets (customer_id, balance) VALUES ($1, 0) ON CONFLICT (customer_id) DO NOTHING', [customerId]);
  const w = await db.query('SELECT balance FROM crypto_wallets WHERE customer_id = $1 FOR UPDATE', [customerId]);
  if (Number(w.rows[0].balance) < amount) return null;
  return addCrypto(db, customerId, -amount, reason);
}

function register(app, { pool, requireCustomerAuth, requireInternalKey }) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Błąd serwera.' }); });
  const notify = (text, kind = 'darkweb') => { const url = kind === 'sklep' ? WEBHOOK : DARKWEB_WEBHOOK; if (url) fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) }).catch(() => {}); };
  const who = async (id) => { const c = (await pool.query('SELECT first_name, last_name FROM customers WHERE customer_id = $1', [id])).rows[0]; return c ? `${c.first_name} ${c.last_name}` : `#${id}`; };

  const guard = () => async (req, res, next) => {
    try {
      const c = await pool.query('SELECT darkweb_unlocked FROM customers WHERE customer_id = $1', [req.customerId]);
      if (!c.rows[0]?.darkweb_unlocked) return res.status(403).json({ error: 'Brak dostępu.' });
      next();
    } catch (err) { console.error(err); res.status(500).json({ error: 'Błąd serwera.' }); }
  };

  const getAccount = async (db, customerId, lock = true) => {
    const r = await db.query(`SELECT * FROM accounts WHERE customer_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [customerId]);
    return r.rows[0];
  };
  const accountProblem = (acc) => !acc ? 'Nie masz konta bankowego.' : (acc.status && acc.status !== 'ACTIVE' ? 'Twoje konto jest zablokowane.' : null);

  // ---------- KATALOG ----------
  app.get('/customer/shop/catalog', requireCustomerAuth, wrap(async (req, res, next) => {
    const category = req.query.category === 'darkweb' ? 'darkweb' : 'sklep';
    if (category === 'darkweb') {
      const c = await pool.query('SELECT darkweb_unlocked FROM customers WHERE customer_id = $1', [req.customerId]);
      if (!c.rows[0]?.darkweb_unlocked) return res.status(403).json({ error: 'Brak dostępu.' });
    }
    const cat = CATALOG[category];
    res.json({ currency: cat.currency, items: cat.items.map(({ prizes, ...i }) => i) });
  }));

  // ---------- ZAKUP ----------
  app.post('/customer/shop/buy', requireCustomerAuth, wrap(async (req, res) => {
    const category = req.body.category === 'darkweb' ? 'darkweb' : 'sklep';
    const cat = CATALOG[category];
    const item = cat.items.find((i) => i.id === req.body.item_id);
    if (!item) return res.status(404).json({ error: 'Nie znaleziono produktu.' });
    if (category === 'darkweb') {
      const c = await pool.query('SELECT darkweb_unlocked FROM customers WHERE customer_id = $1', [req.customerId]);
      if (!c.rows[0]?.darkweb_unlocked) return res.status(403).json({ error: 'Brak dostępu.' });
    }
    const qty = item.once || item.instant ? 1 : Math.min(10, Math.max(1, parseInt(req.body.qty, 10) || 1));
    const total = item.price * qty;
    const label = qty > 1 ? `${item.name} ×${qty}` : item.name;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['buy:' + req.customerId]); // brak podwójnych zakupów z równoległych kliknięć
      if (item.once) {
        const dup = await client.query(`SELECT 1 FROM shop_orders WHERE customer_id = $1 AND item_name = $2 AND status IN ('OCZEKUJE','ZREALIZOWANE')`, [req.customerId, item.name]);
        if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Już to zamówiłeś.' }); }
      }
      let result = {};
      if (cat.currency === 'USD') {
        const acc = await getAccount(client, req.customerId);
        const problem = accountProblem(acc);
        if (problem) { await client.query('ROLLBACK'); return res.status(400).json({ error: problem }); }
        if (Number(acc.balance) < total) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Niewystarczające środki.' }); }
        await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id = $1', [acc.account_id, total]);
        await client.query(`INSERT INTO bank_transactions (sender_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'FEE')`, [acc.account_id, total, `Zakup: ${label}`]);
        await treasury.credit(client, 'BANK', total, 'SKLEP', label, req.customerId); // utarg ze sklepu idzie do banku państwa
        if (item.instant === 'scratch') {
          const prize = rollPrize(item.prizes);
          if (prize > 0) {
            await treasury.debit(client, 'BANK', prize, 'ZDRAPKA', `Wygrana: ${item.name}`, req.customerId, null, true); // wygrane płaci bank (może wejść na minus)
            await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id = $1', [acc.account_id, prize]);
            await client.query(`INSERT INTO bank_transactions (receiver_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'DEPOSIT')`, [acc.account_id, prize, `Wygrana: ${item.name}`]);
          }
          await client.query(`INSERT INTO shop_orders (customer_id, category, item_name, price, status, currency, fulfilled_by, fulfilled_at) VALUES ($1,$2,$3,$4,'ZREALIZOWANE','USD','automat',now())`,
            [req.customerId, category, `${item.name} (wygrana ${money(prize)})`, total]);
          result = { scratch: true, prize };
        } else {
          const o = await client.query(`INSERT INTO shop_orders (customer_id, category, item_name, price, currency, item_id, qty) VALUES ($1,$2,$3,$4,'USD',$5,$6) RETURNING order_id`, [req.customerId, category, label, total, item.id, qty]);
          result = { order_id: o.rows[0].order_id };
        }
      } else {
        const left = await spendCrypto(client, req.customerId, total, `Zakup: ${label}`);
        if (left === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Za mało krypto (AVC). Kup je w zakładce Krypto.' }); }
        const o = await client.query(`INSERT INTO shop_orders (customer_id, category, item_name, price, currency, item_id, qty) VALUES ($1,$2,$3,$4,'AVC',$5,$6) RETURNING order_id`, [req.customerId, category, label, total, item.id, qty]);
        result = { order_id: o.rows[0].order_id };
      }
      await client.query('COMMIT');
      if (result.order_id) notify(`🛒 **Nowe zamówienie (${category})** #${result.order_id}\n${await who(req.customerId)} - **${label}** (${cat.currency === 'AVC' ? total + ' AVC' : money(total)})`, category === 'darkweb' ? 'darkweb' : 'sklep');
      res.json({ ok: true, ...result });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }));

  app.get('/customer/shop/orders', requireCustomerAuth, wrap(async (req, res) => {
    const r = await pool.query(`SELECT order_id, category, item_name, price, currency, status, created_at FROM shop_orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.customerId]);
    res.json(r.rows);
  }));

  // ---------- CZAT DARKWEB (anonimowy, wspólny pokój) ----------
  const RESERVED = /^(admin|administrator|moderator|mod|nieznajomy|ekipa|staff|bank|policja|lapd|lafd|ems|dot)/i;
  async function handleOf(db, customerId) {
    const ex = (await db.query('SELECT handle FROM darkchat_handles WHERE customer_id = $1', [customerId])).rows[0];
    if (ex) return ex.handle;
    for (let i = 0; i < 20; i++) {
      const h = 'Cień-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      try { await db.query('INSERT INTO darkchat_handles (customer_id, handle) VALUES ($1,$2)', [customerId, h]); return h; } catch (e) { if (e.code !== '23505') throw e; }
    }
    throw new Error('Nie udało się nadać pseudonimu.');
  }
  app.get('/customer/darkchat', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const handle = await handleOf(pool, req.customerId);
    const after = parseInt(req.query.after, 10) || 0;
    const r = after
      ? await pool.query('SELECT id, handle, content, created_at, customer_id FROM darkchat WHERE id > $1 ORDER BY id LIMIT 100', [after])
      : await pool.query('SELECT * FROM (SELECT id, handle, content, created_at, customer_id FROM darkchat ORDER BY id DESC LIMIT 60) t ORDER BY id');
    res.json({ handle, messages: r.rows.map((m) => ({ id: m.id, handle: m.handle, content: m.content, created_at: m.created_at, mine: m.customer_id === req.customerId })) });
  }));
  app.post('/customer/darkchat', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const content = String(req.body.content || '').trim().slice(0, 300);
    if (!content) return res.status(400).json({ error: 'Napisz coś.' });
    const last = await pool.query(`SELECT 1 FROM darkchat WHERE customer_id = $1 AND created_at > now() - interval '1500 milliseconds'`, [req.customerId]);
    if (last.rows.length) return res.status(429).json({ error: 'Wolniej.' });
    const handle = await handleOf(pool, req.customerId);
    const r = await pool.query('INSERT INTO darkchat (customer_id, handle, content) VALUES ($1,$2,$3) RETURNING id', [req.customerId, handle, content]);
    pool.query('DELETE FROM darkchat WHERE id < (SELECT COALESCE(MAX(id),0) - 1000 FROM darkchat)').catch(() => {}); // trzymamy ostatnie ~1000 wiadomości
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.post('/customer/darkchat/handle', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const h = String(req.body.handle || '').trim();
    if (!/^[A-Za-z0-9ĄąĆćĘęŁłŃńÓóŚśŹźŻż_\-]{3,16}$/.test(h)) return res.status(400).json({ error: 'Pseudonim: 3-16 znaków (litery, cyfry, _ lub -).' });
    if (RESERVED.test(h)) return res.status(400).json({ error: 'Taki pseudonim jest zarezerwowany.' });
    await handleOf(pool, req.customerId);
    try {
      const r = await pool.query(`UPDATE darkchat_handles SET handle = $2, renamed_at = now()
        WHERE customer_id = $1 AND (renamed_at IS NULL OR renamed_at < now() - interval '10 minutes') RETURNING handle`, [req.customerId, h]);
      if (!r.rows.length) return res.status(429).json({ error: 'Pseudonim możesz zmienić raz na 10 minut.' });
      res.json({ ok: true, handle: r.rows[0].handle });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ten pseudonim jest zajęty.' });
      throw e;
    }
  }));

  // ---------- PLECAK ----------
  const findDef = (category, id) => (CATALOG[category === 'darkweb' ? 'darkweb' : 'sklep'].items.find((i) => i.id === id));
  app.get('/customer/inventory', requireCustomerAuth, wrap(async (req, res) => {
    const r = await pool.query('SELECT item_id, item_name, category, qty FROM inventory WHERE customer_id = $1 AND qty > 0 ORDER BY category, item_name', [req.customerId]);
    res.json(r.rows.map((x) => { const d = findDef(x.category, x.item_id) || {}; return { ...x, bound: !!d.bound, consumable: !!d.consumable, unit: d.unit || null }; }));
  }));
  const invAction = (name, handler) => app.post(`/customer/inventory/${name}`, requireCustomerAuth, wrap(async (req, res) => {
    const itemId = String(req.body.item_id || ''); const qty = Math.max(1, Math.min(100, parseInt(req.body.qty, 10) || 1));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const it = (await client.query('SELECT * FROM inventory WHERE customer_id = $1 AND item_id = $2 FOR UPDATE', [req.customerId, itemId])).rows[0];
      if (!it || it.qty < qty) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nie masz tyle tego przedmiotu.' }); }
      const def = findDef(it.category, itemId) || {};
      const out = await handler(client, it, def, qty, req);
      if (out && out.error) { await client.query('ROLLBACK'); return res.status(out.status || 400).json({ error: out.error }); }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
  invAction('use', async (db, it, def, qty, req) => {
    if (!def.consumable) return { error: 'Tego przedmiotu nie da się zużyć.' };
    await db.query('UPDATE inventory SET qty = qty - $3 WHERE customer_id = $1 AND item_id = $2', [req.customerId, it.item_id, qty]);
  });
  invAction('transfer', async (db, it, def, qty, req) => {
    if (def.bound) return { error: 'Ten przedmiot jest przypisany do Ciebie i nie można go przekazać.' };
    const phone = String(req.body.to_phone_number || '').trim();
    const t = (await db.query(`SELECT customer_id, username FROM customers WHERE phone_number = $1`, [phone])).rows[0];
    if (!t || /^(svc_|npc_)/.test(t.username || '')) return { error: 'Nie ma gracza z takim numerem.' };
    if (t.customer_id === req.customerId) return { error: 'Nie możesz przekazać przedmiotu sobie.' };
    await db.query('UPDATE inventory SET qty = qty - $3 WHERE customer_id = $1 AND item_id = $2', [req.customerId, it.item_id, qty]);
    await db.query(`INSERT INTO inventory (customer_id, item_id, item_name, category, qty) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (customer_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`, [t.customer_id, it.item_id, it.item_name, it.category, qty]);
    const shop = (await db.query('SELECT customer_id FROM customers WHERE phone_number = $1', [SHOP_PHONE])).rows[0];
    if (shop) await db.query('INSERT INTO messages (from_customer_id, to_customer_id, content) VALUES ($1,$2,$3)', [shop.customer_id, t.customer_id, `🎒 Dostałeś przedmiot: ${it.item_name} ×${qty}. Sprawdź Plecak.`]);
  });

  // ---------- KRYPTO (kantor) ----------
  const quote = () => ({ rate: CRYPTO_RATE_USD, fee_pct: CRYPTO_FEE_PCT });
  app.get('/customer/crypto', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const w = await pool.query('SELECT balance FROM crypto_wallets WHERE customer_id = $1', [req.customerId]);
    res.json({ balance: Number(w.rows[0]?.balance || 0), ...quote() });
  }));
  app.post('/customer/crypto/buy', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const avc = parseInt(req.body.avc, 10);
    if (!ok(avc) || avc > 100000) return res.status(400).json({ error: 'Podaj ilość AVC (1-100000).' });
    const cost = Math.ceil(avc * CRYPTO_RATE_USD * (1 + CRYPTO_FEE_PCT / 100));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const acc = await getAccount(client, req.customerId);
      const problem = accountProblem(acc);
      if (problem) { await client.query('ROLLBACK'); return res.status(400).json({ error: problem }); }
      if (Number(acc.balance) < cost) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Za mało środków w banku (potrzeba ${money(cost)}).` }); }
      await client.query('UPDATE accounts SET balance = balance - $2 WHERE account_id = $1', [acc.account_id, cost]);
      await client.query(`INSERT INTO bank_transactions (sender_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'FEE')`, [acc.account_id, cost, `Kantor: zakup ${avc} AVC`]);
      await treasury.credit(client, 'BANK', cost, 'KRYPTO_ZAKUP', `${avc} AVC`, req.customerId);
      const balance = await addCrypto(client, req.customerId, avc, `Zakup za ${money(cost)}`);
      await client.query('COMMIT');
      res.json({ ok: true, balance, cost });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
  app.post('/customer/crypto/sell', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const avc = parseInt(req.body.avc, 10);
    if (!ok(avc) || avc > 100000) return res.status(400).json({ error: 'Podaj ilość AVC (1-100000).' });
    const payout = Math.floor(avc * CRYPTO_RATE_USD * (1 - CRYPTO_FEE_PCT / 100));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const acc = await getAccount(client, req.customerId);
      const problem = accountProblem(acc);
      if (problem) { await client.query('ROLLBACK'); return res.status(400).json({ error: problem }); }
      const balance = await spendCrypto(client, req.customerId, avc, `Sprzedaż za ${money(payout)}`);
      if (balance === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nie masz tyle AVC.' }); }
      await client.query('UPDATE accounts SET balance = balance + $2 WHERE account_id = $1', [acc.account_id, payout]);
      await treasury.debit(client, 'BANK', payout, 'KRYPTO_SPRZEDAZ', `${avc} AVC`, req.customerId, null, true); // wypłata z banku (może wejść na minus)
      await client.query(`INSERT INTO bank_transactions (receiver_account_id, amount, title, transaction_type) VALUES ($1,$2,$3,'DEPOSIT')`, [acc.account_id, payout, `Kantor: sprzedaż ${avc} AVC`]);
      await client.query('COMMIT');
      res.json({ ok: true, balance, payout });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // ---------- ZLECENIA ----------
  const publicRow = (c) => ({ contract_id: c.contract_id, target_name: c.target_name, description: c.description, reward: Number(c.reward), status: c.status, created_at: c.created_at });

  app.get('/customer/contracts', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const me = req.customerId;
    const open = await pool.query(
      `SELECT * FROM contracts WHERE status = 'OPEN' AND poster_id <> $1 AND (target_customer_id IS NULL OR target_customer_id <> $1) ORDER BY reward DESC, created_at DESC LIMIT 50`, [me]);
    const mine = await pool.query(`SELECT * FROM contracts WHERE poster_id = $1 ORDER BY created_at DESC LIMIT 30`, [me]);
    const taken = await pool.query(`SELECT * FROM contracts WHERE taker_id = $1 AND status IN ('TAKEN','CLAIMED') ORDER BY taken_at DESC`, [me]);
    res.json({ open: open.rows.map(publicRow), mine: mine.rows.map(publicRow), taken: taken.rows.map(publicRow), min_reward: CONTRACT_MIN_REWARD });
  }));

  app.post('/customer/contracts', requireCustomerAuth, guard(), wrap(async (req, res) => {
    const target = String(req.body.target_name || '').trim().slice(0, 80);
    const description = String(req.body.description || '').trim().slice(0, 300);
    const reward = parseInt(req.body.reward, 10);
    if (!target || description.length < 5) return res.status(400).json({ error: 'Podaj cel i opis zlecenia (min. 5 znaków).' });
    if (!ok(reward) || reward < CONTRACT_MIN_REWARD) return res.status(400).json({ error: `Minimalna nagroda to ${CONTRACT_MIN_REWARD} AVC.` });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['contract:' + req.customerId]);
      const active = await client.query(`SELECT COUNT(*)::int AS n FROM contracts WHERE poster_id = $1 AND status IN ('OPEN','TAKEN','CLAIMED')`, [req.customerId]);
      if (active.rows[0].n >= 3) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Masz już 3 aktywne zlecenia.' }); }
      const left = await spendCrypto(client, req.customerId, reward, 'Zlecenie: depozyt nagrody');
      if (left === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Za mało krypto (AVC) na nagrodę.' }); }
      // cel po imieniu i nazwisku (jeśli to znany gracz, nie będzie mógł sam podjąć tego zlecenia)
      const m = await client.query(`SELECT customer_id FROM customers WHERE lower(first_name || ' ' || last_name) = lower($1) AND customer_id <> $2 LIMIT 2`, [target, req.customerId]);
      const targetId = m.rows.length === 1 ? m.rows[0].customer_id : null;
      const c = await client.query(`INSERT INTO contracts (poster_id, target_name, target_customer_id, description, reward) VALUES ($1,$2,$3,$4,$5) RETURNING contract_id`,
        [req.customerId, target, targetId, description, reward]);
      await client.query('COMMIT');
      notify(`☠️ **Nowe zlecenie** #${c.rows[0].contract_id}: cel **${target}**, nagroda ${reward} AVC\n> ${description}`);
      res.json({ ok: true, contract_id: c.rows[0].contract_id, balance: left });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // przejścia stanów w jednym miejscu: UPDATE z warunkiem na status = brak wyścigów
  const act = (name, handler) => app.post(`/customer/contracts/:id/${name}`, requireCustomerAuth, guard(), wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE', [req.params.id]);
      const c = r.rows[0];
      if (!c) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie ma takiego zlecenia.' }); }
      const out = await handler(client, c, req.customerId);
      if (out && out.error) { await client.query('ROLLBACK'); return res.status(out.status || 400).json({ error: out.error }); }
      await client.query('COMMIT');
      if (out && out.notify) notify(out.notify);
      res.json({ ok: true, ...(out && out.data) });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  act('take', async (db, c, me) => {
    if (c.status !== 'OPEN') return { error: 'To zlecenie jest już niedostępne.' };
    if (c.poster_id === me) return { error: 'Nie możesz podjąć własnego zlecenia.' };
    if (c.target_customer_id === me) return { error: 'Nie możesz podjąć zlecenia na samego siebie.' };
    const n = await db.query(`SELECT COUNT(*)::int AS n FROM contracts WHERE taker_id = $1 AND status IN ('TAKEN','CLAIMED')`, [me]);
    if (n.rows[0].n >= MAX_TAKEN_CONTRACTS) return { error: `Możesz mieć naraz ${MAX_TAKEN_CONTRACTS} podjęte zlecenia.` };
    await db.query(`UPDATE contracts SET status='TAKEN', taker_id=$2, taken_at=now() WHERE contract_id=$1`, [c.contract_id, me]);
  });
  act('abandon', async (db, c, me) => {
    if (c.taker_id !== me || !['TAKEN', 'CLAIMED'].includes(c.status)) return { error: 'To nie jest Twoje podjęte zlecenie.' };
    await db.query(`UPDATE contracts SET status='OPEN', taker_id=NULL, taken_at=NULL, claimed_at=NULL WHERE contract_id=$1`, [c.contract_id]);
  });
  act('claim', async (db, c, me) => {
    if (c.taker_id !== me || c.status !== 'TAKEN') return { error: 'Nie możesz zgłosić wykonania tego zlecenia.' };
    await db.query(`UPDATE contracts SET status='CLAIMED', claimed_at=now() WHERE contract_id=$1`, [c.contract_id]);
    return { notify: `📨 Zgłoszono wykonanie zlecenia #${c.contract_id} (cel: **${c.target_name}**). Czeka na potwierdzenie zleceniodawcy.` };
  });
  act('reject', async (db, c, me) => {
    if (c.poster_id !== me || c.status !== 'CLAIMED') return { error: 'Brak zgłoszenia do odrzucenia.' };
    await db.query(`UPDATE contracts SET status='TAKEN', claimed_at=NULL WHERE contract_id=$1`, [c.contract_id]);
  });
  act('confirm', async (db, c, me) => {
    if (c.poster_id !== me || c.status !== 'CLAIMED') return { error: 'Brak zgłoszenia do potwierdzenia.' };
    await addCrypto(db, c.taker_id, Number(c.reward), `Nagroda za zlecenie #${c.contract_id}`);
    await db.query(`UPDATE contracts SET status='COMPLETED', closed_at=now(), closed_by='zleceniodawca' WHERE contract_id=$1`, [c.contract_id]);
    return { notify: `✅ Zlecenie #${c.contract_id} zakończone (nagroda ${c.reward} AVC wypłacona).` };
  });
  act('cancel', async (db, c, me) => {
    if (c.poster_id !== me || c.status !== 'OPEN') return { error: 'Anulować można tylko zlecenie, którego nikt jeszcze nie podjął.' };
    await addCrypto(db, c.poster_id, Number(c.reward), `Zwrot nagrody za zlecenie #${c.contract_id}`);
    await db.query(`UPDATE contracts SET status='CANCELLED', closed_at=now(), closed_by='zleceniodawca' WHERE contract_id=$1`, [c.contract_id]);
  });

  // ---------- EKIPA (bot Discord) ----------
  // zamówienia darkweb: tylko administracja/opiekun crime (główny bot); bank widzi wyłącznie sklep (index.js)
  app.get('/internal/darkweb/orders/pending', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(`SELECT o.*, c.first_name, c.last_name, c.phone_number FROM shop_orders o JOIN customers c ON c.customer_id = o.customer_id
      WHERE o.status = 'OCZEKUJE' AND o.category = 'darkweb' ORDER BY o.created_at`);
    res.json(r.rows);
  }));
  app.post('/internal/darkweb/orders/:id/fulfill', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(`UPDATE shop_orders SET status='ZREALIZOWANE', fulfilled_by=$2, fulfilled_at=now() WHERE order_id=$1 AND status='OCZEKUJE' AND category='darkweb' RETURNING *`, [req.params.id, req.body.actor || 'ekipa']);
    if (!r.rows.length) return res.status(400).json({ error: 'Nie znaleziono zamówienia darkweb albo już zrealizowane.' });
    res.json({ ok: true, order: r.rows[0] });
  }));
  app.get('/internal/contracts', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT c.*, p.first_name || ' ' || p.last_name || ' (' || COALESCE(p.phone_number,'-') || ')' AS poster, t.first_name || ' ' || t.last_name AS taker
       FROM contracts c JOIN customers p ON p.customer_id = c.poster_id LEFT JOIN customers t ON t.customer_id = c.taker_id
       WHERE c.status IN ('OPEN','TAKEN','CLAIMED') ORDER BY c.created_at`);
    res.json(r.rows);
  }));
  const staffAct = (name, handler) => app.post(`/internal/contracts/:id/${name}`, requireInternalKey, wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query('SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!c) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie ma takiego zlecenia.' }); }
      const err = await handler(client, c, req.body.actor || 'ekipa');
      if (err) { await client.query('ROLLBACK'); return res.status(400).json({ error: err }); }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
  staffAct('cancel', async (db, c, actor) => {
    if (!['OPEN', 'TAKEN', 'CLAIMED'].includes(c.status)) return 'To zlecenie jest już zamknięte.';
    await addCrypto(db, c.poster_id, Number(c.reward), `Zwrot nagrody (anulowane przez ekipę) #${c.contract_id}`);
    await db.query(`UPDATE contracts SET status='CANCELLED', closed_at=now(), closed_by=$2 WHERE contract_id=$1`, [c.contract_id, actor]);
  });
  staffAct('complete', async (db, c, actor) => {
    if (!c.taker_id || !['TAKEN', 'CLAIMED'].includes(c.status)) return 'Zlecenie nie ma wykonawcy albo jest zamknięte.';
    await addCrypto(db, c.taker_id, Number(c.reward), `Nagroda za zlecenie #${c.contract_id} (ekipa)`);
    await db.query(`UPDATE contracts SET status='COMPLETED', closed_at=now(), closed_by=$2 WHERE contract_id=$1`, [c.contract_id, actor]);
  });
  // moderacja czatu darkweb: tylko administracja / opiekun crime
  app.get('/internal/darkchat/recent', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(`SELECT d.id, d.handle, d.content, d.created_at, c.first_name || ' ' || c.last_name AS real_name, c.phone_number
      FROM darkchat d JOIN customers c ON c.customer_id = d.customer_id ORDER BY d.id DESC LIMIT 20`);
    res.json(r.rows.reverse());
  }));
  app.get('/internal/darkchat/whois', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query(`SELECT h.handle, c.first_name || ' ' || c.last_name AS real_name, c.phone_number FROM darkchat_handles h JOIN customers c ON c.customer_id = h.customer_id WHERE lower(h.handle) = lower($1)`, [String(req.query.handle || '')]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nie ma takiego pseudonimu.' });
    res.json(r.rows[0]);
  }));
  app.post('/internal/darkchat/:id/delete', requireInternalKey, wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM darkchat WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nie ma takiej wiadomości.' });
    res.json({ ok: true });
  }));
  // ekipa może dopisać krypto (np. nagroda za event)
  app.post('/internal/crypto/grant', requireInternalKey, wrap(async (req, res) => {
    let cid = parseInt(req.body.customer_id, 10); const amt = parseInt(req.body.amount, 10);
    if (!cid && req.body.phone_number) { const m = await pool.query('SELECT customer_id FROM customers WHERE phone_number = $1', [String(req.body.phone_number).trim()]); cid = m.rows[0]?.customer_id; }
    if (!cid || !Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'Wymagane: customer_id lub phone_number oraz amount.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT 1 FROM customers WHERE customer_id = $1', [cid]);
      if (!exists.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie ma takiego klienta.' }); }
      const balance = amt > 0 ? await addCrypto(client, cid, amt, `Ekipa: ${req.body.actor || ''}`) : await spendCrypto(client, cid, -amt, `Ekipa: ${req.body.actor || ''}`);
      if (balance === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Klient ma za mało AVC.' }); }
      await client.query('COMMIT');
      res.json({ ok: true, balance });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
}

module.exports = { migrate, register, CATALOG, rollPrize, ensureShopContact, startDelivery, deliverDue };
