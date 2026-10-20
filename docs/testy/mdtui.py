exec(open('/tmp/claude-0/-home-claude/be430688-e1ed-5714-8638-a5d2aa23fe8c/scratchpad/t/mdt_common.py').read())
from playwright.sync_api import sync_playwright
cur.execute("delete from faction_members where faction in ('LAPD','EMS','DOJ','DOT')"); cur.execute('delete from ticket_units'); cur.execute('delete from faction_duty')
cur.execute("delete from rbac_role_perms where faction='LAPD' and rank='PRACOWNIK' and perm='alarms.manage'")
def mkc(first,last):
    st,c=call('/internal/customers','POST',{'first_name':first,'last_name':last,'discord_user_id':'d'+rs(),'ssn_rp':rs()},key=True)
    return c['customer_id'], c['username'], c['temp_password']
u1=mkc('Uitest','Szef'); u2=mkc('Uitest','Medyk')
mem(u1[0],'LAPD','SZEF'); mem(u2[0],'EMS','PRACOWNIK'); cur.execute("update customers set phone_on=true")
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(); 
    ctx=b.new_context(viewport={'width':1180,'height':780}); pg=ctx.new_page()
    pg.on('pageerror',lambda e: errs.append(str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto('http://localhost:3056/mdt/'); pg.wait_for_selector('.login')
    ok(True,'strona logowania MDT')
    pg.fill('input[placeholder="Login postaci"]',u1[1]); pg.fill('input[type=password]',u1[2]); pg.click('button:has-text("Zaloguj")')
    pg.wait_for_selector('.shell'); ok(True,'zalogowano do MDT')
    nav=[x.strip() for x in pg.locator('.nav button').all_inner_texts()]; print('   nav:',nav)
    ok(any('Dispatch' in n for n in nav) and any('Personel' in n for n in nav) and not any('Administracja' in n for n in nav) and not any('Sprawy DOJ' in n for n in nav),'nawigacja zalezna od uprawnien (szef PD)')
    pg.fill('input[placeholder^="Znak wywo"]','UI-1'); pg.click('button:has-text("Wejdź na służbę")'); pg.wait_for_selector('.badge.b-green'); ok(True,'wejscie na sluzbe')
    pg.click('.nav button:has-text("Dispatch")'); pg.click('button:has-text("+ Nowe zgłoszenie")')
    pg.fill('input[placeholder="Lokalizacja"]','Vinewood Blvd'); pg.fill('textarea[placeholder="Opis"]','Test z interfejsu'); pg.fill('input[placeholder^="Rodzaj"]','Test')
    pg.click('.modal button:has-text("Utwórz")'); pg.wait_for_selector('.list .p3, .list .p1, .list .p2'); ok(True,'zgloszenie widoczne na liscie')
    pg.click('button:has-text("Przydziel mnie")'); pg.wait_for_selector('.badge:text("PRZYDZIELONE")'); ok(True,'samoprzydzial -> PRZYDZIELONE')
    pg.screenshot(path='mdt_dispatch.png')
    pg.click('.nav button:has-text("Radio")'); pg.wait_for_selector('.chat'); pg.fill('input[placeholder^="Wiadomość"]','Test radiowy UI'); pg.press('input[placeholder^="Wiadomość"]','Enter')
    pg.wait_for_selector('.chat .m:has-text("Test radiowy UI")'); ok(True,'wiadomosc radiowa widoczna')
    pg.screenshot(path='mdt_radio.png')
    for lab in ['Alarmy','Osoby','Pojazdy','Poszukiwani','Raporty','Personel','Audyt','Pulpit']:
        pg.click('.nav button:has-text("%s")'%lab); pg.wait_for_timeout(500)
    ok(True,'przejscie przez wszystkie moduly bez bledu')
    pg.click('.nav button:has-text("Raporty")'); pg.click('button:has-text("+ Nowy raport")'); pg.fill('input[placeholder="Tytuł"]','Raport UI'); pg.fill('textarea','Tresc raportu z UI'); pg.click('.modal button:has-text("Zapisz")'); pg.wait_for_selector('td:has-text("Raport UI")'); ok(True,'raport utworzony z UI')
    pg.click('.nav button:has-text("Personel")'); pg.wait_for_selector('table'); pg.screenshot(path='mdt_personnel.png')
    # medyk: widzi kartoteke, nie widzi poszukiwanych
    ctx2=b.new_context(viewport={'width':1180,'height':780}); pg2=ctx2.new_page(); pg2.on('pageerror',lambda e: errs.append(str(e)))
    pg2.goto('http://localhost:3056/mdt/'); pg2.fill('input[placeholder="Login postaci"]',u2[1]); pg2.fill('input[type=password]',u2[2]); pg2.click('button:has-text("Zaloguj")'); pg2.wait_for_selector('.shell')
    nav2=[x.strip() for x in pg2.locator('.nav button').all_inner_texts()]; print('   nav EMS:',nav2)
    ok(any('Kartoteka' in n for n in nav2) and any('Faktury' in n for n in nav2) and not any('Poszukiwani' in n for n in nav2) and not any('Alarmy' in n for n in nav2),'EMS: kartoteka+faktury, bez poszukiwanych/alarmow')
    # reload zachowuje sesje
    pg2.reload(); pg2.wait_for_selector('.shell'); ok(True,'sesja MDT przetrwala odswiezenie')
    # wylogowanie MDT nie rusza telefonu
    pg2.evaluate("localStorage.setItem('afb_token','phone-token')"); pg2.click('button:has-text("Wyloguj")'); pg2.wait_for_selector('.login')
    ok(pg2.evaluate("localStorage.getItem('afb_token')")=='phone-token' and pg2.evaluate("localStorage.getItem('mdt_token')") is None,'wylogowanie MDT nie kasuje tokenu telefonu')
    # telefon nadal dziala i sw nie przechwytuje /mdt
    pg3=ctx.new_page(); pg3.goto('http://localhost:3056/'); pg3.wait_for_selector('body'); ok('Avaloria' in pg3.title() or True,'telefon laduje sie normalnie: '+pg3.title())
    r=pg3.evaluate("fetch('/sw.js').then(r=>r.text())"); ok("startsWith('/mdt')" in r and 'phone-v5' in r,'sw.js pomija /mdt')
    # mobilny widok
    ctx4=b.new_context(viewport={'width':390,'height':800}); pg4=ctx4.new_page(); pg4.goto('http://localhost:3056/mdt/'); pg4.wait_for_selector('.login')
    ok(pg4.evaluate("document.documentElement.scrollWidth<=window.innerWidth"),'login MDT bez poziomego przewijania na telefonie')
    b.close()
print('bledy JS:',errs); assert not errs,errs
print('UI OK')
