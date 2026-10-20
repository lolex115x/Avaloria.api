// MDT – fundamenty: uprawnienia (RBAC: ranga + frakcja + uprawnienia specjalne), aktywna frakcja, audyt, służba/jednostka,
// personel (zawieszenia, rangi, uprawnienia specjalne) i administracja macierzą uprawnień.
//
// Źródło rang: istniejąca tabela faction_members (rangi ustawia synchronizacja z rolami Discorda – bot główny).
// Ta warstwa NIE tworzy drugiej bazy użytkowników ani drugiego logowania: korzysta z customers + sessions.
// Wszystkie decyzje o dostępie zapadają na serwerze; frontend tylko ukrywa to, czego i tak by nie mógł użyć.

const FACTION_LIST = ['LAPD', 'LAFD', 'EMS', 'DOT', 'DOJ'];
const RANKS = ['PRACOWNIK', 'ZASTEPCA', 'SZEF'];
const rankIdx = (r) => RANKS.indexOf(r);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// katalog uprawnień (klucz -> opis); lista pokazywana w panelu administracyjnym
const PERMS = {
  'mdt.access': 'Dostęp do tabletu MDT',
  'mdt.persons.read': 'Wyszukiwanie osób',
  'mdt.vehicles.read': 'Wyszukiwanie pojazdów',
  'mdt.vehicles.manage': 'Rejestr pojazdów: dodawanie i zmiana statusu',
  'mdt.warrants.read': 'Przeglądanie poszukiwanych i alertów',
  'mdt.warrants.create': 'Wystawianie poszukiwań i alertów',
  'mdt.warrants.manage': 'Zamykanie cudzych poszukiwań',
  'mdt.reports.create': 'Tworzenie raportów i notatek',
  'mdt.reports.read': 'Czytanie raportów własnej frakcji',
  'mdt.reports.manage': 'Edycja cudzych raportów, zmiana statusu, dostęp do poufnych',
  'dispatch.access': 'Dispatch: podgląd zgłoszeń frakcji i własny status jednostki',
  'dispatch.calls.create': 'Dispatch: tworzenie zgłoszeń',
  'dispatch.calls.manage': 'Dispatch: zarządzanie zgłoszeniami (statusy, priorytet, frakcje, anulowanie)',
  'dispatch.units.assign': 'Dispatch: przydzielanie i zwalnianie jednostek',
  'dispatch.calls.view_all': 'Dispatch: podgląd zgłoszeń wszystkich frakcji',
  'alarms.read': 'Alarmy napadowe: podgląd',
  'alarms.manage': 'Alarmy napadowe: potwierdzanie i zamykanie',
  'radio.access': 'Radio: dostęp do modułu',
  'radio.channel.join': 'Radio: dołączanie do kanałów wg zasad kanału',
  'radio.interop': 'Radio: kanał Interop',
  'radio.command': 'Radio: kanał Command',
  'radio.channel.manage': 'Radio: zarządzanie kanałami',
  'faction.personnel.read': 'Personel: lista członków frakcji',
  'faction.personnel.manage': 'Personel: zawieszanie i uprawnienia specjalne',
  'faction.ranks.manage': 'Personel: zmiana rang (Pracownik/Zastępca)',
  'faction.treasury': 'Skarbiec frakcji (podgląd i przelewy wg rangi)',
  'doj.cases.read': 'DOJ: przeglądanie spraw jawnych',
  'doj.cases.manage': 'DOJ: tworzenie i prowadzenie spraw',
  'doj.cases.classified': 'DOJ: dostęp do spraw poufnych',
  'audit.read': 'Dziennik audytu',
  'admin.system.manage': 'Administracja systemem MDT',
};
// uprawnień administracyjnych nie da się nadać zwykłym grantem frakcyjnym
const ADMIN_ONLY = new Set(['admin.system.manage']);

const COMMON = ['mdt.access', 'mdt.persons.read', 'mdt.vehicles.read', 'mdt.reports.create', 'mdt.reports.read', 'radio.access', 'radio.channel.join'];
const FIELD = ['dispatch.access', 'dispatch.calls.create'];
const DEFAULTS = (() => {
  const out = [];
  const add = (f, r, list) => list.forEach((p) => out.push([f, r, p]));
  for (const f of ['LAPD', 'LAFD', 'EMS', 'DOT']) {
    add(f, 'PRACOWNIK', [...COMMON, ...FIELD]);
    add(f, 'ZASTEPCA', [...COMMON, ...FIELD, 'mdt.reports.manage', 'dispatch.calls.manage', 'dispatch.units.assign', 'radio.interop',
      'faction.personnel.read', 'audit.read', 'faction.treasury']);
    add(f, 'SZEF', [...COMMON, ...FIELD, 'mdt.reports.manage', 'dispatch.calls.manage', 'dispatch.units.assign', 'dispatch.calls.view_all', 'radio.interop', 'radio.command',
      'faction.personnel.read', 'faction.personnel.manage', 'faction.ranks.manage', 'audit.read', 'faction.treasury']);
  }
  // policja: rejestr pojazdów, poszukiwani, alarmy
  add('LAPD', 'PRACOWNIK', ['mdt.vehicles.manage', 'mdt.warrants.read', 'mdt.warrants.create', 'alarms.read']);
  add('LAPD', 'ZASTEPCA', ['mdt.vehicles.manage', 'mdt.warrants.read', 'mdt.warrants.create', 'mdt.warrants.manage', 'alarms.read', 'alarms.manage']);
  add('LAPD', 'SZEF', ['mdt.vehicles.manage', 'mdt.warrants.read', 'mdt.warrants.create', 'mdt.warrants.manage', 'alarms.read', 'alarms.manage']);
  // DOT: rejestr pojazdów (holowanie, mandaty za pojazdy)
  for (const r of RANKS) add('DOT', r, ['mdt.vehicles.manage']);
  // DOJ: sprawy, brak dispatchu; poufne sprawy dopiero od szefa
  add('DOJ', 'PRACOWNIK', [...COMMON, 'mdt.warrants.read', 'doj.cases.read']);
  add('DOJ', 'ZASTEPCA', [...COMMON, 'mdt.warrants.read', 'doj.cases.read', 'doj.cases.manage', 'mdt.reports.manage', 'faction.personnel.read', 'audit.read']);
  add('DOJ', 'SZEF', [...COMMON, 'mdt.warrants.read', 'doj.cases.read', 'doj.cases.manage', 'doj.cases.classified', 'mdt.reports.manage',
    'faction.personnel.read', 'faction.personnel.manage', 'faction.ranks.manage', 'audit.read', 'radio.interop', 'radio.command']);
  return out;
})();

const ADMIN_IDS = () => new Set(String(process.env.MDT_ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS rbac_role_perms (
    faction TEXT NOT NULL, rank TEXT NOT NULL, perm TEXT NOT NULL,
    PRIMARY KEY (faction, rank, perm)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rbac_user_grants (
    customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
    faction TEXT NOT NULL,                              -- frakcja albo '*' (globalnie)
    perm TEXT NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
    granted_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, faction, perm)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mdt_meta (key TEXT PRIMARY KEY, value TEXT)`);
  await pool.query(`ALTER TABLE faction_audit ADD COLUMN IF NOT EXISTS result TEXT`);
  await pool.query(`ALTER TABLE faction_audit ADD COLUMN IF NOT EXISTS object_type TEXT`);
  await pool.query(`ALTER TABLE faction_members ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE faction_members ADD COLUMN IF NOT EXISTS suspended_reason TEXT`);
  await pool.query(`ALTER TABLE faction_members ADD COLUMN IF NOT EXISTS suspended_by INTEGER`);
  await pool.query(`ALTER TABLE faction_members ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS faction_audit_obj_idx ON faction_audit (faction, object_type, target)`);
  // domyślna macierz uprawnień zasiewana raz (administrator może ją potem zmieniać; restart niczego nie przywraca)
  const seeded = (await pool.query(`SELECT 1 FROM mdt_meta WHERE key='rbac_seed_v1'`)).rowCount;
  if (!seeded) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [f, r, p] of DEFAULTS) await client.query('INSERT INTO rbac_role_perms (faction, rank, perm) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [f, r, p]);
      await client.query(`INSERT INTO mdt_meta (key, value) VALUES ('rbac_seed_v1', now()::text) ON CONFLICT DO NOTHING`);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }
}

// zapis audytu: wykonawca, akcja, obiekt, wynik, minimalny kontekst (bez haseł i tokenów)
function auditFn(pool) {
  return (db, { faction, actor, action, objectType, target, detail, result }) =>
    (db || pool).query(
      `INSERT INTO faction_audit (faction, actor_customer_id, action, object_type, target, detail, result) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [faction || 'SYSTEM', actor || null, action, objectType || null, target == null ? null : String(target), detail ? clip(detail, 500) : null, result || 'OK'])
      .catch((e) => console.error('audit:', e.message));
}

// pełny kontekst użytkownika: członkostwa, aktywna frakcja (z nagłówka, tylko jeśli faktycznie członek), efektywne uprawnienia
async function loadContext(pool, customerId, requestedFaction) {
  const cust = (await pool.query(`SELECT customer_id, first_name, last_name, phone_number, discord_user_id, ssn_rp, status, phone_on FROM customers WHERE customer_id=$1`, [customerId])).rows[0];
  if (!cust || cust.status !== 'ACTIVE') return { blocked: 'Konto nieaktywne.' };
  const mem = (await pool.query(
    `SELECT faction, rank, suspended, suspended_reason FROM faction_members WHERE customer_id=$1 AND faction = ANY($2) ORDER BY joined_at`, [customerId, FACTION_LIST])).rows;
  const usable = mem.filter((m) => !m.suspended);
  const isAdmin = !!(cust.discord_user_id && ADMIN_IDS().has(String(cust.discord_user_id)));
  const wanted = String(requestedFaction || '').toUpperCase();
  const active = usable.find((m) => m.faction === wanted) || usable[0] || null;
  const perms = new Set();
  if (active) {
    (await pool.query('SELECT perm FROM rbac_role_perms WHERE faction=$1 AND rank=$2', [active.faction, active.rank])).rows.forEach((r) => perms.add(r.perm));
    const grants = (await pool.query(`SELECT perm, effect FROM rbac_user_grants WHERE customer_id=$1 AND faction IN ($2,'*')`, [customerId, active.faction])).rows;
    grants.filter((g) => g.effect === 'allow').forEach((g) => perms.add(g.perm));
    grants.filter((g) => g.effect === 'deny').forEach((g) => perms.delete(g.perm));
  } else {
    // bez frakcji: tylko globalne granty (np. nadane przez administratora)
    (await pool.query(`SELECT perm, effect FROM rbac_user_grants WHERE customer_id=$1 AND faction='*'`, [customerId])).rows
      .filter((g) => g.effect === 'allow').forEach((g) => perms.add(g.perm));
  }
  if (isAdmin) ['mdt.access', 'admin.system.manage', 'audit.read'].forEach((p) => perms.add(p));
  const suspendedOnly = !active && mem.length > 0 && !isAdmin;
  return { customer: cust, memberships: mem, active, perms, isAdmin, suspendedOnly };
}

function modulesFor(ctx) {
  const p = ctx.perms; const f = ctx.active && ctx.active.faction;
  const m = [];
  const add = (key, label, icon, ok) => { if (ok) m.push({ key, label, icon }); };
  add('home', 'Pulpit', '🏠', p.has('mdt.access'));
  add('dispatch', 'Dispatch', '📡', p.has('dispatch.access') || p.has('dispatch.calls.view_all'));
  add('radio', 'Radio', '📻', p.has('radio.access'));
  add('alarms', 'Alarmy', '🚨', p.has('alarms.read'));
  add('persons', 'Osoby', '🪪', p.has('mdt.persons.read'));
  add('vehicles', 'Pojazdy', '🚗', p.has('mdt.vehicles.read'));
  add('warrants', 'Poszukiwani', '🎯', p.has('mdt.warrants.read'));
  add('reports', 'Raporty', '📝', p.has('mdt.reports.read') || p.has('mdt.reports.create'));
  add('records', 'Kartoteka med.', '🩺', f === 'EMS');
  add('invoices', 'Faktury', '🧾', f === 'EMS' || f === 'DOT');
  add('doj', 'Sprawy DOJ', '⚖️', p.has('doj.cases.read'));
  add('personnel', 'Personel', '👥', p.has('faction.personnel.read'));
  add('treasury', 'Skarbiec', '🏦', p.has('faction.treasury') && ['EMS', 'DOT', 'LAPD', 'LAFD'].includes(f));
  add('audit', 'Audyt', '📜', p.has('audit.read'));
  add('admin', 'Administracja', '🛠️', p.has('admin.system.manage'));
  return m;
}

function register(app, { pool, requireCustomerAuth, requireInternalKey }) {
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((err) => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Błąd serwera.' }); });
  const audit = auditFn(pool);

  // --- middleware współdzielone przez wszystkie moduły MDT ---
  const auth = [requireCustomerAuth, wrap(async (req, res, next) => {
    const ctx = await loadContext(pool, req.customerId, req.header('x-mdt-faction'));
    if (ctx.blocked) return res.status(403).json({ error: ctx.blocked });
    if (ctx.suspendedOnly) return res.status(403).json({ error: 'Twoje członkostwo we frakcji jest zawieszone.' });
    if (!ctx.perms.has('mdt.access')) return res.status(403).json({ error: 'Brak dostępu do tabletu MDT (potrzebna aktywna frakcja służbowa).' });
    req.mdt = ctx; req.faction = ctx.active ? ctx.active.faction : null; req.rank = ctx.active ? ctx.active.rank : null;
    next();
  })];
  const need = (...perms) => (req, res, next) => {
    const miss = perms.find((p) => !req.mdt.perms.has(p));
    if (miss) return res.status(403).json({ error: 'Brak uprawnienia: ' + (PERMS[miss] || miss) });
    next();
  };
  const needAny = (...perms) => (req, res, next) => (perms.some((p) => req.mdt.perms.has(p)) ? next() : res.status(403).json({ error: 'Brak uprawnień do tej operacji.' }));
  const ctxHelpers = { auth, need, needAny, wrap, audit };
  app.locals.mdt = ctxHelpers; // moduły rejestrowane później biorą stąd middleware

  // --- „kim jestem”: frakcje, aktywna frakcja, uprawnienia, moduły, jednostka ---
  app.get('/mdt/me', auth, wrap(async (req, res) => {
    const c = req.mdt;
    const unit = c.active ? (await pool.query(`SELECT callsign, unit_status, status_note, since FROM faction_duty WHERE customer_id=$1 AND faction=$2`, [req.customerId, c.active.faction])).rows[0] || null : null;
    res.json({
      me: { customer_id: c.customer.customer_id, name: `${c.customer.first_name} ${c.customer.last_name}`, phone: c.customer.phone_number, phone_on: c.customer.phone_on },
      factions: c.memberships.map((m) => ({ faction: m.faction, rank: m.rank, suspended: m.suspended })),
      active: c.active ? { faction: c.active.faction, rank: c.active.rank } : null,
      perms: [...c.perms].sort(), modules: modulesFor(c), admin: c.isAdmin, unit, on_duty: !!unit,
    });
  }));

  // --- służba i status jednostki ---
  const UNIT_STATUSES = ['DOSTEPNY', 'ZAJETY', 'W_DRODZE', 'NA_MIEJSCU', 'PRZERWA', 'NIEDOSTEPNY'];
  app.post('/mdt/duty', auth, need('dispatch.access'), wrap(async (req, res) => {
    const on = !!req.body.on; const f = req.faction;
    const callsign = clip(req.body.callsign, 16).toUpperCase().replace(/[^A-Z0-9\-]/g, '') || null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (on) {
        const ph = (await client.query('SELECT phone_on FROM customers WHERE customer_id=$1', [req.customerId])).rows[0];
        if (!ph || !ph.phone_on) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Włącz telefon, żeby wejść na służbę.' }); }
        try {
          const ins = await client.query(`INSERT INTO faction_duty (customer_id, faction, callsign, unit_status) VALUES ($1,$2,$3,'DOSTEPNY')
                                          ON CONFLICT (customer_id, faction) DO UPDATE SET callsign = COALESCE(EXCLUDED.callsign, faction_duty.callsign) RETURNING (xmax = 0) AS inserted`, [req.customerId, f, callsign]);
          if (ins.rows[0].inserted) await audit(client, { faction: f, actor: req.customerId, action: 'DUTY_ON', objectType: 'unit', target: callsign });
        } catch (e) {
          if (e.code === '23505') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Znak wywoławczy ${callsign} jest już zajęty.` }); }
          throw e;
        }
      } else {
        const del = await client.query('DELETE FROM faction_duty WHERE customer_id=$1 AND faction=$2 RETURNING since', [req.customerId, f]);
        if (del.rowCount) {
          await client.query('INSERT INTO faction_duty_log (customer_id, faction, started_at) VALUES ($1,$2,$3)', [req.customerId, f, del.rows[0].since]);
          await client.query(`UPDATE ticket_units SET released_at=now(), released_by=$1 WHERE customer_id=$1 AND released_at IS NULL`, [req.customerId]);
          await audit(client, { faction: f, actor: req.customerId, action: 'DUTY_OFF', objectType: 'unit' });
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true, on_duty: on });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  app.post('/mdt/unit/status', auth, need('dispatch.access'), wrap(async (req, res) => {
    const st = String(req.body.status || '');
    if (!UNIT_STATUSES.includes(st)) return res.status(400).json({ error: 'Nieznany status jednostki.' });
    const r = await pool.query(`UPDATE faction_duty SET unit_status=$3, status_note=$4 WHERE customer_id=$1 AND faction=$2 RETURNING 1`,
      [req.customerId, req.faction, st, clip(req.body.note, 120) || null]);
    if (!r.rowCount) return res.status(409).json({ error: 'Najpierw wejdź na służbę.' });
    res.json({ ok: true });
  }));

  // --- personel ---
  app.get('/mdt/personnel', auth, need('faction.personnel.read'), wrap(async (req, res) => {
    if (!req.faction) return res.json({ people: [] });
    const canManage = req.mdt.perms.has('faction.personnel.manage');
    const r = await pool.query(
      `SELECT c.customer_id, c.first_name, c.last_name, ${canManage ? 'c.phone_number,' : ''} m.rank, m.suspended, m.suspended_reason,
              d.callsign, d.unit_status, (d.customer_id IS NOT NULL AND c.phone_on) AS on_duty,
              COALESCE((SELECT json_agg(json_build_object('perm', g.perm, 'effect', g.effect)) FROM rbac_user_grants g
                        WHERE g.customer_id = c.customer_id AND g.faction = m.faction), '[]'::json) AS grants
       FROM faction_members m JOIN customers c ON c.customer_id = m.customer_id
       LEFT JOIN faction_duty d ON d.customer_id = m.customer_id AND d.faction = m.faction
       WHERE m.faction=$1 ORDER BY CASE m.rank WHEN 'SZEF' THEN 0 WHEN 'ZASTEPCA' THEN 1 ELSE 2 END, c.last_name`, [req.faction]);
    res.json({ people: r.rows, me: req.customerId, can_manage: canManage, can_ranks: req.mdt.perms.has('faction.ranks.manage') });
  }));

  const target = async (req, res) => {
    const cid = parseInt(req.params.cid, 10);
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'Zły identyfikator.' }); return null; }
    const m = (await pool.query('SELECT rank, suspended FROM faction_members WHERE customer_id=$1 AND faction=$2', [cid, req.faction])).rows[0];
    if (!m) { res.status(404).json({ error: 'Ta osoba nie jest w tej frakcji.' }); return null; }
    return { cid, m };
  };

  // Rangi: Discord pozostaje źródłem prawdy (synchronizacja go przywróci). Zmiana tylko Pracownik↔Zastępca,
  // tylko osób o randze niższej niż własna, nigdy własnej.
  app.post('/mdt/personnel/:cid/rank', auth, need('faction.ranks.manage'), wrap(async (req, res) => {
    const t = await target(req, res); if (!t) return;
    const rank = String(req.body.rank || '');
    if (!['PRACOWNIK', 'ZASTEPCA'].includes(rank)) return res.status(400).json({ error: 'Można nadać: Pracownik albo Zastępca.' });
    if (t.cid === req.customerId) return res.status(403).json({ error: 'Nie zmienisz własnej rangi.' });
    if (rankIdx(t.m.rank) >= rankIdx(req.rank) || rankIdx(rank) >= rankIdx(req.rank)) return res.status(403).json({ error: 'Możesz zmieniać tylko rangi niższe od własnej.' });
    if (t.m.rank === rank) return res.json({ ok: true, unchanged: true });
    await pool.query('UPDATE faction_members SET rank=$3 WHERE customer_id=$1 AND faction=$2', [t.cid, req.faction, rank]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'ZMIANA_RANGI', objectType: 'member', target: t.cid, detail: `${t.m.rank} → ${rank}` });
    res.json({ ok: true });
  }));

  app.post('/mdt/personnel/:cid/suspend', auth, need('faction.personnel.manage'), wrap(async (req, res) => {
    const t = await target(req, res); if (!t) return;
    const on = !!req.body.on;
    if (t.cid === req.customerId) return res.status(403).json({ error: 'Nie zawieszysz samego siebie.' });
    if (rankIdx(t.m.rank) >= rankIdx(req.rank)) return res.status(403).json({ error: 'Możesz zawieszać tylko osoby niższej rangi.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE faction_members SET suspended=$3, suspended_reason=$4, suspended_by=$5, suspended_at=CASE WHEN $3 THEN now() END WHERE customer_id=$1 AND faction=$2`,
        [t.cid, req.faction, on, on ? clip(req.body.reason, 200) || null : null, on ? req.customerId : null]);
      if (on) {
        await client.query('DELETE FROM faction_duty WHERE customer_id=$1 AND faction=$2', [t.cid, req.faction]);
        await client.query('UPDATE ticket_units SET released_at=now(), released_by=$2 WHERE customer_id=$1 AND released_at IS NULL', [t.cid, req.customerId]);
      }
      await audit(client, { faction: req.faction, actor: req.customerId, action: on ? 'ZAWIESZENIE' : 'ODWIESZENIE', objectType: 'member', target: t.cid, detail: on ? clip(req.body.reason, 200) : null });
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  // uprawnienia specjalne członka: tylko takie, które nadający sam posiada; nie sobie; nie osobie równej/wyższej rangi
  app.post('/mdt/personnel/:cid/grants', auth, need('faction.personnel.manage'), wrap(async (req, res) => {
    const t = await target(req, res); if (!t) return;
    const perm = String(req.body.perm || '');
    const effect = String(req.body.effect || '');
    if (!PERMS[perm] || ADMIN_ONLY.has(perm)) return res.status(400).json({ error: 'Nieznane albo administracyjne uprawnienie.' });
    if (!['allow', 'deny', 'remove'].includes(effect)) return res.status(400).json({ error: 'effect: allow | deny | remove.' });
    if (t.cid === req.customerId) return res.status(403).json({ error: 'Nie zmienisz własnych uprawnień.' });
    if (rankIdx(t.m.rank) >= rankIdx(req.rank)) return res.status(403).json({ error: 'Możesz zmieniać uprawnienia tylko osobom niższej rangi.' });
    if (effect === 'allow' && !req.mdt.perms.has(perm)) return res.status(403).json({ error: 'Nie możesz nadać uprawnienia, którego sam nie masz.' });
    if (effect === 'remove') await pool.query('DELETE FROM rbac_user_grants WHERE customer_id=$1 AND faction=$2 AND perm=$3', [t.cid, req.faction, perm]);
    else await pool.query(`INSERT INTO rbac_user_grants (customer_id, faction, perm, effect, granted_by) VALUES ($1,$2,$3,$4,$5)
                           ON CONFLICT (customer_id, faction, perm) DO UPDATE SET effect=EXCLUDED.effect, granted_by=EXCLUDED.granted_by, created_at=now()`, [t.cid, req.faction, perm, effect, req.customerId]);
    await audit(null, { faction: req.faction, actor: req.customerId, action: 'UPRAWNIENIE_' + effect.toUpperCase(), objectType: 'member', target: t.cid, detail: perm });
    res.json({ ok: true });
  }));

  // --- audyt ---
  app.get('/mdt/audit', auth, need('audit.read'), wrap(async (req, res) => {
    const sys = req.mdt.isAdmin && String(req.query.scope || '') === 'system';
    const f = sys ? 'SYSTEM' : req.faction;
    if (!f) return res.json([]);
    const r = await pool.query(
      `SELECT a.id, a.action, a.object_type, a.target, a.detail, a.result, a.at, c.first_name, c.last_name
       FROM faction_audit a LEFT JOIN customers c ON c.customer_id = a.actor_customer_id
       WHERE a.faction=$1 ORDER BY a.at DESC, a.id DESC LIMIT 150`, [f]);
    res.json(r.rows);
  }));

  // --- administracja: macierz uprawnień rang, granty globalne ---
  const adminOnly = [auth, need('admin.system.manage')];
  app.get('/mdt/admin/rbac', adminOnly, wrap(async (req, res) => {
    const rows = (await pool.query('SELECT faction, rank, perm FROM rbac_role_perms')).rows;
    res.json({ catalog: PERMS, admin_only: [...ADMIN_ONLY], factions: FACTION_LIST, ranks: RANKS, matrix: rows });
  }));
  app.post('/mdt/admin/rbac/role', adminOnly, wrap(async (req, res) => {
    const { faction, rank, perm } = req.body; const on = !!req.body.on;
    if (!FACTION_LIST.includes(faction) || !RANKS.includes(rank) || !PERMS[perm]) return res.status(400).json({ error: 'Zła frakcja, ranga albo uprawnienie.' });
    if (ADMIN_ONLY.has(perm)) return res.status(400).json({ error: 'Tego uprawnienia nie przypisuje się do rangi.' });
    if (on) await pool.query('INSERT INTO rbac_role_perms (faction, rank, perm) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [faction, rank, perm]);
    else await pool.query('DELETE FROM rbac_role_perms WHERE faction=$1 AND rank=$2 AND perm=$3', [faction, rank, perm]);
    await audit(null, { faction: 'SYSTEM', actor: req.customerId, action: on ? 'RANGA_UPRAWNIENIE_DODANE' : 'RANGA_UPRAWNIENIE_ODEBRANE', objectType: 'role', target: `${faction}/${rank}`, detail: perm });
    res.json({ ok: true });
  }));
  const findByPhone = async (phone) => (await pool.query(`SELECT customer_id, first_name, last_name FROM customers WHERE phone_number=$1 AND username NOT LIKE 'svc\\_%' AND username NOT LIKE 'npc\\_%' LIMIT 1`, [clip(phone, 20)])).rows[0];
  app.get('/mdt/admin/grants', adminOnly, wrap(async (req, res) => {
    const r = await pool.query(`SELECT g.customer_id, g.faction, g.perm, g.effect, g.created_at, c.first_name, c.last_name, c.phone_number
                                FROM rbac_user_grants g JOIN customers c ON c.customer_id=g.customer_id ORDER BY g.created_at DESC LIMIT 200`);
    res.json(r.rows);
  }));
  app.post('/mdt/admin/grants', adminOnly, wrap(async (req, res) => {
    const c = await findByPhone(req.body.phone);
    if (!c) return res.status(404).json({ error: 'Nie znaleziono postaci o tym numerze.' });
    const faction = String(req.body.faction || '').toUpperCase();
    const perm = String(req.body.perm || ''); const effect = String(req.body.effect || '');
    if (!(faction === '*' || FACTION_LIST.includes(faction)) || !PERMS[perm] || ADMIN_ONLY.has(perm) || !['allow', 'deny', 'remove'].includes(effect)) return res.status(400).json({ error: 'Zła frakcja, uprawnienie albo efekt.' });
    if (effect === 'remove') await pool.query('DELETE FROM rbac_user_grants WHERE customer_id=$1 AND faction=$2 AND perm=$3', [c.customer_id, faction, perm]);
    else await pool.query(`INSERT INTO rbac_user_grants (customer_id, faction, perm, effect, granted_by) VALUES ($1,$2,$3,$4,$5)
                           ON CONFLICT (customer_id, faction, perm) DO UPDATE SET effect=EXCLUDED.effect, granted_by=EXCLUDED.granted_by, created_at=now()`, [c.customer_id, faction, perm, effect, req.customerId]);
    await audit(null, { faction: 'SYSTEM', actor: req.customerId, action: 'GRANT_' + effect.toUpperCase(), objectType: 'member', target: c.customer_id, detail: `${faction}: ${perm}` });
    res.json({ ok: true, character: `${c.first_name} ${c.last_name}` });
  }));

  // --- wewnętrzne (bot): nadawanie uprawnień po numerze telefonu postaci ---
  app.post('/internal/mdt/grant', requireInternalKey, wrap(async (req, res) => {
    const c = await findByPhone(req.body.phone);
    if (!c) return res.status(404).json({ error: 'Nie znaleziono postaci o tym numerze.' });
    const faction = String(req.body.faction || '').toUpperCase();
    const perm = String(req.body.perm || ''); const effect = String(req.body.effect || 'allow');
    if (!(faction === '*' || FACTION_LIST.includes(faction)) || !PERMS[perm] || ADMIN_ONLY.has(perm) || !['allow', 'deny', 'remove'].includes(effect)) return res.status(400).json({ error: 'Zła frakcja, uprawnienie albo efekt.' });
    if (effect === 'remove') await pool.query('DELETE FROM rbac_user_grants WHERE customer_id=$1 AND faction=$2 AND perm=$3', [c.customer_id, faction, perm]);
    else await pool.query(`INSERT INTO rbac_user_grants (customer_id, faction, perm, effect) VALUES ($1,$2,$3,$4)
                           ON CONFLICT (customer_id, faction, perm) DO UPDATE SET effect=EXCLUDED.effect, created_at=now()`, [c.customer_id, faction, perm, effect]);
    await audit(null, { faction: 'SYSTEM', actor: null, action: 'GRANT_' + effect.toUpperCase(), objectType: 'member', target: c.customer_id, detail: `${faction}: ${perm} (bot: ${clip(req.body.actor, 60)})` });
    res.json({ ok: true, character: `${c.first_name} ${c.last_name}` });
  }));
  app.get('/internal/mdt/perms', requireInternalKey, (req, res) => res.json({ catalog: PERMS, factions: FACTION_LIST }));
}

module.exports = { migrate, register, loadContext, auditFn, PERMS, FACTION_LIST, RANKS, rankIdx, clip, DEFAULTS };
