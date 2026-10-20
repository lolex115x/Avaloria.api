const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Błąd puli połączeń z bazą (API działa dalej):', err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      customer_id SERIAL PRIMARY KEY,
      character_id TEXT,
      discord_user_id TEXT,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      date_of_birth TEXT,
      ssn_rp TEXT,
      username TEXT UNIQUE,
      password_hash TEXT,
      must_change_password BOOLEAN NOT NULL DEFAULT true,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS darkweb_unlocked BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS darkweb_unlocked BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tweets ADD COLUMN IF NOT EXISTS image TEXT;`).catch(() => {}); // tweets moze jeszcze nie istniec przy pierwszym starcie, ignorujemy

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      account_number TEXT UNIQUE NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'CHECKING',
      balance BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      transaction_id SERIAL PRIMARY KEY,
      sender_account_id INTEGER REFERENCES accounts(account_id),
      receiver_account_id INTEGER REFERENCES accounts(account_id),
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      title TEXT,
      transaction_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS loans (
      loan_id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(account_id),
      amount BIGINT NOT NULL,
      interest_rate NUMERIC NOT NULL DEFAULT 0,
      remaining_balance BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      approved_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_items (
      item_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price BIGINT NOT NULL,
      category TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS darkweb_items (
      item_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price BIGINT NOT NULL,
      category TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      purchase_id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      source TEXT NOT NULL,
      item_name TEXT NOT NULL,
      price BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // kontakt-NPC dealera, uzywany do odblokowania darkweb przez tajna fraze na czacie
  if (process.env.DARKWEB_DEALER_NUMBER) {
    await pool.query(
      `INSERT INTO customers (first_name, last_name, phone_number, status)
       VALUES ('Nieznany', 'Numer', $1, 'ACTIVE')
       ON CONFLICT (phone_number) DO NOTHING`,
      [process.env.DARKWEB_DEALER_NUMBER]
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_logs (
      log_id SERIAL PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      result TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cash_transports (
      transport_id SERIAL PRIMARY KEY,
      amount BIGINT NOT NULL,
      route TEXT,
      status TEXT NOT NULL DEFAULT 'W_TRASIE',
      reported_by TEXT,
      resolved_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
  `);
  await pool.query(`ALTER TABLE cash_transports ADD COLUMN IF NOT EXISTS resolved_by TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweets (
      tweet_id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE tweets ADD COLUMN IF NOT EXISTS image TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      order_id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      category TEXT NOT NULL,
      item_name TEXT NOT NULL,
      price BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OCZEKUJE',
      fulfilled_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      fulfilled_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweet_likes (
      tweet_id INTEGER NOT NULL REFERENCES tweets(tweet_id),
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tweet_id, customer_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweet_comments (
      comment_id SERIAL PRIMARY KEY,
      tweet_id INTEGER NOT NULL REFERENCES tweets(tweet_id),
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      parent_comment_id INTEGER REFERENCES tweet_comments(comment_id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id INTEGER NOT NULL REFERENCES tweet_comments(comment_id),
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, customer_id)
    );
  `);
  await pool.query(`ALTER TABLE tweets ADD COLUMN IF NOT EXISTS image TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      order_id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      category TEXT NOT NULL,
      item_name TEXT NOT NULL,
      price BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OCZEKUJE',
      fulfilled_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      fulfilled_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweet_likes (
      tweet_id INTEGER NOT NULL REFERENCES tweets(tweet_id),
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tweet_id, customer_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweet_comments (
      comment_id SERIAL PRIMARY KEY,
      tweet_id INTEGER NOT NULL REFERENCES tweets(tweet_id),
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      parent_comment_id INTEGER REFERENCES tweet_comments(comment_id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id INTEGER NOT NULL REFERENCES tweet_comments(comment_id),
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, customer_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id SERIAL PRIMARY KEY,
      from_customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      to_customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      contact_customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (customer_id, contact_customer_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  console.log('Avaloria API - baza danych gotowa.');
}

async function logAction(actor, action, target, result) {
  await pool.query(
    'INSERT INTO employee_logs (actor, action, target, result) VALUES ($1,$2,$3,$4)',
    [actor, action, target, result]
  );
}

module.exports = { pool, initDb, logAction };
