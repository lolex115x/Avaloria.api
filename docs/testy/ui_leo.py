exec(open('mdt_common.py').read())
civ,ctok,cph=mk('Jan','Kierowca'); p1,p1t,_=mk('Piotr','Policjant'); f1,f1t,_=mk('Franek','Strazak'); e1,e1t,_=mk('Ewa','Medyk3')
mem(p1,'LAPD','SZEF'); mem(f1,'LAFD','PRACOWNIK'); mem(e1,'EMS','PRACOWNIK')
cur.execute("update customers set phone_on=true")
cur.execute("select phone_number from customers where customer_id=%s",(civ,)); ph=cur.fetchone()[0]
cur.execute("update accounts set balance=5000 where customer_id=%s",(civ,))
from playwright.sync_api import sync_playwright
def run(pg,tok,fac,steps):
    pg.add_init_script(f"localStorage.setItem('afb_token','{tok}')")
    pg.goto(B+'/'); pg.wait_for_timeout(1800)
    pg.evaluate(f"openFaction('{fac}')"); pg.wait_for_timeout(1000)
    tabs=pg.eval_on_selector_all('.ftabs button','els=>els.map(e=>e.textContent.trim())'); print(fac,'zakladki:',tabs)
    return tabs
with sync_playwright() as p:
    br=p.chromium.launch(); errs=[]
    def new(tok):
        pg=br.new_context(viewport={'width':380,'height':800}).new_page(); pg.on('dialog',lambda d:d.accept()); pg.on('pageerror',lambda e:errs.append(str(e))); return pg
    pg=new(p1t); tabs=run(pg,p1t,'LAPD',None)
    for t in ['Osoby','Pojazdy','Poszukiwani','Raporty','Mandat']: ok(t in tabs,'LAPD ma zakladke '+t)
    pg.click('.ftabs button:has-text("Mandat")'); pg.wait_for_timeout(500)
    pg.fill('#fi-phone',ph) if pg.query_selector('#fi-phone') else print('brak #fi-phone', pg.inner_html('#fac-body')[:300])
    pg.fill('#fi-amount','250'); pg.fill('#fi-title','Parkowanie'); pg.click('#fac-body button:has-text("Wystaw mandat")'); pg.wait_for_timeout(900)
    print('wystaw:', pg.inner_text('#fac-body')[-120:].replace('\n',' | '))
    pg.click('.ftabs button:has-text("Osoby")'); pg.fill('#lp-q','Kierowca'); pg.wait_for_timeout(900)
    pg.click('#lp-res .tx-row >> nth=0'); pg.wait_for_timeout(900)
    txt=pg.inner_text('#fac-body'); ok('Mandaty' in txt and 'Parkowanie' in txt,'karta osoby pokazuje mandat z historii'); pg.screenshot(path='leo_person.png')
    pg.evaluate("facTab('pojazdy')"); pg.wait_for_timeout(500)
    pg.fill('#lv-plate','UI-'+rs()[:4]); pg.fill('#lv-model','Camaro'); pg.fill('#lv-owner',ph); pg.click('#fac-body button:has-text("Dodaj")'); pg.wait_for_timeout(700); ok('Pojazd dodany' in pg.inner_text('#lv-msg'),'pojazd dodany z UI')
    pg.fill('#lv-q','Camaro'); pg.wait_for_timeout(900); ok('Camaro' in pg.inner_text('#lv-res'),'wyszukiwanie pojazdu')
    pg.evaluate("facTab('poszukiwani')"); pg.wait_for_timeout(500)
    pg.fill('#lw-name','Jan Kierowca'); pg.fill('#lw-reason','Ucieczka z miejsca'); pg.click('#fac-body button:has-text("Wystaw")'); pg.wait_for_timeout(900); ok('Ucieczka z miejsca' in pg.inner_text('#fac-body'),'wpis poszukiwania')
    pg.evaluate("facTab('raporty')"); pg.wait_for_timeout(500); pg.click('text=Nowy raport'); pg.wait_for_timeout(400)
    pg.fill('#lr-title','Raport z UI'); pg.fill('#lr-body','Opis zdarzenia testowego'); pg.click('#fac-body button:has-text("Zapisz")'); pg.wait_for_timeout(900); ok('Opis zdarzenia testowego' in pg.inner_text('#fac-body'),'raport zapisany i otwarty')
    pg.click('#fac-body button:has-text("Edytuj")'); pg.wait_for_timeout(400); pg.fill('#lr-body','Zmieniony opis'); pg.click('#fac-body button:has-text("Zapisz")'); pg.wait_for_timeout(900); ok('Zmieniony opis' in pg.inner_text('#fac-body') and 'Edycje' in pg.inner_text('#fac-body'),'edycja raportu z historia')
    pg.screenshot(path='leo_report.png')
    # platnik widzi Mandat
    pc=new(ctok); pc.add_init_script(f"localStorage.setItem('afb_token','{ctok}')"); pc.goto(B+'/'); pc.wait_for_timeout(1800)
    pc.evaluate("typeof loadInvoices=='function' && loadInvoices()"); pc.wait_for_timeout(900)
    body=pc.evaluate("document.getElementById('invoices-list').textContent"); ok('Mandat' in body,'platnik widzi etykiete Mandat')
    # LAFD
    pf=new(f1t); tabs=run(pf,f1t,'LAFD',None)
    ok('Raporty' in tabs and 'Osoby' not in tabs and 'Mandat' not in tabs,'LAFD: Raporty, bez Osoby/Mandat')
    # EMS i DOT bez zmian
    pe=new(e1t); tabs=run(pe,e1t,'EMS',None); ok('Kartoteka' in tabs and 'Wystaw' in tabs and 'Osoby' not in tabs,'EMS bez zmian')
    print('bledy JS:',errs); ok(not errs,'brak bledow JS')
