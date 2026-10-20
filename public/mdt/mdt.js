// Avaloria MDT – interfejs tabletu. Cała kontrola dostępu jest po stronie serwera; tu tylko ukrywamy to, czego i tak nie wolno użyć.
(function () {
  'use strict';
  const $app = document.getElementById('app');
  let token = null, me = null, fac = null, view = 'home', timers = [];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- pomocnicze ----------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const clear = (e) => { while (e.firstChild) e.removeChild(e.firstChild); return e; };
  const fmt = (d) => d ? new Date(d).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const hm = (d) => d ? new Date(d).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  function toast(msg, bad) { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 2600); }
  function every(fn, ms) { timers.push(setInterval(fn, ms)); }
  function stopTimers() { timers.forEach(clearInterval); timers = []; }
  async function api(path, opt = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (fac) headers['X-MDT-Faction'] = fac;
    const r = await fetch(path, { method: opt.method || (opt.body ? 'POST' : 'GET'), headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
    let d = {}; try { d = await r.json(); } catch {}
    if (r.status === 401) { logout(true); throw new Error('Sesja wygasła.'); }
    if (!r.ok) throw new Error(d.error || 'Błąd ' + r.status);
    return d;
  }
  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); } };
  const can = (p) => me && me.perms.includes(p);
  const field = (label, input) => h('label', {}, label, input);
  function modal(title, body, onClose) {
    const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) close(); } });
    const close = () => { m.remove(); onClose && onClose(); };
    m.append(h('div', {}, h('div', { class: 't' }, h('h2', {}, title), h('button', { class: 'sec sm', onclick: close }, '✕')), body));
    document.body.append(m); return close;
  }

  // ---------- logowanie ----------
  function logout(silent) {
    stopTimers(); store.del('mdt_token'); token = null; me = null;
    if (!silent) toast('Wylogowano z MDT (telefon pozostaje zalogowany).');
    showLogin();
  }
  function showLogin(msg) {
    stopTimers(); clear($app);
    const err = h('div', { class: 'err' }, msg || '');
    const u = h('input', { placeholder: 'Login postaci', autocomplete: 'username' });
    const p = h('input', { type: 'password', placeholder: 'Hasło', autocomplete: 'current-password' });
    const f = h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try {
          const r = await fetch('/customer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.value.trim(), password: p.value, remember: true }) });
          const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Błąd logowania');
          token = d.token; store.set('mdt_token', token); boot();
        } catch (x) { err.textContent = x.message; }
      },
    }, h('h1', {}, '🛡️ Avaloria MDT'), h('div', { class: 'mut' }, 'Zaloguj się tą samą postacią, co w telefonie.'), u, p, h('button', {}, 'Zaloguj'), err);
    $app.append(h('div', { class: 'login' }, f));
  }

  async function boot() {
    try {
      me = await api('/mdt/me');
    } catch (e) {
      if (!token) return showLogin();
      token = null; store.del('mdt_token'); return showLogin(e.message);
    }
    fac = me.active ? me.active.faction : null;
    if (store.get('mdt_fac') && me.factions.some((f) => f.faction === store.get('mdt_fac') && !f.suspended)) { fac = store.get('mdt_fac'); me = await api('/mdt/me'); }
    const keys = me.modules.map((m) => m.key);
    if (!keys.includes(view)) view = keys[0] || 'home';
    renderShell();
  }

  // ---------- układ ----------
  let $main, $nav, $top;
  function renderShell() {
    stopTimers(); clear($app);
    const sel = h('select', { onchange: async (e) => { fac = e.target.value; store.set('mdt_fac', fac); me = await api('/mdt/me'); view = 'home'; renderShell(); } },
      me.factions.filter((f) => !f.suspended).map((f) => h('option', { value: f.faction, selected: f.faction === fac }, f.faction + ' · ' + rankName(f.rank))));
    $top = h('div', { class: 'top' }, h('span', { class: 'brand' }, 'AVALORIA MDT'), me.factions.length ? sel : null, h('span', { class: 'sp' }),
      me.on_duty ? h('span', { class: 'badge b-green' }, '● NA SŁUŻBIE ' + (me.unit && me.unit.callsign || '')) : h('span', { class: 'badge' }, 'Poza służbą'),
      h('span', { class: 'mut' }, me.me.name), h('button', { class: 'sec sm', onclick: () => logout() }, 'Wyloguj'));
    $nav = h('div', { class: 'nav' }, me.modules.map((m) => h('button', { class: m.key === view ? 'on' : '', onclick: () => { view = m.key; renderShell(); } }, m.icon, ' ', m.label)));
    $main = h('div', { class: 'main' });
    $app.append(h('div', { class: 'shell' }, $top, $nav, $main));
    (VIEWS[view] || VIEWS.home)($main);
  }
  const rankName = (r) => ({ PRACOWNIK: 'Pracownik', ZASTEPCA: 'Zastępca', SZEF: 'Szef' }[r] || r);
  const reload = async () => { me = await api('/mdt/me'); renderShell(); };

  // ---------- widoki ----------
  const VIEWS = {};

  VIEWS.home = async (el) => {
    el.append(h('h2', {}, '🏠 Pulpit'));
    if (!me.active) { el.append(h('div', { class: 'card' }, 'Nie masz aktywnej frakcji służbowej. Dostęp przyznaje administrator.')); return; }
    const cs = h('input', { placeholder: 'Znak wywoławczy, np. ADAM-12', value: (me.unit && me.unit.callsign) || '', maxlength: 16 });
    const duty = h('div', { class: 'card' }, h('h3', {}, 'Służba'),
      can('dispatch.access') ? h('div', { class: 'row' }, cs,
        me.on_duty ? h('button', { class: 'red', onclick: () => act(async () => { await api('/mdt/duty', { body: { on: false } }); await reload(); }) }, 'Zejdź ze służby')
          : h('button', { class: 'green', onclick: () => act(async () => { await api('/mdt/duty', { body: { on: true, callsign: cs.value } }); await reload(); }) }, 'Wejdź na służbę'))
        : h('div', { class: 'mut' }, 'Twoja ranga nie obsługuje dispatchu.'),
      me.on_duty ? h('div', { class: 'row', style: 'margin-top:10px' }, ['DOSTEPNY', 'ZAJETY', 'W_DRODZE', 'NA_MIEJSCU', 'PRZERWA', 'NIEDOSTEPNY'].map((s) =>
        h('button', { class: 'sec sm' + (me.unit && me.unit.unit_status === s ? ' on' : ''), onclick: () => act(async () => { await api('/mdt/unit/status', { body: { status: s } }); await reload(); }) }, s.replace('_', ' ')))) : null,
      me.on_duty ? h('div', { class: 'mut', style: 'margin-top:6px' }, 'Status: ' + (me.unit.unit_status || '')) : null);
    el.append(duty);
    el.append(h('div', { class: 'card' }, h('h3', {}, 'Twoje uprawnienia'), h('div', { class: 'mut' }, me.perms.join(' · '))));
  };

  // --- Dispatch ---
  const NEXT = {
    NOWE: ['PRZYJETE', 'ANULOWANE'], PRZYJETE: ['W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'],
    PRZYDZIELONE: ['W_DRODZE', 'NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'], W_DRODZE: ['NA_MIEJSCU', 'W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'],
    NA_MIEJSCU: ['W_TRAKCIE', 'ZAKONCZONE', 'ANULOWANE'], W_TRAKCIE: ['NA_MIEJSCU', 'ZAKONCZONE', 'ANULOWANE'],
  };
  VIEWS.dispatch = async (el) => {
    let state = null, selId = null, rev = '';
    const left = h('div'), right = h('div');
    el.append(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, '📡 Dispatch'),
      can('dispatch.calls.create') ? h('button', { onclick: newCall }, '+ Nowe zgłoszenie') : null), h('div', { class: 'split' }, left, right));
    async function poll(force) {
      try { const s = await api('/mdt/dispatch/state?rev=' + (force ? '' : rev)); if (s.unchanged) return; state = s; rev = s.rev; draw(); } catch (e) { /* ciche */ }
    }
    function draw() {
      clear(left);
      left.append(h('h3', {}, 'Zgłoszenia (' + state.calls.filter((c) => !['ZAKONCZONE', 'ANULOWANE'].includes(c.status)).length + ' otwartych)'));
      const list = h('div', { class: 'list' });
      state.calls.forEach((c) => list.append(h('div', { class: 'p' + c.priority + (c.ticket_id === selId ? ' sel' : ''), onclick: () => { selId = c.ticket_id; draw(); detail(); } },
        h('div', { class: 't' }, h('b', {}, '#' + c.ticket_id + ' ' + c.kind), h('span', {}, h('span', { class: 'badge ' + (c.priority === 1 ? 'b-red' : c.priority === 2 ? 'b-amber' : '') }, 'P' + c.priority), ' ', h('span', { class: 'badge b-blue' }, c.status))),
        h('div', {}, c.location), h('div', { class: 'mut' }, [c.faction, ...(c.also_factions || [])].join(' + '), ' · ', fmt(c.created_at), c.units.length ? ' · ' + c.units.map((u) => u.callsign || u.name).join(', ') : ' · brak jednostek'))));
      if (!state.calls.length) list.append(h('div', { class: 'mut' }, 'Brak zgłoszeń.'));
      left.append(list);
      left.append(h('h3', {}, 'Jednostki na służbie'));
      const t = h('table', {}, h('tr', {}, ['Znak', 'Osoba', 'Frakcja', 'Status', 'Zgł.'].map((x) => h('th', {}, x))));
      state.units.forEach((u) => t.append(h('tr', {}, h('td', {}, u.callsign || '—'), h('td', {}, u.name), h('td', {}, u.faction), h('td', {}, u.unit_status), h('td', {}, u.ticket_id ? '#' + u.ticket_id : ''))));
      left.append(state.units.length ? t : h('div', { class: 'mut' }, 'Nikt nie jest na służbie.'));
    }
    async function detail() {
      clear(right); if (!selId) return;
      let d; try { d = await api('/mdt/dispatch/calls/' + selId); } catch (e) { right.append(h('div', { class: 'card err' }, e.message)); return; }
      const c = d.call, open = !['ZAKONCZONE', 'ANULOWANE'].includes(c.status);
      const sc = state.calls.find((x) => x.ticket_id === c.ticket_id); const mine = sc && sc.units.some((u) => u.customer_id === me.me.customer_id);
      const card = h('div', { class: 'card' }, h('h3', {}, '#' + c.ticket_id + ' · ' + c.kind + ' · ' + c.status), h('div', {}, c.location), h('p', {}, c.description),
        h('div', { class: 'mut' }, 'Priorytet P' + c.priority + ' · ' + [c.faction, ...(c.also_factions || [])].join(' + ') + ' · źródło: ' + c.source));
      if (open) {
        const row = h('div', { class: 'row' });
        if (!mine && me.unit) row.append(h('button', { onclick: () => act(async () => { await api('/mdt/dispatch/calls/' + selId + '/assign', { body: {} }); poll(true).then(detail); }, 'Przydzielono') }, 'Przydziel mnie'));
        if (mine) row.append(h('button', { class: 'sec', onclick: () => act(async () => { await api('/mdt/dispatch/calls/' + selId + '/release', { body: {} }); poll(true).then(detail); }, 'Zwolniono') }, 'Zwolnij mnie'));
        (NEXT[c.status] || []).forEach((s) => row.append(h('button', { class: s === 'ZAKONCZONE' ? 'green sm' : s === 'ANULOWANE' ? 'red sm' : 'sec sm', onclick: () => {
          let result = ''; if (s === 'ZAKONCZONE') { result = prompt('Wynik zgłoszenia:') || ''; if (!result) return; }
          act(async () => { await api('/mdt/dispatch/calls/' + selId + '/status', { body: { status: s, result } }); poll(true).then(detail); }, 'Status: ' + s);
        } }, s)));
        card.append(row);
        if (can('dispatch.units.assign')) {
          const cand = state.units.filter((u) => !u.ticket_id && [c.faction, ...(c.also_factions || [])].includes(u.faction));
          const sel = h('select', {}, cand.map((u) => h('option', { value: u.customer_id }, (u.callsign || u.name) + ' (' + u.faction + ')')));
          if (cand.length) card.append(h('div', { class: 'row', style: 'margin-top:8px' }, sel, h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/dispatch/calls/' + selId + '/assign', { body: { customer_id: +sel.value } }); poll(true).then(detail); }, 'Przydzielono') }, 'Przydziel jednostkę')));
        }
        if (can('dispatch.calls.manage')) {
          const pr = h('select', {}, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === c.priority }, 'P' + n)));
          const af = h('input', { placeholder: 'Dodatkowe frakcje, np. EMS,LAFD', value: (c.also_factions || []).join(',') });
          card.append(h('div', { class: 'row', style: 'margin-top:8px' }, pr, af, h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/dispatch/calls/' + selId + '/edit', { body: { priority: +pr.value, also_factions: af.value.split(',').map((x) => x.trim()).filter(Boolean) } }); poll(true).then(detail); }, 'Zapisano') }, 'Zapisz')));
        }
        const note = h('input', { placeholder: 'Notatka do zgłoszenia' });
        card.append(h('div', { class: 'row', style: 'margin-top:8px' }, note, h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/dispatch/calls/' + selId + '/note', { body: { note: note.value } }); detail(); }) }, 'Dodaj')));
      }
      right.append(card);
      const log = h('div', { class: 'card' }, h('h3', {}, 'Dziennik'));
      d.log.forEach((l) => log.append(h('div', { class: 'mut' }, fmt(l.at) + ' · ' + (l.who || 'system') + ' · ' + l.action + (l.note ? ' – ' + l.note : ''))));
      right.append(log);
    }
    function newCall() {
      const loc = h('input', { placeholder: 'Lokalizacja' }), desc = h('textarea', { placeholder: 'Opis' }), kind = h('input', { placeholder: 'Rodzaj (np. Napad, Wypadek)' });
      const pr = h('select', {}, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === 3 }, 'P' + n + (n === 1 ? ' – krytyczny' : ''))));
      const also = ['LAPD', 'LAFD', 'EMS', 'DOT'].filter((f) => f !== fac).map((f) => h('label', { class: 'perm' }, h('input', { type: 'checkbox', value: f }), f));
      const body = h('div', { class: 'grid' }, field('Rodzaj', kind), field('Lokalizacja', loc), field('Opis', desc), field('Priorytet', pr), h('div', {}, h('div', { class: 'mut' }, 'Wspólna obsługa (opcjonalnie)'), h('div', { class: 'row' }, also)),
        h('button', { onclick: () => act(async () => {
          const r = await api('/mdt/dispatch/calls', { body: { kind: kind.value, location: loc.value, description: desc.value, priority: +pr.value, also_factions: also.map((l) => l.firstChild).filter((i) => i.checked).map((i) => i.value) } });
          close(); selId = r.ticket_id; await poll(true); detail();
        }, 'Zgłoszenie utworzone') }, 'Utwórz'));
      const close = modal('Nowe zgłoszenie', body);
    }
    await poll(true); every(poll, 3000);
  };

  // --- Radio ---
  VIEWS.radio = async (el) => {
    let chans = []; try { chans = await api('/mdt/radio/channels'); } catch (e) { el.append(h('div', { class: 'card err' }, e.message)); return; }
    el.append(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, '📻 Radio'), h('button', { class: 'red', onclick: () => confirm('Wysłać PANIC na kanał frakcji i Dispatch?') && act(() => api('/mdt/radio/panic', { body: {} }), 'PANIC wysłany') }, '🆘 PANIC')));
    if (!chans.length) { el.append(h('div', { class: 'card' }, 'Brak dostępnych kanałów.')); return; }
    let cur = store.get('mdt_chan'); if (!chans.some((c) => c.key === cur)) cur = chans[0].key;
    let since = 0;
    const tabs = h('div', { class: 'tabs' }), chat = h('div', { class: 'chat' });
    const inp = h('input', { placeholder: 'Wiadomość radiowa…', maxlength: 300 });
    const send = async () => { const t = inp.value.trim(); if (!t) return; inp.value = ''; await act(() => api('/mdt/radio/' + cur + '/send', { body: { text: t } })); load(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    el.append(tabs, chat, h('div', { class: 'row' }, inp, h('button', { onclick: send }, 'Nadaj')));
    const drawTabs = () => { clear(tabs); chans.forEach((c) => tabs.append(h('button', { class: c.key === cur ? 'on' : '', onclick: () => { cur = c.key; store.set('mdt_chan', cur); since = 0; clear(chat); drawTabs(); load(); } }, c.name))); };
    async function load() {
      try {
        const d = await api('/mdt/radio/' + cur + '/messages' + (since ? '?since=' + since : ''));
        const stick = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 30;
        d.messages.forEach((m) => { since = Math.max(since, m.id); chat.append(h('div', { class: 'm ' + m.kind + (m.sender_customer_id === d.me ? ' me' : '') }, h('span', { class: 'mut' }, hm(m.created_at) + ' '), h('b', {}, (m.callsign ? m.callsign + ' · ' : '') + m.sender_name + (m.faction ? ' [' + m.faction + ']' : '') + ': '), m.body)); });
        if (stick || !since) chat.scrollTop = chat.scrollHeight;
      } catch (e) { /* ciche */ }
    }
    drawTabs(); await load(); every(load, 2500);
  };

  // --- Alarmy ---
  VIEWS.alarms = async (el) => {
    el.append(h('h2', {}, '🚨 Alarmy napadowe'), h('div', { class: 'mut', style: 'margin-bottom:10px' }, 'Lokalizacja pochodzi z listy zweryfikowanych miejsc lub jest wpisana ręcznie – gra nie przekazuje pozycji automatycznie. Alarm cichy wysyła się po opóźnieniu liczonym na serwerze.'));
    const list = h('div', { class: 'card' });
    let locs = []; try { locs = await api('/mdt/locations'); } catch {}
    if (can('alarms.manage')) {
      const ls = h('select', {}, h('option', { value: '' }, '— lokalizacja z listy —'), locs.map((l) => h('option', { value: l.key }, l.name)));
      const lt = h('input', { placeholder: 'albo wpisz lokalizację ręcznie' }), kd = h('input', { placeholder: 'Rodzaj (BANK, SKLEP…)', value: 'INNE' });
      const imm = h('label', { class: 'perm' }, h('input', { type: 'checkbox' }), 'Natychmiast (bez opóźnienia, tylko test)');
      el.append(h('div', { class: 'card' }, h('h3', {}, 'Ręczny alarm / test'), h('div', { class: 'row' }, ls, lt, kd), imm,
        h('button', { style: 'margin-top:8px', onclick: () => act(async () => { await api('/mdt/alarms', { body: { location_key: ls.value || undefined, location_text: lt.value, kind: kd.value, immediate: imm.firstChild.checked, client_key: String(Date.now()) } }); draw(); }, 'Alarm utworzony') }, 'Utwórz alarm'),
        h('h3', {}, 'Dodaj zweryfikowane miejsce'), (() => { const k = h('input', { placeholder: 'klucz (np. bank_centralny)' }), n = h('input', { placeholder: 'Nazwa' }); return h('div', { class: 'row' }, k, n, h('button', { class: 'sec', onclick: () => act(async () => { await api('/mdt/locations', { body: { key: k.value, name: n.value, kind: kd.value } }); reload(); }, 'Zapisano') }, 'Zapisz')); })()));
    }
    el.append(list);
    async function draw() {
      clear(list).append(h('h3', {}, 'Ostatnie alarmy'));
      const rows = await api('/mdt/alarms');
      const t = h('table', {}, h('tr', {}, ['#', 'Rodzaj', 'Miejsce', 'Status', 'Czas', 'Zgł.', ''].map((x) => h('th', {}, x))));
      rows.forEach((a) => {
        let btn = '';
        if (can('alarms.manage')) {
          const go = (status) => act(async () => { await api('/mdt/alarms/' + a.id + '/status', { body: { status } }); draw(); });
          if (a.status === 'OCZEKUJE') btn = h('button', { class: 'sec sm', onclick: () => go('ANULOWANY') }, 'Anuluj');
          else if (a.status === 'WYSLANY') btn = h('button', { class: 'sec sm', onclick: () => go('POTWIERDZONY') }, 'Potwierdź');
          else if (a.status === 'POTWIERDZONY') btn = h('button', { class: 'sec sm', onclick: () => go('ZAMKNIETY') }, 'Zamknij');
        }
        t.append(h('tr', {}, h('td', {}, a.id), h('td', {}, a.kind), h('td', {}, a.location_text), h('td', {}, h('span', { class: 'badge ' + (a.status === 'WYSLANY' ? 'b-red' : '') }, a.status)), h('td', {}, fmt(a.created_at)), h('td', {}, a.ticket_id ? '#' + a.ticket_id : ''), h('td', {}, btn)));
      });
      list.append(rows.length ? t : h('div', { class: 'mut' }, 'Brak alarmów.'));
    }
    await draw(); every(draw, 5000);
  };

  // --- Osoby ---
  VIEWS.persons = async (el) => {
    const q = h('input', { placeholder: 'Imię i nazwisko, SSN albo numer telefonu (min. 2 znaki)' }), res = h('div', { class: 'list' }), det = h('div');
    q.addEventListener('input', async () => { if (q.value.trim().length < 2) return clear(res); try { const r = await api('/mdt/persons?q=' + encodeURIComponent(q.value.trim())); clear(res); r.forEach((p) => res.append(h('div', { onclick: () => open(p.customer_id) }, h('b', {}, p.first_name + ' ' + p.last_name), ' ', p.warrants ? h('span', { class: 'badge b-red' }, '⚠ poszukiwany') : '', h('div', { class: 'mut' }, 'tel. ' + p.phone_number + ' · SSN ' + p.ssn_rp)))); } catch (e) { toast(e.message, true); } });
    el.append(h('h2', {}, '🪪 Osoby'), q, h('div', { class: 'split', style: 'margin-top:10px' }, res, det));
    async function open(id) {
      const d = await act(() => api('/mdt/persons/' + id)); if (!d) return; clear(det);
      det.append(h('div', { class: 'card' }, h('h3', {}, d.person.first_name + ' ' + d.person.last_name), h('div', { class: 'mut' }, 'tel. ' + d.person.phone_number + ' · SSN ' + d.person.ssn_rp)));
      det.append(h('div', { class: 'card' }, h('h3', {}, 'Pojazdy'), d.vehicles.length ? d.vehicles.map((v) => h('div', {}, v.plate + ' · ' + (v.model || '') + ' · ', h('span', { class: 'badge' }, v.status))) : h('div', { class: 'mut' }, 'Brak.')));
      if (can('mdt.warrants.read')) det.append(h('div', { class: 'card' }, h('h3', {}, 'Poszukiwania i alerty'), d.warrants.length ? d.warrants.map((w) => h('div', {}, h('span', { class: 'badge ' + (w.status === 'AKTYWNY' ? 'b-red' : '') }, w.status), ' ' + w.kind + ': ' + w.reason + ' (' + w.created_faction + ')')) : h('div', { class: 'mut' }, 'Brak.')));
      det.append(h('div', { class: 'card' }, h('h3', {}, 'Raporty (widoczne dla Ciebie)'), d.reports.length ? d.reports.map((r) => h('div', {}, '#' + r.id + ' ' + r.title + ' · ' + fmt(r.created_at))) : h('div', { class: 'mut' }, 'Brak.')));
    }
  };

  // --- Pojazdy ---
  VIEWS.vehicles = async (el) => {
    const q = h('input', { placeholder: 'Tablica albo model (min. 2 znaki)' }), res = h('div', { class: 'card' });
    q.addEventListener('input', async () => { clear(res); if (q.value.trim().length < 2) return; try { const r = await api('/mdt/vehicles?q=' + encodeURIComponent(q.value.trim())); r.forEach((v) => res.append(h('div', { class: 'row', style: 'padding:6px 0' }, h('b', {}, v.plate), (v.model || '') + ' ' + (v.color || ''), ' · właściciel: ' + (v.owner || '—'), h('span', { class: 'badge ' + (v.status === 'OK' ? 'b-green' : 'b-red') }, v.status), v.warrants ? h('span', { class: 'badge b-red' }, 'alert') : '',
      can('mdt.vehicles.manage') ? (() => { const s = h('select', { style: 'width:auto' }, ['OK', 'SKRADZIONY', 'POSZUKIWANY', 'ZHOLOWANY', 'KONFISKOWANY'].map((x) => h('option', { selected: x === v.status }, x))); s.addEventListener('change', () => act(() => api('/mdt/vehicles/' + v.vehicle_id + '/status', { body: { status: s.value } }), 'Status zmieniony')); return s; })() : ''))); if (!r.length) res.append(h('div', { class: 'mut' }, 'Brak wyników.')); } catch (e) { toast(e.message, true); } });
    el.append(h('h2', {}, '🚗 Pojazdy'), q, h('div', { style: 'height:10px' }), res);
    if (can('mdt.vehicles.manage')) {
      const pl = h('input', { placeholder: 'Tablica' }), md = h('input', { placeholder: 'Model' }), cl = h('input', { placeholder: 'Kolor' }), ow = h('input', { placeholder: 'Właściciel (tekst) – opcjonalnie' });
      el.append(h('div', { class: 'card' }, h('h3', {}, 'Dodaj pojazd do rejestru'), h('div', { class: 'row' }, pl, md, cl, ow), h('button', { style: 'margin-top:8px', onclick: () => act(async () => { await api('/mdt/vehicles', { body: { plate: pl.value, model: md.value, color: cl.value, owner_text: ow.value } }); pl.value = md.value = cl.value = ow.value = ''; }, 'Dodano') }, 'Dodaj')));
    }
  };

  // --- Poszukiwani ---
  VIEWS.warrants = async (el) => {
    const box = h('div', { class: 'card' });
    el.append(h('h2', {}, '🎯 Poszukiwani i alerty'));
    if (can('mdt.warrants.create')) {
      const sn = h('input', { placeholder: 'Osoba (imię i nazwisko)' }), pl = h('input', { placeholder: 'Tablica (opcjonalnie)' }), rs = h('input', { placeholder: 'Powód' });
      const kd = h('select', {}, ['POSZUKIWANY', 'NAKAZ', 'ALERT'].map((x) => h('option', {}, x)));
      el.append(h('div', { class: 'card' }, h('h3', {}, 'Nowy wpis'), h('div', { class: 'row' }, kd, sn, pl, rs), h('button', { style: 'margin-top:8px', onclick: () => act(async () => { await api('/mdt/warrants', { body: { kind: kd.value, subject_name: sn.value, plate: pl.value, reason: rs.value } }); sn.value = pl.value = rs.value = ''; draw(); }, 'Wpis dodany') }, 'Wystaw')));
    }
    el.append(box);
    async function draw() {
      clear(box); const rows = await act(() => api('/mdt/warrants?all=1')) || [];
      const t = h('table', {}, h('tr', {}, ['Rodzaj', 'Kto/co', 'Powód', 'Frakcja', 'Status', ''].map((x) => h('th', {}, x))));
      rows.forEach((w) => t.append(h('tr', {}, h('td', {}, w.kind), h('td', {}, (w.subject || '') + (w.plate ? ' [' + w.plate + ']' : '')), h('td', {}, w.reason), h('td', {}, w.created_faction), h('td', {}, h('span', { class: 'badge ' + (w.status === 'AKTYWNY' ? 'b-red' : '') }, w.status)),
        h('td', {}, w.status === 'AKTYWNY' ? h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/warrants/' + w.id + '/close', { body: {} }); draw(); }, 'Zamknięto') }, 'Zamknij') : ''))));
      box.append(rows.length ? t : h('div', { class: 'mut' }, 'Brak wpisów.'));
    }
    await draw();
  };

  // --- Raporty ---
  VIEWS.reports = async (el) => {
    const box = h('div', { class: 'card' });
    el.append(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, '📝 Raporty'), can('mdt.reports.create') ? h('button', { onclick: () => editor() }, '+ Nowy raport') : null), box);
    async function draw() {
      clear(box); const rows = await act(() => api('/mdt/reports')) || [];
      const t = h('table', {}, h('tr', {}, ['#', 'Tytuł', 'Rodzaj', 'Frakcja', 'Autor', 'Status', 'Data'].map((x) => h('th', {}, x))));
      rows.forEach((r) => t.append(h('tr', { style: 'cursor:pointer', onclick: () => view1(r.id) }, h('td', {}, r.id), h('td', {}, r.title, r.classification === 'POUFNA' ? ' 🔒' : ''), h('td', {}, r.kind), h('td', {}, r.faction), h('td', {}, r.author), h('td', {}, r.status), h('td', {}, fmt(r.created_at)))));
      box.append(rows.length ? t : h('div', { class: 'mut' }, 'Brak raportów.'));
    }
    async function view1(id) {
      const d = await act(() => api('/mdt/reports/' + id)); if (!d) return; const r = d.report;
      const body = h('div', { class: 'grid' }, h('div', { class: 'mut' }, r.kind + ' · ' + r.faction + ' · ' + r.author + ' · ' + r.status + ' · ' + r.classification + ' · udostępniony: ' + ((r.shared_with || []).join(', ') || 'nikomu')),
        h('div', { style: 'white-space:pre-wrap' }, r.body), d.edits.length ? h('div', { class: 'mut' }, 'Edycje: ' + d.edits.map((e) => e.who + ' ' + fmt(e.at)).join('; ')) : null,
        d.can_edit ? h('button', { class: 'sec', onclick: () => { close(); editor(r); } }, 'Edytuj') : null);
      const close = modal('#' + r.id + ' ' + r.title, body);
    }
    function editor(r) {
      const ti = h('input', { placeholder: 'Tytuł', value: r ? r.title : '' }), bo = h('textarea', { style: 'min-height:160px' }); bo.value = r ? r.body : '';
      const kd = h('select', {}, ['RAPORT', 'NOTATKA', 'ARESZTOWANIE', 'INCYDENT'].map((x) => h('option', { selected: r && r.kind === x }, x)));
      const cl = h('select', {}, ['JAWNA', 'POUFNA'].map((x) => h('option', { selected: r && r.classification === x }, x)));
      const sh = ['LAPD', 'LAFD', 'EMS', 'DOT', 'DOJ'].filter((f) => f !== fac).map((f) => h('label', { class: 'perm' }, h('input', { type: 'checkbox', value: f, checked: !!(r && (r.shared_with || []).includes(f)) }), f));
      const st = r && can('mdt.reports.manage') ? h('select', {}, ['SZKIC', 'ZLOZONY', 'ZAMKNIETY'].map((x) => h('option', { selected: r.status === x }, x))) : null;
      const close = modal(r ? 'Edycja raportu' : 'Nowy raport', h('div', { class: 'grid' }, field('Tytuł', ti), field('Treść', bo), r ? null : field('Rodzaj', kd), field('Klasyfikacja', cl), h('div', {}, h('div', { class: 'mut' }, 'Udostępnij frakcjom (tylko jawne raporty są czytelne)'), h('div', { class: 'row' }, sh)), st ? field('Status', st) : null,
        h('button', { onclick: () => act(async () => {
          const shared = sh.map((l) => l.firstChild).filter((i) => i.checked).map((i) => i.value);
          if (r) await api('/mdt/reports/' + r.id + '/edit', { body: { title: ti.value, body: bo.value, classification: cl.value, shared_with: shared, status: st ? st.value : undefined } });
          else { const n = await api('/mdt/reports', { body: { title: ti.value, body: bo.value, kind: kd.value, classification: cl.value } }); if (shared.length) await api('/mdt/reports/' + n.id + '/edit', { body: { shared_with: shared } }); }
          close(); draw();
        }, 'Zapisano') }, 'Zapisz')));
    }
    await draw();
  };

  // --- EMS: kartoteka medyczna (stare endpointy panelu, nowy interfejs) ---
  VIEWS.records = async (el) => {
    const ph = h('input', { placeholder: 'Numer telefonu pacjenta' }), out = h('div');
    const load = async () => {
      const d = await act(() => api('/customer/factions/EMS/ops/records?phone=' + encodeURIComponent(ph.value.trim()))); if (!d) return; clear(out);
      const tx = h('textarea', { placeholder: 'Nowy wpis dokumentacji…' });
      out.append(h('div', { class: 'card' }, h('h3', {}, 'Pacjent: ' + d.patient.first_name + ' ' + d.patient.last_name), tx, h('button', { style: 'margin-top:8px', onclick: () => act(async () => { await api('/customer/factions/EMS/ops/records', { body: { phone: ph.value.trim(), content: tx.value } }); load(); }, 'Wpis dodany') }, 'Dodaj wpis')));
      d.records.forEach((r) => out.append(h('div', { class: 'card' }, h('div', { class: 'mut' }, fmt(r.created_at) + ' · ' + r.first_name + ' ' + r.last_name + (r.updated_at ? ' · edytowano' : '')), h('div', { style: 'white-space:pre-wrap' }, r.content),
        h('button', { class: 'sec sm', onclick: () => { const n = prompt('Nowa treść wpisu:', r.content); if (n) act(async () => { await api('/customer/factions/EMS/ops/records/' + r.record_id + '/edit', { body: { content: n } }); load(); }, 'Zapisano'); } }, 'Edytuj'))));
    };
    el.append(h('h2', {}, '🩺 Kartoteka medyczna'), h('div', { class: 'row' }, ph, h('button', { onclick: load }, 'Szukaj')), h('div', { style: 'height:10px' }), out);
  };

  // --- Faktury (EMS/DOT) ---
  VIEWS.invoices = async (el) => {
    const box = h('div', { class: 'card' }), ph = h('input', { placeholder: 'Numer klienta' }), am = h('input', { type: 'number', placeholder: 'Kwota', min: 1 }), ti = h('input', { placeholder: 'Opis (np. Usługa holowania)' });
    el.append(h('h2', {}, '🧾 Faktury'), h('div', { class: 'card' }, h('div', { class: 'row' }, ph, am, ti), h('button', { style: 'margin-top:8px', onclick: () => act(async () => { await api('/customer/factions/' + fac + '/invoices', { body: { to_phone_number: ph.value.trim(), amount: +am.value, title: ti.value } }); draw(); }, 'Faktura wystawiona') }, 'Wystaw fakturę')), box);
    async function draw() {
      clear(box); const rows = await act(() => api('/customer/factions/' + fac + '/invoices' + (me.active.rank !== 'PRACOWNIK' ? '?scope=all' : ''))) || [];
      const t = h('table', {}, h('tr', {}, ['#', 'Klient', 'Kwota', 'Opis', 'Status', ''].map((x) => h('th', {}, x))));
      rows.forEach((i) => t.append(h('tr', {}, h('td', {}, i.invoice_id), h('td', {}, i.c_first + ' ' + i.c_last), h('td', {}, i.amount), h('td', {}, i.title), h('td', {}, i.status), h('td', {}, i.status === 'PENDING' || i.status === 'OCZEKUJE' ? h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/customer/factions/' + fac + '/invoices/' + i.invoice_id + '/cancel', { body: {} }); draw(); }) }, 'Anuluj') : ''))));
      box.append(rows.length ? t : h('div', { class: 'mut' }, 'Brak faktur.'));
    }
    await draw();
  };

  // --- Skarbiec ---
  VIEWS.treasury = async (el) => {
    const d = await act(() => api('/customer/factions/' + fac + '/treasury')); if (!d) return;
    const ph = h('input', { placeholder: 'Numer pracownika' }), am = h('input', { type: 'number', placeholder: 'Kwota', min: 1 }), ti = h('input', { placeholder: 'Tytuł' });
    el.append(h('h2', {}, '🏦 Skarbiec ' + fac), h('div', { class: 'card' }, h('div', {}, 'Saldo: ', h('b', {}, d.balance + ' $')), h('div', { class: 'mut' }, 'Konto: ' + d.account_number + ' · VAT ' + d.vat_pct + '%'),
      h('h3', {}, 'Wypłata ręczna (zarząd)'), h('div', { class: 'row' }, ph, am, ti), h('button', { style: 'margin-top:8px', onclick: () => act(async () => { await api('/customer/factions/' + fac + '/transfer', { body: { to_phone_number: ph.value.trim(), amount: +am.value, title: ti.value } }); reload(); }, 'Przelew wykonany') }, 'Wypłać')));
    const t = h('table', {}, h('tr', {}, ['Data', 'Rodzaj', 'Kwota', 'Kontrahent', 'Wykonał'].map((x) => h('th', {}, x))));
    d.history.forEach((x) => t.append(h('tr', {}, h('td', {}, fmt(x.created_at)), h('td', {}, x.kind), h('td', {}, x.amount), h('td', {}, x.counterparty || x.ref || ''), h('td', {}, (x.first_name || '') + ' ' + (x.last_name || '')))));
    el.append(h('div', { class: 'card' }, h('h3', {}, 'Historia'), t));
  };

  // --- DOJ ---
  VIEWS.doj = async (el) => {
    const box = h('div', { class: 'card' });
    el.append(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, '⚖️ Sprawy DOJ'), can('doj.cases.manage') ? h('button', { onclick: newCase }, '+ Nowa sprawa') : null), box);
    async function draw() {
      clear(box); const rows = await act(() => api('/mdt/doj/cases')) || [];
      const t = h('table', {}, h('tr', {}, ['Numer', 'Tytuł', 'Osoba', 'Status', 'Klasyf.', 'Rap.'].map((x) => h('th', {}, x))));
      rows.forEach((c) => t.append(h('tr', { style: 'cursor:pointer', onclick: () => show(c.id) }, h('td', {}, c.number), h('td', {}, c.title), h('td', {}, c.subject || ''), h('td', {}, c.status), h('td', {}, c.classification === 'POUFNA' ? '🔒 poufna' : 'jawna'), h('td', {}, c.reports))));
      box.append(rows.length ? t : h('div', { class: 'mut' }, 'Brak spraw.'));
    }
    async function show(id) {
      const d = await act(() => api('/mdt/doj/cases/' + id)); if (!d) return; const c = d.case;
      const body = h('div', { class: 'grid' }, h('div', { class: 'mut' }, c.status + ' · ' + c.classification + ' · ' + (c.subject || 'bez osoby')), h('div', {}, c.summary || ''), h('h3', {}, 'Notatki'),
        d.notes.map((n) => h('div', {}, h('span', { class: 'mut' }, fmt(n.created_at) + ' ' + n.author + ': '), n.body)), h('h3', {}, 'Raporty'), d.reports.length ? d.reports.map((r) => h('div', {}, '#' + r.id + ' ' + r.title + ' (' + r.faction + ')')) : h('div', { class: 'mut' }, 'Brak.'));
      if (d.can_manage) {
        const nt = h('input', { placeholder: 'Nowa notatka' }), rid = h('input', { type: 'number', placeholder: 'ID raportu do podpięcia' });
        const st = h('select', {}, ['OTWARTA', 'W_TOKU', 'ZAMKNIETA'].map((x) => h('option', { selected: c.status === x }, x)));
        body.append(h('div', { class: 'row' }, nt, h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/doj/cases/' + id + '/notes', { body: { body: nt.value } }); close(); show(id); }) }, 'Dodaj')),
          h('div', { class: 'row' }, rid, h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/doj/cases/' + id + '/reports', { body: { report_id: +rid.value } }); close(); show(id); }, 'Podpięto') }, 'Podepnij')),
          h('div', { class: 'row' }, st, h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/doj/cases/' + id + '/status', { body: { status: st.value } }); close(); draw(); }, 'Zapisano') }, 'Zmień status')));
      }
      const close = modal(c.number + ' · ' + c.title, body);
    }
    function newCase() {
      const ti = h('input', { placeholder: 'Tytuł' }), su = h('input', { placeholder: 'Osoba (tekst)' }), sm = h('textarea', { placeholder: 'Opis' }), cl = h('select', {}, can('doj.cases.classified') ? ['JAWNA', 'POUFNA'].map((x) => h('option', {}, x)) : [h('option', {}, 'JAWNA')]);
      const close = modal('Nowa sprawa', h('div', { class: 'grid' }, field('Tytuł', ti), field('Osoba', su), field('Opis', sm), field('Klasyfikacja', cl), h('button', { onclick: () => act(async () => { await api('/mdt/doj/cases', { body: { title: ti.value, subject_name: su.value, summary: sm.value, classification: cl.value } }); close(); draw(); }, 'Sprawa utworzona') }, 'Utwórz')));
    }
    await draw();
  };

  // --- Personel ---
  VIEWS.personnel = async (el) => {
    const box = h('div', { class: 'card' }); el.append(h('h2', {}, '👥 Personel ' + fac), box);
    async function draw() {
      clear(box); const d = await act(() => api('/mdt/personnel')); if (!d) return;
      const t = h('table', {}, h('tr', {}, ['Osoba', 'Ranga', 'Służba', 'Uprawn. specjalne', ''].map((x) => h('th', {}, x))));
      d.people.forEach((p) => {
        const mine = p.customer_id === d.me; const acts = h('div', { class: 'row' });
        if (!mine && d.can_ranks && p.rank !== 'SZEF') acts.append(h('button', { class: 'sec sm', onclick: () => act(async () => { await api('/mdt/personnel/' + p.customer_id + '/rank', { body: { rank: p.rank === 'PRACOWNIK' ? 'ZASTEPCA' : 'PRACOWNIK' } }); draw(); }, 'Ranga zmieniona') }, p.rank === 'PRACOWNIK' ? '↑ Zastępca' : '↓ Pracownik'));
        if (!mine && d.can_manage && p.rank !== 'SZEF') {
          acts.append(h('button', { class: 'sec sm', onclick: () => { const r = p.suspended ? '' : prompt('Powód zawieszenia:') || ''; act(async () => { await api('/mdt/personnel/' + p.customer_id + '/suspend', { body: { on: !p.suspended, reason: r } }); draw(); }, p.suspended ? 'Odwieszono' : 'Zawieszono'); } }, p.suspended ? 'Odwieś' : 'Zawieś'));
          acts.append(h('button', { class: 'sec sm', onclick: () => grantDialog(p) }, 'Uprawnienia'));
        }
        t.append(h('tr', {}, h('td', {}, p.first_name + ' ' + p.last_name, p.suspended ? h('span', { class: 'badge b-red' }, ' zawieszony') : ''), h('td', {}, rankName(p.rank)), h('td', {}, p.on_duty ? '● ' + (p.callsign || '') + ' ' + p.unit_status : ''),
          h('td', { class: 'mut' }, (p.grants || []).map((g) => (g.effect === 'allow' ? '+' : '−') + g.perm).join(' ')), h('td', {}, acts)));
      });
      box.append(t);
    }
    function grantDialog(p) {
      const all = me.perms.slice(); const ps = h('select', {}, all.map((x) => h('option', {}, x))), ef = h('select', {}, ['allow', 'deny', 'remove'].map((x) => h('option', {}, x)));
      const close = modal('Uprawnienia: ' + p.first_name + ' ' + p.last_name, h('div', { class: 'grid' }, h('div', { class: 'mut' }, 'Możesz nadać tylko te uprawnienia, które sam posiadasz. "deny" odbiera uprawnienie wynikające z rangi, "remove" kasuje wyjątek.'), field('Uprawnienie', ps), field('Efekt', ef),
        h('button', { onclick: () => act(async () => { await api('/mdt/personnel/' + p.customer_id + '/grants', { body: { perm: ps.value, effect: ef.value } }); close(); draw(); }, 'Zapisano') }, 'Zapisz')));
    }
    await draw();
  };

  // --- Audyt ---
  VIEWS.audit = async (el) => {
    el.append(h('h2', {}, '📜 Dziennik audytu'));
    const box = h('div', { class: 'card' }); el.append(box);
    const draw = async (sys) => {
      clear(box); const rows = await act(() => api('/mdt/audit' + (sys ? '?scope=system' : ''))) || [];
      if (me.admin) box.append(h('button', { class: 'sec sm', onclick: () => draw(!sys) }, sys ? 'Pokaż frakcję' : 'Pokaż systemowy'));
      const t = h('table', {}, h('tr', {}, ['Czas', 'Kto', 'Akcja', 'Obiekt', 'Szczegóły', 'Wynik'].map((x) => h('th', {}, x))));
      rows.forEach((a) => t.append(h('tr', {}, h('td', {}, fmt(a.at)), h('td', {}, (a.first_name || 'system') + ' ' + (a.last_name || '')), h('td', {}, a.action), h('td', {}, (a.object_type || '') + ' ' + (a.target || '')), h('td', {}, a.detail || ''), h('td', {}, a.result || ''))));
      box.append(t);
    };
    await draw(false);
  };

  // --- Administracja RBAC ---
  VIEWS.admin = async (el) => {
    const d = await act(() => api('/mdt/admin/rbac')); if (!d) return;
    el.append(h('h2', {}, '🛠️ Administracja uprawnień'), h('div', { class: 'mut', style: 'margin-bottom:10px' }, 'Zmiany macierzy obowiązują od razu i są zapisywane w audycie systemowym.'));
    const have = new Set(d.matrix.map((m) => m.faction + '|' + m.rank + '|' + m.perm));
    const sel = h('select', { style: 'width:auto' }, d.factions.map((f) => h('option', {}, f)));
    const box = h('div', { class: 'card', style: 'overflow:auto' });
    el.append(h('div', { class: 'row' }, sel), box);
    const draw = () => {
      clear(box); const f = sel.value;
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Uprawnienie'), d.ranks.map((r) => h('th', {}, rankName(r)))));
      Object.keys(d.catalog).filter((p) => !d.admin_only.includes(p)).forEach((p) => t.append(h('tr', {}, h('td', {}, p, h('div', { class: 'mut' }, d.catalog[p])), d.ranks.map((r) => h('td', {}, (() => {
        const cb = h('input', { type: 'checkbox', checked: have.has(f + '|' + r + '|' + p), style: 'width:auto' });
        cb.addEventListener('change', async () => { const ok = await act(async () => { await api('/mdt/admin/rbac/role', { body: { faction: f, rank: r, perm: p, on: cb.checked } }); return true; }, 'Zapisano'); if (!ok) { cb.checked = !cb.checked; return; } cb.checked ? have.add(f + '|' + r + '|' + p) : have.delete(f + '|' + r + '|' + p); });
        return cb; })())))));
      box.append(t);
    };
    sel.addEventListener('change', draw); draw();
    const ph = h('input', { placeholder: 'Numer telefonu postaci' }), gf = h('select', {}, ['*', ...d.factions].map((f) => h('option', {}, f))), gp = h('select', {}, Object.keys(d.catalog).filter((p) => !d.admin_only.includes(p)).map((p) => h('option', {}, p))), ge = h('select', {}, ['allow', 'deny', 'remove'].map((x) => h('option', {}, x)));
    el.append(h('div', { class: 'card' }, h('h3', {}, 'Uprawnienie dla konkretnej postaci'), h('div', { class: 'row' }, ph, gf, gp, ge), h('button', { style: 'margin-top:8px', onclick: () => act(async () => { const r = await api('/mdt/admin/grants', { body: { phone: ph.value.trim(), faction: gf.value, perm: gp.value, effect: ge.value } }); toast('Zapisano dla: ' + r.character); }) }, 'Zapisz')));
  };

  // start
  token = store.get('mdt_token');
  // skrót z telefonu (?sso=1): ta sama sesja postaci, ale MDT dalej ma własny wylogowanie (mdt_token)
  try {
    const q = new URLSearchParams(location.search);
    if (!token && q.get('sso') === '1') { const t = store.get('afb_token'); if (t) { token = t; store.set('mdt_token', t); } }
    if (q.has('sso')) history.replaceState(null, '', location.pathname);
  } catch {}
  if (token) boot(); else showLogin();
})();
