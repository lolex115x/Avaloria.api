from playwright.sync_api import sync_playwright
import json
def ok(c,m): print(('OK   ' if c else 'FAIL ')+m); assert c,m
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1180,'height':780}); pg=ctx.new_page()
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    cdp=ctx.new_cdp_session(pg)
    pg.goto('http://localhost:3056/mdt/'); pg.wait_for_selector('.login'); pg.wait_for_timeout(1500)
    m=pg.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.json())")
    ok(m['scope']=='/mdt/' and m['start_url']=='/mdt/' and m['name']=='Avaloria MDT' and m['orientation']=='landscape','manifest MDT: osobny zakres, nazwa i start')
    for ic in m['icons']:
        r=pg.evaluate("u=>fetch(u).then(r=>[r.status,r.headers.get('content-type')])",ic['src']); ok(r[0]==200 and 'png' in r[1],'ikona '+ic['src'])
    reg=pg.evaluate("navigator.serviceWorker.getRegistration('/mdt/').then(r=>r&&r.scope)"); ok(reg and reg.endswith('/mdt/'),'service worker MDT zarejestrowany w zakresie /mdt/')
    pg.wait_for_timeout(1000)
    ctl=pg.evaluate("!!navigator.serviceWorker.controller"); 
    pg.reload(); pg.wait_for_selector('.login'); ctl=pg.evaluate("navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL"); ok(ctl and ctl.endswith('/mdt/sw.js'),'strone /mdt/ kontroluje sw MDT (nie telefonu): '+str(ctl))
    # API w zakresie /mdt/ nie jest cache'owane / przechwytywane
    r=pg.evaluate("fetch('/mdt/me').then(r=>r.status)"); ok(r==401,'/mdt/me idzie do serwera (401 bez tokenu)')
    # instalowalnosc wg Chromium
    try:
        err=cdp.send('Page.getInstallabilityErrors'); ok(err['installabilityErrors']==[],'brak bledow instalowalnosci: %s'%err['installabilityErrors'])
    except Exception as e: print('   (CDP):',e)
    # telefon: swoj sw, swoj manifest
    ph=ctx.new_page(); ph.goto('http://localhost:3056/'); ph.wait_for_timeout(1500)
    pm=ph.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.json())"); ok(pm['name']=='AvaloriaRP Telefon' and pm['scope']=='/','telefon dalej ma swoj manifest')
    ok(not errs,'bledy JS: %s'%errs)
    b.close()
