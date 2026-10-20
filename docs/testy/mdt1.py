import json, urllib.request, urllib.error, psycopg2, random
B='http://localhost:3056'
def call(path, method='GET', body=None, tok=None, key=False, fac=None):
    h={'content-type':'application/json'}
    if tok: h['authorization']='Bearer '+tok
    if key: h['x-api-key']='k'
    if fac: h['x-mdt-faction']=fac
    r=urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try: return 200, json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return e.code, json.load(e)
rs=lambda: str(random.randint(10**8,10**9))
def mk(first,last,disc=None):
    st,c=call('/internal/customers','POST',{'first_name':first,'last_name':last,'discord_user_id':disc or 'd'+rs(),'ssn_rp':rs()},key=True); assert st==200,c
    st,l=call('/customer/login','POST',{'username':c['username'],'password':c['temp_password']}); return c['customer_id'], l['token'], c['phone_number'] if 'phone_number' in c else None
db=psycopg2.connect('dbname=avtest user=postgres password=pw host=localhost'); db.autocommit=True; cur=db.cursor()
def ok(c,m): print(('OK   ' if c else 'FAIL ')+m); assert c,m
def mem(cid,f,r): cur.execute("insert into faction_members(customer_id,faction,rank) values(%s,%s,%s) on conflict (customer_id,faction) do update set rank=excluded.rank, suspended=false",(cid,f,r))
cur.execute("update customers set phone_on=true")
cur.execute("delete from faction_members where faction in ('LAPD','EMS','DOJ')"); cur.execute('delete from ticket_units'); cur.execute('delete from faction_duty')
cur.execute("update tickets set status='ANULOWANE', closed_at=now() where status not in ('ZAKONCZONE','ANULOWANE')")
civ,ctok,_=mk('Cywil','Zwykly')
p1,p1t,_=mk('Piotr','Policjant'); p2,p2t,_=mk('Pawel','Policjant2'); pz,pzt,_=mk('Zenon','ZastepcaPD'); ps,pst,_=mk('Szymon','SzefPD')
e1,e1t,_=mk('Ewa','Medyk'); ad,adt,_=mk('Adam','Admin','999'); dj,djt,_=mk('Dorota','Prokurator')
mem(p1,'LAPD','PRACOWNIK'); mem(p2,'LAPD','PRACOWNIK'); mem(pz,'LAPD','ZASTEPCA'); mem(ps,'LAPD','SZEF'); mem(e1,'EMS','PRACOWNIK'); mem(dj,'DOJ','PRACOWNIK')
cur.execute("update customers set phone_on=true")
# dostęp
st,r=call('/mdt/me'); ok(st==401,'bez tokenu -> 401')
st,r=call('/mdt/me',tok=ctok); ok(st==403,'cywil bez frakcji -> 403')
st,r=call('/mdt/me',tok=p1t); ok(st==200 and r['active']['faction']=='LAPD' and 'dispatch.access' in r['perms'],'policjant: me ok, modul dispatch')
ok('admin' not in [m['key'] for m in r['modules']] and 'personnel' not in [m['key'] for m in r['modules']],'pracownik nie widzi admin/personnel')
st,r=call('/mdt/me',tok=djt); ok(st==200 and 'dispatch' not in [m['key'] for m in r['modules']] and 'doj' in [m['key'] for m in r['modules']],'DOJ: bez dispatchu, ze sprawami')
st,r=call('/mdt/dispatch/state',tok=djt); ok(st==403,'DOJ -> dispatch 403')
st,r=call('/mdt/me',tok=adt); ok(st==200 and r['admin'],'admin po discord id (bez frakcji) ma dostep')
# naglowek frakcji: nie mozna udawac cudzej
st,r=call('/mdt/me',tok=p1t,fac='EMS'); ok(r['active']['faction']=='LAPD','X-MDT-Faction=EMS bez czlonkostwa ignorowany')
# sluzba
st,r=call('/mdt/duty','POST',{'on':True,'callsign':'adam-12'},tok=p1t); ok(st==200,'p1 na sluzbie')
st,r=call('/mdt/duty','POST',{'on':True,'callsign':'ADAM-12'},tok=p2t); ok(st==409,'duplikat znaku wywolawczego -> 409')
st,r=call('/mdt/duty','POST',{'on':True,'callsign':'ADAM-13'},tok=p2t); ok(st==200,'p2 na sluzbie')
st,r=call('/mdt/duty','POST',{'on':True,'callsign':'EMS-1'},tok=e1t); ok(st==200,'ems na sluzbie')
st,r=call('/mdt/duty','POST',{'on':True,'callsign':'CMD-1'},tok=pzt); ok(st==200,'zastepca na sluzbie')
# dispatch
st,r=call('/mdt/dispatch/calls','POST',{'location':'Vinewood','description':'Napad na sklep','priority':1,'kind':'Napad','also_factions':['EMS','LAFD']},tok=p1t); ok(st==200,'utworzono zgloszenie'); tid=r['ticket_id']
st,s=call('/mdt/dispatch/state',tok=e1t); ok(any(c['ticket_id']==tid for c in s['calls']),'EMS widzi wspolne zgloszenie')
st,s2=call('/mdt/dispatch/state?rev=%d'%s['rev'],tok=e1t); ok(s2.get('unchanged'),'polling rev: unchanged')
st,s=call('/mdt/dispatch/state',tok=djt); 
# LAFD nikt nie ma - ale EMS widzi, a cywil/inna frakcja nie
st,r=call('/mdt/dispatch/calls','POST',{'location':'x','description':'abc','faction':'EMS'},tok=p1t); ok(st==403,'pracownik nie kieruje glownie do cudzej frakcji')
st,r=call('/mdt/dispatch/calls/%d/assign'%tid,'POST',{'customer_id':p2},tok=p1t); ok(st==403,'pracownik nie przydziela innych')
st,r=call('/mdt/dispatch/calls/%d/assign'%tid,'POST',{},tok=p1t); ok(st==200,'samoprzydzial p1')
st,r=call('/mdt/dispatch/calls/%d/assign'%tid,'POST',{'customer_id':p2},tok=pzt); ok(st==200,'zastepca przydziela p2')

st,r=call('/mdt/dispatch/calls/%d/assign'%tid,'POST',{'customer_id':e1},tok=pzt); ok(st==200,'zastepca przydziela medyka (wspolna frakcja)')
# konflikt: ta sama jednostka na drugie zgloszenie
st,r=call('/mdt/dispatch/calls','POST',{'location':'Port','description':'Kolizja'},tok=p1t); t2=r['ticket_id']
st,r=call('/mdt/dispatch/calls/%d/assign'%t2,'POST',{},tok=p1t); ok(st==409,'jednostka zajeta -> 409')
st,s=call('/mdt/dispatch/state',tok=p1t); c=[x for x in s['calls'] if x['ticket_id']==tid][0]; ok(c['status']=='PRZYDZIELONE' and len(c['units'])==3,'status PRZYDZIELONE, 3 jednostki')
# statusy
st,r=call('/mdt/dispatch/calls/%d/status'%tid,'POST',{'status':'W_DRODZE'},tok=p1t); ok(st==200,'PRZYDZIELONE->W_DRODZE')
st,r=call('/mdt/dispatch/calls/%d/status'%tid,'POST',{'status':'NOWE'},tok=p1t); ok(st==409,'nielegalne przejscie -> 409')
st,r=call('/mdt/dispatch/calls/%d/status'%tid,'POST',{'status':'ZAKONCZONE'},tok=p1t); ok(st==400,'zamkniecie bez wyniku -> 400')
st,r=call('/mdt/dispatch/calls/%d/status'%tid,'POST',{'status':'ZAKONCZONE','result':'Sprawca zatrzymany'},tok=djt); ok(st==403,'DOJ nie zamyka zgloszen (brak dispatch.access)')
st,r=call('/mdt/dispatch/calls/%d/status'%tid,'POST',{'status':'ZAKONCZONE','result':'Sprawca zatrzymany'},tok=p2t); ok(st==200,'przydzielony p2 zamyka')
cur.execute("select unit_status from faction_duty where customer_id=%s",(p1,)); ok(cur.fetchone()[0]=='DOSTEPNY','jednostka zwolniona po zamknieciu')
st,r=call('/mdt/dispatch/calls/%d/assign'%t2,'POST',{},tok=p1t); ok(st==200,'po zamknieciu mozna przydzielic do nowego')
# inne frakcje nie widza
st,s=call('/mdt/dispatch/state',tok=e1t); ok(not any(c['ticket_id']==t2 for c in s['calls']),'EMS nie widzi cudzego zgloszenia (t2)')
# personel / RBAC
st,r=call('/mdt/personnel',tok=p1t); ok(st==403,'pracownik: personel 403')
st,r=call('/mdt/personnel',tok=pst); ok(st==200 and len(r['people'])>=4,'szef widzi personel')
st,r=call('/mdt/personnel/%d/rank'%p1,'POST',{'rank':'ZASTEPCA'},tok=pst); ok(st==200,'szef awansuje na zastepce')
st,r=call('/mdt/personnel/%d/rank'%ps,'POST',{'rank':'PRACOWNIK'},tok=pst); ok(st==403,'szef nie zmieni wlasnej rangi')
st,r=call('/mdt/personnel/%d/rank'%p2,'POST',{'rank':'SZEF'},tok=pst); ok(st==400,'nie mozna nadac SZEF przez MDT')
st,r=call('/mdt/personnel/%d/rank'%ps,'POST',{'rank':'PRACOWNIK'},tok=pzt); ok(st==403,'zastepca bez faction.ranks.manage -> 403')
st,r=call('/mdt/personnel/%d/grants'%p2,'POST',{'perm':'alarms.manage','effect':'allow'},tok=pst); ok(st==200,'szef nadaje grant')
st,r=call('/mdt/me',tok=p2t); ok('alarms.manage' in r['perms'],'grant widoczny w uprawnieniach')
st,r=call('/mdt/personnel/%d/grants'%p2,'POST',{'perm':'admin.system.manage','effect':'allow'},tok=pst); ok(st==400,'admin.system.manage nie do nadania')
st,r=call('/mdt/personnel/%d/grants'%p2,'POST',{'perm':'doj.cases.classified','effect':'allow'},tok=pst); ok(st==403,'nie nadasz czego sam nie masz')
st,r=call('/mdt/personnel/%d/grants'%p2,'POST',{'perm':'radio.access','effect':'deny'},tok=pst); st,r=call('/mdt/me',tok=p2t); ok('radio.access' not in r['perms'],'deny odbiera uprawnienie z rangi')
# zawieszenie
st,r=call('/mdt/personnel/%d/suspend'%p2,'POST',{'on':True,'reason':'test'},tok=pst); ok(st==200,'zawieszenie')
st,r=call('/mdt/me',tok=p2t); ok(st==403,'zawieszony traci dostep do MDT')
cur.execute("select count(*) from faction_duty where customer_id=%s",(p2,)); ok(cur.fetchone()[0]==0,'zawieszony zdjety ze sluzby')
st,r=call('/mdt/personnel/%d/suspend'%ps,'POST',{'on':True},tok=pzt); ok(st==403,'zastepca bez uprawnien nie zawiesza')
st,r=call('/mdt/personnel/%d/suspend'%ps,'POST',{'on':True},tok=pst); ok(st==403,'nie zawiesisz siebie')
# audyt
st,r=call('/mdt/audit',tok=p1t); ok(st==200 and len(r)>0,'zastepca (po awansie) czyta audyt: %d wpisow'%len(r))
st,r=call('/mdt/audit',tok=e1t); ok(st==403,'pracownik audytu nie czyta')
# admin
st,r=call('/mdt/admin/rbac',tok=pst); ok(st==403,'szef nie jest adminem systemu')
st,r=call('/mdt/admin/rbac',tok=adt); ok(st==200 and len(r['matrix'])>50,'admin widzi macierz (%d)'%len(r['matrix']))
st,r=call('/mdt/admin/rbac/role','POST',{'faction':'LAPD','rank':'PRACOWNIK','perm':'alarms.manage','on':True},tok=adt); ok(st==200,'admin edytuje macierz')
# restart nie przywraca domyslnych: marker
cur.execute("select count(*) from mdt_meta where key='rbac_seed_v1'"); ok(cur.fetchone()[0]==1,'seed oznaczony (jednorazowy)')
# wewnetrzny grant
st,r=call('/internal/mdt/grant','POST',{'phone':'x','faction':'LAPD','perm':'alarms.manage'},key=True); ok(st==404,'internal grant: zly numer 404')
st,r=call('/internal/mdt/grant','POST',{'phone':'x','faction':'LAPD','perm':'alarms.manage'}); ok(st in (401,403),'internal bez klucza odrzucony')
# legacy panel nadal dziala
st,r=call('/customer/factions/me',tok=p1t); ok(st==200 and r[0]['faction']=='LAPD','legacy /customer/factions/me dziala')
st,r=call('/customer/factions/me',tok=djt); ok(st==200 and r[0]['panel']==False,'DOJ nie jest panelem telefonu')
st,r=call('/customer/factions/LAPD/ops/tickets?status=open',tok=p1t); ok(st==200,'legacy lista zgloszen dziala (%s)'%st)
print('WSZYSTKO OK')
