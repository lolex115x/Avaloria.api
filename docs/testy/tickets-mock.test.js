process.env.TICKET_CATEGORY_ID='CAT'; process.env.TICKET_ARCHIVE_CATEGORY_ID='ARC'; process.env.TICKET_STAFF_ROLE_IDS='STAFF'; process.env.TICKET_ADMIN_ROLE_IDS='ADM'; process.env.TICKET_LOG_CHANNEL_ID='LOG'; process.env.TICKET_COOLDOWN_SECONDS='0'; process.env.TICKET_MAX_OPEN_PER_USER='2';
const { Pool } = require('pg'); const T = require('./tickets.js');
const pool = new Pool({ connectionString: 'postgres://postgres:pw@localhost/avtest' });
let fails = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const sent = []; const chans = {}; let nextId = 1000; let failCreate = false;
const mkChannel = (opts) => { const id = 'C' + (nextId++); const ch = { id, name: opts.name, opts, parent: opts.parent, perms: {}, msgs: [], deleted: false,
  permissionOverwrites: { edit: async (u, p) => { ch.perms[u] = p; } }, setParent: async (p) => { ch.parent = p; }, setName: async (n) => { ch.name = n; },
  send: async (m) => { ch.msgs.push(m); return m; }, delete: async () => { ch.deleted = true; delete chans[id]; },
  messages: { fetch: async () => { const arr = ch.msgs.filter(m => m.author).map((m, i) => ({ ...m, createdTimestamp: i, attachments: new Map() })); const mp = new Map(arr.map(m => [m.id, m])); mp.last = () => arr[arr.length - 1]; return mp; } } };
  chans[id] = ch; return ch; };
const logCh = { send: async (m) => { sent.push(m); } };
const client = { user: { id: 'BOT' }, channels: { fetch: async (id) => { if (id === 'LOG') return logCh; if (chans[id]) return chans[id]; const e = new Error('x'); e.code = 10003; throw e; } }, on() {}, guilds: {} };
const guild = { id: 'G', roles: { everyone: { id: 'EV' } }, channels: { create: async (o) => { if (failCreate) throw new Error('Missing Permissions'); return mkChannel(o); } } };
const member = (roles = [], admin = false) => ({ permissions: { has: (p) => admin && p === 'Administrator' }, roles: { cache: { has: (r) => roles.includes(r) } } });
const mkI = (o) => { const i = { replies: [], user: { id: o.uid, username: o.name || 'gracz' + o.uid, tag: 'tag' + o.uid }, guild, member: o.member || member(), channel: o.channel, channelId: o.channel && o.channel.id, customId: o.customId, deferred: false, replied: false,
  isChatInputCommand: () => !!o.cmd, isButton: () => !o.modal && !o.cmd, isModalSubmit: () => !!o.modal, commandName: 'ticket', options: { getSubcommand: () => o.cmd },
  fields: { getTextInputValue: () => o.subject || 'temat' }, deferReply: async () => { i.deferred = true; }, reply: async (m) => { i.replied = true; i.replies.push(m); }, editReply: async (m) => { i.replies.push(m); }, showModal: async (m) => { i.modalShown = m; } };
  i.last = () => { const r = i.replies[i.replies.length - 1]; return typeof r === 'string' ? r : (r && r.content) || ''; }; return i; };
const ctx = { client, pool };
const run = async (o) => { const i = mkI(o); await T.handleInteraction(ctx, i); return i; };
(async () => {
  await pool.query('DROP TABLE IF EXISTS discord_ticket_events, discord_tickets CASCADE'); await T.migrate(pool);
  // 1 przycisk -> modal
  let i = await run({ uid: 'U1', customId: 'tk:open:help' }); ok(i.modalShown && i.modalShown.data.custom_id === 'tk:m:help', 'przycisk otwiera formularz (modal)');
  // 2 anty multi-click: 5 rownoleglych zgloszen tego samego typu
  const rs = await Promise.all([1,2,3,4,5].map(() => run({ uid: 'U1', modal: true, customId: 'tk:m:help', subject: 'Nie dziala telefon' })));
  const created = Object.values(chans).filter(c => !c.deleted).length; ok(created === 1, `5 rownoleglych klikniec -> 1 kanal (jest ${created})`);
  ok(rs.filter(x => /Ticket utworzony/.test(x.last())).length === 1, 'tylko jedno potwierdzenie utworzenia');
  const ch1 = Object.values(chans)[0];
  const ow = ch1.opts.permissionOverwrites; const byId = Object.fromEntries(ow.map(o => [o.id, o]));
  ok(byId.EV && byId.EV.deny.length === 1 && !byId.EV.allow, '@everyone nie widzi kanalu'); ok(byId.U1 && byId.U1.allow.length >= 3, 'wlasciciel widzi i pisze'); ok(byId.STAFF, 'rola staff widzi ticket'); ok(!byId.ADM, 'rola admin nie dodana do zwyklego ticketu');
  ok(ch1.parent === 'CAT', 'kanal w kategorii z env');
  ok(/pomoc-gracz/.test(ch1.name), 'nazwa kanalu bezpieczna: ' + ch1.name);
  // 3 admin ticket: staff NIE widzi, adm tak
  i = await run({ uid: 'U1', modal: true, customId: 'tk:m:admin', subject: 'skarga' }); const chA = Object.values(chans).find(c => /^admin-/.test(c.name));
  const idsA = chA.opts.permissionOverwrites.map(o => o.id); ok(idsA.includes('ADM') && !idsA.includes('STAFF'), 'zgloszenie admin: tylko role admin, bez zwyklego staffu');
  // 4 limit 2 (help + admin) -> trzeci typ blokowany
  i = await run({ uid: 'U1', modal: true, customId: 'tk:m:inne' }); ok(/limit/.test(i.last()), 'limit otwartych ticketow na osobe');
  // 5 awaria tworzenia kanalu -> sprzatanie
  failCreate = true; i = await run({ uid: 'U2', modal: true, customId: 'tk:m:help' }); failCreate = false;
  ok(/Nie udało się/.test(i.last()), 'blad tworzenia -> komunikat'); const rows = (await pool.query("select * from discord_tickets where owner_id='U2'")).rows; ok(rows.length === 0, 'brak osieroconego wpisu w bazie po bledzie');
  i = await run({ uid: 'U2', modal: true, customId: 'tk:m:help' }); ok(/Ticket utworzony/.test(i.last()), 'po bledzie mozna zalozyc ticket ponownie');
  // 6 zamykanie
  const chU2 = Object.values(chans).find(c => c.opts.topic.includes('U2'));
  i = await run({ uid: 'U3', channel: chU2, customId: 'tk:close' }); ok(/Nie możesz/.test(i.last()), 'obcy nie zamknie cudzego ticketu');
  const [a, b] = await Promise.all([run({ uid: 'U2', channel: chU2, customId: 'tk:close' }), run({ uid: 'U2', channel: chU2, customId: 'tk:close' })]);
  ok([a, b].filter(x => /^Ticket zamknięty\.$/.test(x.last())).length === 1, 'podwojne zamkniecie dziala raz'); ok(chU2.perms.U2 && chU2.perms.U2.SendMessages === false, 'wlasciciel traci prawo pisania'); ok(chU2.parent === 'ARC', 'przeniesiony do archiwum');
  i = await run({ uid: 'U2', channel: chU2, customId: 'tk:reopen' }); ok(/tylko obsługa/.test(i.last()), 'wlasciciel nie otworzy ponownie');
  i = await run({ uid: 'S1', member: member(['STAFF']), channel: chU2, customId: 'tk:reopen' }); ok(/otwarty ponownie/.test(i.last()) && chU2.perms.U2.SendMessages === true && chU2.parent === 'CAT', 'staff otwiera ponownie, uprawnienia wracaja');
  // 7 transkrypt i usuniecie
  chU2.msgs.push({ id: 'm1', author: { tag: 'U2#1' }, content: 'moje haslo: SuperTajne123 i token' });
  await run({ uid: 'U2', channel: chU2, customId: 'tk:close' });
  i = await run({ uid: 'U2', channel: chU2, customId: 'tk:tr' }); ok(/tylko obsługa/.test(i.last()), 'transkrypt tylko dla obslugi');
  sent.length = 0; i = await run({ uid: 'S1', member: member(['STAFF']), channel: chU2, customId: 'tk:tr' }); const f = sent.find(s => s.files && s.files.length);
  ok(f && !String(f.files[0].attachment.toString()).includes('SuperTajne123') && f.files[0].attachment.toString().includes('[USUNIĘTE]'), 'transkrypt w logach, haslo zredagowane');
  i = await run({ uid: 'U2', channel: chU2, customId: 'tk:delyes' }); ok(!chU2.deleted, 'wlasciciel nie usunie kanalu');
  i = await run({ uid: 'S1', member: member(['STAFF']), channel: chU2, customId: 'tk:delyes' }); ok(chU2.deleted, 'staff usuwa zamkniety ticket');
  ok((await pool.query("select status from discord_tickets where owner_id='U2'")).rows[0].status === 'DELETED', 'status DELETED w bazie');
  // 8 straznik
  const chG = ch1; const delMsgs = []; const m = { guild, author: { id: 'U1', bot: false }, content: 'a token: ' + 'A'.repeat(24) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(27), channel: chG, delete: async () => delMsgs.push(1) };
  const orig = T.handleInteraction; // onMessage nie jest eksportowane – testujemy przez redact/looksSecret
  ok(T.looksSecret(m.content) && T.looksSecret('haslo: abc123') && !T.looksSecret('Mam problem z logowaniem, pomocy'), 'wykrywanie hasel/tokenow (bez falszywych alarmow)');
  ok(!T.redact(m.content).includes('AAAA'), 'redakcja tokenu');
  // 9 sprzatanie
  await pool.query("insert into discord_tickets(guild_id,owner_id,type,status,created_at) values('G','U9','konto','CREATING', now()-interval '10 minutes')");
  await pool.query("insert into discord_tickets(guild_id,owner_id,type,status,channel_id) values('G','U8','konto','OPEN','C-nieistnieje')");
  await T.cleanup(ctx); ok((await pool.query("select count(*)::int n from discord_tickets where owner_id='U9'")).rows[0].n === 0, 'sprzatanie usuwa wiszace CREATING'); ok((await pool.query("select status from discord_tickets where owner_id='U8'")).rows[0].status === 'DELETED', 'sprzatanie oznacza ticket z usunietym kanalem');
  // 10 panel tylko admin
  const pc = { send: async (p) => { pc.p = p; } }; i = await run({ uid: 'U1', cmd: 'panel', channel: pc }); ok(!pc.p, 'zwykly gracz nie wysle panelu');
  i = await run({ uid: 'A1', cmd: 'panel', channel: pc, member: member([], true) }); ok(pc.p && pc.p.components[0].components.length === 4, 'admin wysyla panel z 4 przyciskami');
  const logs = (await pool.query('select count(*)::int n from discord_ticket_events')).rows[0].n; ok(logs >= 6, 'zdarzenia zapisane w audycie: ' + logs);
  await pool.end(); console.log(fails ? `\n${fails} BLEDOW` : '\nWSZYSTKO OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('WYJATEK', e); process.exit(2); });
