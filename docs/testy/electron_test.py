exec(open('/tmp/claude-0/-home-claude/be430688-e1ed-5714-8638-a5d2aa23fe8c/scratchpad/t/mdt_common.py').read())
import subprocess, time, os, signal
from playwright.sync_api import sync_playwright
st,c=call('/internal/customers','POST',{'first_name':'Electron','last_name':'Test','discord_user_id':'d'+rs(),'ssn_rp':rs()},key=True)
mem(c['customer_id'],'LAPD','ZASTEPCA'); cur.execute("update customers set phone_on=true")
UD='/tmp/el-userdata'; os.system('rm -rf '+UD)
def launch():
    env=dict(os.environ); 
    p=subprocess.Popen(['xvfb-run','-a','./node_modules/.bin/electron','.','--no-sandbox','--remote-debugging-port=9333','--user-data-dir='+UD],cwd='el',env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    return p
def kill(p, graceful=True):
    # zamkniecie okna jak przez uzytkownika (X), potem twardy kill tylko jako zabezpieczenie
    if graceful:
        try:
            with sync_playwright() as q:
                b=q.chromium.connect_over_cdp('http://localhost:9333'); b.contexts[0].pages[0].evaluate("window.close()")
        except Exception: pass
        time.sleep(4)
    try: os.killpg(os.getpgid(p.pid),signal.SIGKILL)
    except Exception: pass
    os.system("pkill -f '[e]lectron.*remote-debugging-port=9333' 2>/dev/null")
    import socket
    for _ in range(30):
        s_=socket.socket(); s_.settimeout(.3)
        try: s_.connect(('127.0.0.1',9333)); s_.close(); time.sleep(.5)
        except Exception: break
    time.sleep(1)
def attach(pw):
    for _ in range(40):
        try:
            b=pw.chromium.connect_over_cdp('http://localhost:9333'); 
            for _ in range(30):
                pgs=[pg for ctx in b.contexts for pg in ctx.pages]
                if pgs: return b,pgs[0]
                time.sleep(.5)
        except Exception: time.sleep(.5)
    raise SystemExit('nie podlaczono do Electrona')
with sync_playwright() as pw:
    p=launch(); b,pg=attach(pw)
    pg.wait_for_selector('.login',timeout=15000); ok(True,'Electron: okno ladowalo /mdt/ i pokazalo logowanie')
    ok(pg.title()=='Avaloria MDT' and pg.url.endswith('/mdt/'),'tytul i adres: %s %s'%(pg.title(),pg.url))
    ok(pg.evaluate("typeof require")=='undefined' and pg.evaluate("typeof process")=='undefined','izolacja: strona nie ma dostepu do Node (bezpieczenstwo)')
    pg.fill('input[placeholder="Login postaci"]',c['username']); pg.fill('input[type=password]',c['temp_password']); pg.click('button:has-text("Zaloguj")'); pg.wait_for_selector('.shell'); ok(True,'logowanie w programie desktopowym')
    nav=pg.locator('.nav button').all_inner_texts(); ok(any('Dispatch' in n for n in nav),'modul Dispatch widoczny')
    sz=pg.evaluate("[innerWidth,innerHeight]"); ok(sz[0]>=900,'okno ma rozmiar tabletu: %s'%sz)
    # link zewnetrzny nie otwiera sie w programie
    n0=len([x for ctx in b.contexts for x in ctx.pages]); pg.evaluate("window.open('https://example.com','_blank')"); time.sleep(1.5)
    n1=len([x for ctx in b.contexts for x in ctx.pages]); ok(n1==n0,'obcy link nie tworzy nowego okna w programie')
    # nawigacja poza serwer zablokowana
    pg.evaluate("location.href='https://example.com/'"); time.sleep(2); ok(pg.url.startswith('http://localhost:3056'),'program nie opuszcza serwera MDT: %s'%pg.url)
    kill(p)
    # restart: sesja zapamietana tylko w tej aplikacji
    p=launch(); b,pg=attach(pw); pg.wait_for_selector('.shell',timeout=15000); ok(True,'po ponownym uruchomieniu programu sesja zapamietana (bez logowania)')
    # F11 pelny ekran / F5
    pg.keyboard.press('F5'); pg.wait_for_selector('.shell',timeout=15000); ok(True,'F5 odswieza i zostaje zalogowany')
    kill(p)
    # brak serwera: program ponawia
    os.system('fuser -k 3056/tcp >/dev/null 2>&1'); time.sleep(1)
    p=launch(); time.sleep(6); b,pg=attach(pw)
    os.system("cd /tmp/claude-0/-home-claude/be430688-e1ed-5714-8638-a5d2aa23fe8c/scratchpad/t/api4 && (DATABASE_URL=postgres://postgres:pw@localhost/avtest INTERNAL_API_KEY=k PORT=3056 MDT_ADMIN_DISCORD_IDS=999 nohup node index.js > ../api4.log 2>&1 &)")
    pg.wait_for_selector('.shell, .login',timeout=40000); ok(True,'serwer byl wylaczony przy starcie -> program sam sie polaczyl po jego uruchomieniu')
    kill(p)
print('ELECTRON OK')
