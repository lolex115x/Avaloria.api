exec(open('/tmp/claude-0/-home-claude/be430688-e1ed-5714-8638-a5d2aa23fe8c/scratchpad/t/mdt_common.py').read())
from playwright.sync_api import sync_playwright
def mkc(first,last):
    st,c=call('/internal/customers','POST',{'first_name':first,'last_name':last,'discord_user_id':'d'+rs(),'ssn_rp':rs()},key=True)
    return c['customer_id'], c['username'], c['temp_password']
u=mkc('Fon','Medyk'); d=mkc('Fon','Prokurator')
mem(u[0],'EMS','PRACOWNIK'); mem(d[0],'DOJ','PRACOWNIK')
def tok(x): return call('/customer/login','POST',{'username':x[1],'password':x[2]})[1]['token']
tu=tok(u); td=tok(d)
B2='http://localhost:3057'
import urllib.request
def get(base,t):
    r=urllib.request.Request(base+'/customer/factions/me',headers={'authorization':'Bearer '+t}); return json.load(urllib.request.urlopen(r))
a=get('http://localhost:3056',tu); b=get(B2,tu)
ok(a[0]['panel'] is True and a[0]['invoices'] is True,'domyslnie panel telefonu wlaczony: %s'%a[0]['panel'])
ok(b[0]['panel'] is False and b[0]['invoices'] is False,'PHONE_FACTION_PANELS=off chowa panel z telefonu')
ok(get('http://localhost:3056',td)[0]['panel'] is False,'DOJ nigdy nie jest panelem telefonu')
# legacy endpointy dzialaja takze przy fladze off (rollback bez utraty)
r=urllib.request.Request(B2+'/customer/factions/EMS/ops/dashboard',headers={'authorization':'Bearer '+tu}); ok(urllib.request.urlopen(r).status==200,'legacy endpoint dziala przy fladze off')
errs=[]
with sync_playwright() as p:
    br=p.chromium.launch()
    for base,label,expect_panel in [('http://localhost:3056','on',True),(B2,'off',False)]:
        ctx=br.new_context(viewport={'width':430,'height':900}); pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append(str(e)))
        pg.add_init_script("localStorage.setItem('afb_token','%s')"%tu); pg.goto(base+'/'); pg.wait_for_selector('#app-grid .app-icon',timeout=10000); pg.wait_for_timeout(1200)
        names=pg.locator('#app-grid .name').all_inner_texts(); print('   telefon (%s):'%label,names)
        for must in ['Bank','Ćwierk','Wiadomości','Kontakty','Sklep','Plecak','Ustawienia','Tablet MDT']: ok(must in names,'[%s] aplikacja telefonu: %s'%(label,must))
        ok(('Panel EMS' in names)==expect_panel,'[%s] Panel EMS w telefonie: %s'%(label,'Panel EMS' in names))
        if label=='on':
            with ctx.expect_page() as np_: pg.click('#app-grid .app-icon:has-text("Tablet MDT")')
            n=np_.value; n.wait_for_selector('.shell',timeout=8000); ok(True,'skrot z telefonu otwiera MDT zalogowany (sso)')
            ok('sso' not in n.url,'parametr sso usuniety z adresu')
    br.close()
ok(not errs,'bledy JS telefonu: %s'%errs)
