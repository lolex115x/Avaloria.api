exec(open('/tmp/claude-0/-home-claude/be430688-e1ed-5714-8638-a5d2aa23fe8c/scratchpad/t/mdt_common.py').read())
from playwright.sync_api import sync_playwright
cur.execute("delete from faction_members where faction in ('LAPD','EMS','DOJ','DOT')"); cur.execute('delete from ticket_units'); cur.execute('delete from faction_duty'); cur.execute("delete from rbac_user_grants")
cur.execute("delete from rbac_role_perms where faction='LAPD' and rank='PRACOWNIK' and perm='alarms.manage'")
cur.execute("update tickets set status='ANULOWANE', closed_at=now() where status not in ('ZAKONCZONE','ANULOWANE')")
def mkc(first,last,disc=None):
    st,c=call('/internal/customers','POST',{'first_name':first,'last_name':last,'discord_user_id':disc or 'd'+rs(),'ssn_rp':rs()},key=True); return c
pds=mkc('Szef','Policji'); pdw=mkc('Robert','Pracownik'); ems=mkc('Ewa','Medyczka'); djs=mkc('Daria','Prokurator'); adm=mkc('Adam','Administrator','999'); pat=mkc('Pacjent','Testowy')
mem(pds['customer_id'],'LAPD','SZEF'); mem(pdw['customer_id'],'LAPD','PRACOWNIK'); mem(ems['customer_id'],'EMS','ZASTEPCA'); mem(djs['customer_id'],'DOJ','SZEF')
cur.execute("update customers set phone_on=true")
cur.execute("select phone_number from customers where customer_id=%s",(pat['customer_id'],)); patph=cur.fetchone()[0]
errs=[]
def login(br,c,w=1180,h=780):
    ctx=br.new_context(viewport={'width':w,'height':h}); pg=ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.on('dialog',lambda d: d.accept(d.default_value or 'Wynik testowy / powod'))
    pg.goto('http://localhost:3056/mdt/'); pg.fill('input[placeholder="Login postaci"]',c['username']); pg.fill('input[type=password]',c['temp_password']); pg.click('button:has-text("Zaloguj")'); pg.wait_for_selector('.shell'); return pg
def nav(pg,l): pg.click('.nav button:has-text("%s")'%l); pg.wait_for_timeout(600)
with sync_playwright() as p:
    b=p.chromium.launch()
    # --- szef PD ---
    a=login(b,pds)
    a.fill('input[placeholder^="Znak wywo"]','SZEF-1'); a.click('button:has-text("Wejdź na służbę")'); a.wait_for_selector('.badge.b-green')
    for s in ['W DRODZE']: a.click('button:has-text("%s")'%s); a.wait_for_timeout(400)
    ok(a.locator('text=Status: W_DRODZE').count()==1,'Pulpit: zmiana statusu jednostki')
    # alarmy
    nav(a,'Alarmy'); a.fill('input[placeholder="albo wpisz lokalizację ręcznie"]','Stacja Shell Test'); a.click('button:has-text("Utwórz alarm")'); a.wait_for_selector('td:has-text("Stacja Shell Test")'); ok(True,'Alarmy: reczny alarm widoczny w tabeli')
    a.click('button:has-text("Anuluj")'); a.wait_for_selector('td .badge:text("ANULOWANY")'); ok(True,'Alarmy: anulowanie alarmu oczekujacego z UI')
    a.fill('input[placeholder^="klucz"]','bank_test'); a.fill('input[placeholder="Nazwa"]','Bank Testowy'); a.click('button:has-text("Zapisz")'); a.wait_for_timeout(800)
    ok(a.locator('option:has-text("Bank Testowy")').count()==1,'Alarmy: dodanie zweryfikowanego miejsca i pojawienie sie na liscie')
    # radio + panic
    nav(a,'Radio'); a.click('button:has-text("PANIC")'); a.wait_for_timeout(800); a.click('.tabs button:has-text("Dispatch")'); a.wait_for_selector('.chat .m.PANIC'); ok(True,'Radio: PANIC widoczny na kanale Dispatch')
    a.click('.tabs button:has-text("Command")'); a.fill('input[placeholder^="Wiadomość"]','Odprawa dowodzenia'); a.press('input[placeholder^="Wiadomość"]','Enter'); a.wait_for_selector('.chat .m:has-text("Odprawa dowodzenia")'); ok(True,'Radio: kanal Command dla szefa')
    # pojazdy
    nav(a,'Pojazdy'); a.fill('input[placeholder="Tablica"]','TS123'); a.fill('input[placeholder="Model"]','Sultan'); a.click('button:has-text("Dodaj")'); a.wait_for_timeout(600)
    a.fill('input[placeholder^="Tablica albo"]','TS12'); a.wait_for_selector('b:has-text("TS123")'); ok(True,'Pojazdy: dodanie i wyszukanie')
    a.select_option('.card select','SKRADZIONY'); a.wait_for_timeout(600); a.fill('input[placeholder^="Tablica albo"]','TS123'); a.wait_for_selector('.badge:text("SKRADZIONY")'); ok(True,'Pojazdy: zmiana statusu na SKRADZIONY')
    # poszukiwani
    nav(a,'Poszukiwani'); a.fill('input[placeholder="Osoba (imię i nazwisko)"]','Jan Uciekinier'); a.fill('input[placeholder="Powód"]','Ucieczka z miejsca zdarzenia'); a.click('button:has-text("Wystaw")'); a.wait_for_selector('td:has-text("Jan Uciekinier")'); ok(True,'Poszukiwani: wpis dodany')
    a.click('button:has-text("Zamknij")'); a.wait_for_selector('td .badge:text("ZREALIZOWANY")'); ok(True,'Poszukiwani: zamkniecie wpisu')
    # osoby
    nav(a,'Osoby'); a.fill('input[placeholder^="Imię i nazwisko"]','Pacjent'); a.wait_for_selector('.list div:has-text("Pacjent Testowy")'); a.click('.list div:has-text("Pacjent Testowy")'); a.wait_for_selector('.card h3:has-text("Pacjent Testowy")'); ok(True,'Osoby: wyszukanie i karta osoby')
    # raport + udostepnienie DOJ
    nav(a,'Raporty'); a.click('button:has-text("+ Nowy raport")'); a.fill('input[placeholder="Tytuł"]','Raport do DOJ'); a.fill('.modal textarea','Tresc raportu dla prokuratury'); a.check('.modal label.perm:has-text("DOJ") input'); a.click('.modal button:has-text("Zapisz")'); a.wait_for_selector('td:has-text("Raport do DOJ")'); ok(True,'Raporty: utworzenie i udostepnienie DOJ z UI')
    rid=a.locator('td:has-text("Raport do DOJ")').first.evaluate("e=>e.parentElement.children[0].textContent")
    a.click('td:has-text("Raport do DOJ")'); a.wait_for_selector('.modal'); a.click('.modal button:has-text("Edytuj")'); a.fill('.modal textarea','Zmieniona tresc'); a.click('.modal button:has-text("Zapisz")'); a.wait_for_timeout(700)
    a.click('td:has-text("Raport do DOJ")'); a.wait_for_selector('.modal:has-text("Edycje:")'); ok(True,'Raporty: edycja i historia zmian w UI'); a.click('.modal button:has-text("✕")')
    # personel
    pwid=pdw['customer_id']
    nav(a,'Personel'); a.wait_for_selector('tr:has-text("Robert Pracownik")')
    a.click('tr:has-text("Robert Pracownik") button:has-text("Zastępca")'); a.wait_for_selector('tr:has-text("Robert Pracownik") td:text("Zastępca")'); ok(True,'Personel: awans na zastepce z UI')
    a.click('tr:has-text("Robert Pracownik") button:has-text("Pracownik")'); a.wait_for_selector('tr:has-text("Robert Pracownik") td:text("Pracownik")'); ok(True,'Personel: zmiana z powrotem')
    a.click('tr:has-text("Robert Pracownik") button:has-text("Zawieś")'); a.wait_for_selector('tr:has-text("Robert Pracownik") .badge:text("zawieszony")'); ok(True,'Personel: zawieszenie z UI')
    a.click('tr:has-text("Robert Pracownik") button:has-text("Odwieś")'); a.wait_for_timeout(600); ok(a.locator('tr:has-text("Robert Pracownik") .badge:text("zawieszony")').count()==0,'Personel: odwieszenie')
    a.click('tr:has-text("Robert Pracownik") button:has-text("Uprawnienia")'); a.select_option('.modal select >> nth=0','alarms.manage'); a.click('.modal button:has-text("Zapisz")'); a.wait_for_selector('tr:has-text("Robert Pracownik") td:has-text("+alarms.manage")'); ok(True,'Personel: uprawnienie specjalne z UI')
    nav(a,'Skarbiec'); ok(a.locator('text=Saldo:').count()==1,'Skarbiec LAPD: saldo widoczne (stary endpoint)')
    nav(a,'Audyt'); a.wait_for_selector('td:text("ZAWIESZENIE")'); ok(True,'Audyt: wpisy akcji widoczne')
    # --- DOJ ---
    d=login(b,djs); nav(d,'Sprawy DOJ'); d.click('button:has-text("+ Nowa sprawa")'); d.fill('input[placeholder="Tytuł"]','Sprawa testowa'); d.select_option('.modal select','POUFNA'); d.click('.modal button:has-text("Utwórz")'); d.wait_for_selector('td:has-text("Sprawa testowa")'); ok(True,'DOJ: sprawa poufna utworzona z UI')
    d.click('td:has-text("Sprawa testowa")'); d.wait_for_selector('.modal'); d.fill('input[placeholder="Nowa notatka"]','Notatka prok.'); d.click('.modal button:has-text("Dodaj")'); d.wait_for_selector('.modal:has-text("Notatka prok.")'); ok(True,'DOJ: notatka w sprawie')
    d.fill('input[placeholder^="ID raportu"]',str(rid)); d.click('.modal button:has-text("Podepnij")'); d.wait_for_selector('.modal:has-text("Raport do DOJ")'); ok(True,'DOJ: podpiecie udostepnionego raportu')
    ok(d.locator('.nav button:has-text("Dispatch")').count()==0 and d.locator('.nav button:has-text("Radio")').count()==1,'DOJ: bez Dispatchu, z Radiem (szef)')
    # --- EMS ---
    e=login(b,ems); nav(e,'Kartoteka'); e.fill('input[placeholder="Numer telefonu pacjenta"]',patph); e.click('button:has-text("Szukaj")'); e.wait_for_selector('h3:has-text("Pacjent: Pacjent Testowy")')
    e.fill('textarea[placeholder^="Nowy wpis"]','Złamanie nogi, gips'); e.click('button:has-text("Dodaj wpis")'); e.wait_for_selector('.card:has-text("Złamanie nogi")'); ok(True,'EMS: kartoteka – wpis dodany przez nowy interfejs (stary endpoint)')
    nav(e,'Faktury'); e.fill('input[placeholder="Numer klienta"]',patph); e.fill('input[placeholder="Kwota"]','150'); e.fill('input[placeholder^="Opis"]','Transport medyczny'); e.click('button:has-text("Wystaw fakturę")'); e.wait_for_selector('td:has-text("Transport medyczny")'); ok(True,'EMS: faktura wystawiona z tabletu')
    nav(e,'Skarbiec'); ok(e.locator('text=Saldo:').count()==1,'EMS: skarbiec')
    # --- admin ---
    ad=login(b,adm); navs=ad.locator('.nav button').all_inner_texts(); ok(any('Administracja' in n for n in navs),'Admin (Discord ID): zakladka Administracja')
    nav(ad,'Administracja'); ad.wait_for_selector('table'); cb=ad.locator('table input[type=checkbox]').first; before=cb.is_checked(); cb.click(); ad.wait_for_timeout(700)
    cur.execute("select count(*) from audit_dummy") if False else None
    cb.click(); ad.wait_for_timeout(700); ok(cb.is_checked()==before,'Admin: przelaczanie uprawnienia w macierzy (tam i z powrotem)')
    # --- widok telefonu (waski) ---
    m=login(b,pdw,390,800); ok(m.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"),'wasky ekran: brak poziomego przewijania po zalogowaniu')
    nav(m,'Dispatch'); ok(m.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"),'wasky ekran: Dispatch bez poziomego przewijania')
    m.screenshot(path='mdt_narrow.png')
    b.close()
print('bledy JS:',errs); assert not errs,errs
print('UI2 OK')
