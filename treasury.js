// Skarbce: bank państwa (BANK) i frakcje (EMS, DOT, LAPD, LAFD). Każdy ma numer konta (AFB-GOV-xxxx) i historię operacji.
// Wszystkie ruchy pieniędzy przechodzą przez credit/debit i zostawiają ślad w faction_transactions.

const VAT_PCT = parseFloat(process.env.INVOICE_VAT_PCT || '8'); // % z każdej opłaconej faktury trafia do banku państwa
const HOLDERS = { BANK: 'AFB-GOV-0000', EMS: 'AFB-GOV-0001', DOT: 'AFB-GOV-0002', LAPD: 'AFB-GOV-0003', LAFD: 'AFB-GOV-0004' };
const LABEL = { BANK: 'Bank państwa', EMS: 'EMS', DOT: 'DOT', LAPD: 'LAPD', LAFD: 'LAFD' };

async function migrate(pool) {
  await pool.query('ALTER TABLE faction_accounts ADD COLUMN IF NOT EXISTS account_number TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS faction_accounts_number_idx ON faction_accounts (account_number)');
  await pool.query('ALTER TABLE faction_transactions ADD COLUMN IF NOT EXISTS counterparty TEXT');
  await pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat BIGINT NOT NULL DEFAULT 0');
  for (const [f, no] of Object.entries(HOLDERS)) {
    await pool.query(
      `INSERT INTO faction_accounts (faction, balance, account_number) VALUES ($1, 0, $2)
       ON CONFLICT (faction) DO UPDATE SET account_number = COALESCE(faction_accounts.account_number, EXCLUDED.account_number)`, [f, no]);
  }
}

const int = (n) => Math.trunc(Number(n));

// wpływ na skarbiec (db = pool albo klient w transakcji)
async function credit(db, holder, amount, kind, ref, actorCustomerId, counterparty) {
  amount = int(amount);
  if (!HOLDERS[holder] || !Number.isFinite(amount) || amount <= 0) return false;
  await db.query(`INSERT INTO faction_accounts (faction, balance) VALUES ($1,$2) ON CONFLICT (faction) DO UPDATE SET balance = faction_accounts.balance + EXCLUDED.balance`, [holder, amount]);
  await db.query(`INSERT INTO faction_transactions (faction, amount, kind, ref, actor_customer_id, counterparty) VALUES ($1,$2,$3,$4,$5,$6)`,
    [holder, amount, kind, ref == null ? null : String(ref).slice(0, 200), actorCustomerId || null, counterparty || null]);
  return true;
}

// wydatek ze skarbca; allowNegative = true tylko tam, gdzie bank państwa „drukuje” (np. wygrane ze zdrapek)
async function debit(db, holder, amount, kind, ref, actorCustomerId, counterparty, allowNegative = false) {
  amount = int(amount);
  if (!HOLDERS[holder] || !Number.isFinite(amount) || amount <= 0) return false;
  await db.query('INSERT INTO faction_accounts (faction, balance) VALUES ($1,0) ON CONFLICT DO NOTHING', [holder]);
  const cur = (await db.query('SELECT balance FROM faction_accounts WHERE faction=$1 FOR UPDATE', [holder])).rows[0];
  if (!allowNegative && Number(cur.balance) < amount) return false;
  await db.query('UPDATE faction_accounts SET balance = balance - $2 WHERE faction=$1', [holder, amount]);
  await db.query(`INSERT INTO faction_transactions (faction, amount, kind, ref, actor_customer_id, counterparty) VALUES ($1,$2,$3,$4,$5,$6)`,
    [holder, -amount, kind, ref == null ? null : String(ref).slice(0, 200), actorCustomerId || null, counterparty || null]);
  return true;
}

const vatOf = (amount) => Math.floor(int(amount) * VAT_PCT / 100);

const byNumber = async (db, no) => (await db.query('SELECT faction FROM faction_accounts WHERE account_number = $1', [String(no || '').trim().toUpperCase()])).rows[0]?.faction || null;

module.exports = { migrate, credit, debit, vatOf, byNumber, VAT_PCT, HOLDERS, LABEL };
