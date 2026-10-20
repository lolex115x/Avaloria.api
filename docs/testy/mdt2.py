exec(open('/tmp/claude-0/-home-claude/be430688-e1ed-5714-8638-a5d2aa23fe8c/scratchpad/t/mdt_common.py').read())
import time
cur.execute("delete from faction_members where faction in ('LAPD','EMS','DOJ','DOT')"); cur.execute('delete from ticket_units'); cur.execute('delete from faction_duty')
cur.execute("delete from rbac_role_perms where faction='LAPD' and rank='PRACOWNIK' and perm='alarms.manage'")
cur.execute("delete from rbac_user_grants")
civ,ctok,_=mk('Cywil','Zwykly'); p1,p1t,_=mk('Piotr','Policjant'); ps,pst,_=mk('Szymon','SzefPD'); e1,e1t,_=mk('Ewa','Medyk')
dj,djt,_=mk('Dorota','Prokurator'); ds,dst,_=mk('Daniel','SzefDOJ'); d1,d1t,_=mk('Dawid','Drogowiec')
mem(p1,'LAPD','PRACOWNIK'); mem(ps,'LAPD','SZEF'); mem(e1,'EMS','PRACOWNIK'); mem(dj,'DOJ','PRACOWNIK'); mem(ds,'DOJ','SZEF'); mem(d1,'DOT','PRACOWNIK')
cur.execute("update customers set phone_on=true")
tag=rs()[:4]
# osoby
st,r=call('/mdt/persons?q=Cywil',tok=p1t); ok(st==200 and any(x['customer_id']==civ for x in r),'wyszukiwanie osoby po nazwisku')
st,r=call('/mdt/persons?q=Cywil',tok=ctok); ok(st==403,'cywil nie szuka osob')
st,r=call('/mdt/persons?q=svc',tok=p1t); ok(all('svc' not in (x['last_name'] or '').lower() for x in r),'konta svc/npc ukryte')
# pojazdy
plate='AB'+tag
st,r=call('/mdt/vehicles','POST',{'plate':plate.lower(),'model':'Sultan','owner_customer_id':civ},tok=p1t); ok(st==200,'pracownik PD dodaje pojazd'); vid=r['vehicle_id']
st,r=call('/mdt/vehicles','POST',{'plate':plate},tok=p1t); ok(st==409,'duplikat tablicy 409')
st,r=call('/mdt/vehicles','POST',{'plate':'ZZ'+tag},tok=e1t); ok(st==403,'EMS nie dodaje pojazdow')
st,r=call('/mdt/vehicles?q='+plate[:4],tok=e1t); ok(st==200 and any(x['plate']==plate for x in r),'EMS wyszukuje pojazd (read)')
st,r=call('/mdt/vehicles/%d/status'%vid,'POST',{'status':'SKRADZIONY'},tok=p1t); ok(st==200,'status pojazdu')
st,r=call('/mdt/vehicles/%d/status'%vid,'POST',{'status':'COS'},tok=p1t); ok(st==400,'zly status 400')
# poszukiwani
st,r=call('/mdt/warrants','POST',{'subject_customer_id':civ,'reason':'Napad','kind':'POSZUKIWANY'},tok=p1t); ok(st==200,'wystawiony list gończy'); wid=r['id']
st,r=call('/mdt/warrants',tok=e1t); ok(st==403,'EMS nie widzi poszukiwanych')
st,r=call('/mdt/warrants',tok=djt); ok(st==200 and any(x['id']==wid for x in r),'DOJ widzi poszukiwanych')
st,r=call('/mdt/persons/%d'%civ,tok=p1t); ok(st==200 and len(r['warrants'])>=1 and len(r['vehicles'])==1,'karta osoby: poszukiwanie + pojazd')
st,r=call('/mdt/warrants/%d/close'%wid,'POST',{},tok=djt); ok(st==403,'DOJ nie zamknie cudzego wpisu')
st,r=call('/mdt/warrants/%d/close'%wid,'POST',{},tok=pst); ok(st==200,'szef PD zamyka (manage)')
st,r=call('/mdt/warrants/%d/close'%wid,'POST',{},tok=pst); ok(st==409,'drugie zamkniecie 409')
# raporty
st,r=call('/mdt/reports','POST',{'title':'Napad na sklep','body':'Szczegoly...','subject_customer_id':civ},tok=p1t); ok(st==200,'raport'); rid=r['id']
st,r=call('/mdt/reports','POST',{'title':'Poufna notatka','body':'tajne info','classification':'POUFNA'},tok=p1t); secret=r['id']
st,r=call('/mdt/reports/%d'%rid,tok=e1t); ok(st==404,'inna frakcja nie czyta raportu')
st,r=call('/mdt/reports/%d'%rid,tok=djt); ok(st==404,'DOJ nie czyta raportu PD przed udostepnieniem')
st,r=call('/mdt/reports/%d/edit'%rid,'POST',{'shared_with':['DOJ']},tok=p1t); ok(st==200,'autor udostepnia DOJ')
st,r=call('/mdt/reports/%d'%rid,tok=djt); ok(st==200,'DOJ czyta udostepniony raport')
st,r=call('/mdt/reports/%d/edit'%secret,'POST',{'shared_with':['DOJ']},tok=p1t); st,r=call('/mdt/reports/%d'%secret,tok=djt); ok(st==404,'poufny nie jest czytelny nawet po udostepnieniu')
st,r=call('/mdt/reports',tok=pst); ok(any(x['id']==secret for x in r),'szef (manage) widzi poufny raport wlasnej frakcji')

st,r=call('/mdt/reports',tok=p1t); ok(any(x['id']==secret for x in r),'autor widzi wlasny poufny')
st,r=call('/mdt/reports/%d/edit'%rid,'POST',{'body':'Zmieniona tresc raportu'},tok=p1t); ok(st==200,'autor edytuje')
st,r=call('/mdt/reports/%d'%rid,tok=p1t); ok(len(r['edits'])>=1,'historia edycji zapisana')
st,r=call('/mdt/reports/%d/edit'%rid,'POST',{'status':'ZAMKNIETY'},tok=p1t); ok(st==403,'autor nie zamyka raportu')
st,r=call('/mdt/reports/%d/edit'%rid,'POST',{'status':'ZAMKNIETY'},tok=pst); ok(st==200,'szef zamyka')
st,r=call('/mdt/reports/%d/edit'%rid,'POST',{'body':'proba po zamknieciu'},tok=p1t); ok(st==403,'autor nie edytuje zamknietego')
# DOJ
st,r=call('/mdt/doj/cases',tok=p1t); ok(st==403,'PD nie ma dostepu do spraw DOJ')
st,r=call('/mdt/doj/cases','POST',{'title':'Sprawa X'},tok=djt); ok(st==403,'pracownik DOJ (read) nie tworzy spraw')
st,r=call('/mdt/doj/cases','POST',{'title':'Sprawa jawna','subject_customer_id':civ},tok=dst); ok(st==200 and r['number'].startswith('DOJ-'),'szef DOJ tworzy sprawe '+r['number']); c1=r['id']
st,r=call('/mdt/doj/cases','POST',{'title':'Sprawa poufna','classification':'POUFNA'},tok=dst); ok(st==200,'sprawa poufna'); c2=r['id']
st,r=call('/mdt/doj/cases',tok=djt); ok(any(x['id']==c1 for x in r) and not any(x['id']==c2 for x in r),'pracownik DOJ widzi jawna, nie widzi poufnej')
st,r=call('/mdt/doj/cases/%d'%c2,tok=djt); ok(st==404,'bezposredni dostep do poufnej -> 404')
st,r=call('/mdt/doj/cases/%d'%c2,tok=dst); ok(st==200,'szef DOJ czyta poufna')
st,r=call('/mdt/doj/cases/%d/notes'%c1,'POST',{'body':'Notatka prokuratora'},tok=dst); ok(st==200,'notatka')
st,r=call('/mdt/doj/cases/%d/reports'%c1,'POST',{'report_id':secret},tok=dst); ok(st==403,'nie podepniesz raportu nieudostepnionego (poufnego)')
st,r=call('/mdt/doj/cases/%d/reports'%c1,'POST',{'report_id':rid},tok=dst); ok(st==200,'podpiecie udostepnionego raportu')
st,r=call('/mdt/doj/cases/%d'%c1,tok=djt); ok(st==200 and len(r['reports'])==1 and len(r['notes'])==1,'sprawa: raport+notatka')
st,r=call('/mdt/doj/cases/%d/status'%c1,'POST',{'status':'ZAMKNIETA'},tok=dst); ok(st==200,'zamkniecie sprawy')
# radio
st,r=call('/mdt/radio/channels',tok=p1t); keys=[c['key'] for c in r]; ok('LAPD' in keys and 'DISPATCH' in keys and 'EMS' not in keys and 'INTEROP' not in keys and 'COMMAND' not in keys,'kanaly pracownika PD: '+','.join(keys))
st,r=call('/mdt/radio/channels',tok=pst); keys=[c['key'] for c in r]; ok('INTEROP' in keys and 'COMMAND' in keys,'szef PD: interop+command')
st,r=call('/mdt/radio/channels',tok=djt); keys=[c['key'] for c in r]; ok(keys==[] ,'pracownik DOJ: brak kanalow (%s)'%keys)
st,r=call('/mdt/radio/EMS/messages',tok=p1t); ok(st==403,'PD nie czyta kanalu EMS')
st,r=call('/mdt/radio/LAPD/send','POST',{'text':'test'},tok=p1t); ok(st==409,'bez sluzby nie nadasz')
call('/mdt/duty','POST',{'on':True,'callsign':'R-'+tag},tok=p1t)
st,r=call('/mdt/radio/LAPD/send','POST',{'text':'Adam-12, kontrola drogowa','sender_name':'FAŁSZ','callsign':'FAKE'},tok=p1t); ok(st==200,'nadanie')
st,r=call('/mdt/radio/LAPD/messages',tok=p1t); m=r['messages'][-1]; ok(m['sender_name']=='Piotr Policjant' and m['callsign']=='R-'+tag,'tozsamosc nadawcy z sesji, nie z klienta')
lid=m['id']; st,r=call('/mdt/radio/LAPD/messages?since=%d'%lid,tok=p1t); ok(r['messages']==[],'since: brak nowych')
for i in range(16): st,r=call('/mdt/radio/LAPD/send','POST',{'text':'spam %d'%i},tok=p1t)
ok(st==429,'limit tempa -> 429')
st,r=call('/mdt/radio/panic','POST',{'location':'Port'},tok=p1t); ok(st==200,'panic')
st,r=call('/mdt/radio/DISPATCH/messages',tok=p1t); ok(any(x['kind']=='PANIC' for x in r['messages']),'panic na dispatchu')
st,r=call('/mdt/radio/channels','POST',{'key':'t1','name':'Test','allowed_factions':['LAPD']},tok=p1t); ok(st==403,'pracownik nie zarzadza kanalami')
# alarmy
st,r=call('/mdt/alarms',tok=p1t); ok(st==200,'PD czyta alarmy'); 
st,r=call('/mdt/alarms',tok=e1t); ok(st==403,'EMS nie czyta alarmow')
st,r=call('/internal/mdt/alarms','POST',{'location_text':'Bank Centralny','kind':'bank'}); ok(st in(401,403),'alarm bez klucza odrzucony')
st,r=call('/internal/mdt/alarms','POST',{'location_text':'Bank Centralny','kind':'bank'},key=True); ok(st==400,'alarm bez idempotency_key 400')
k='robbery-'+tag
st,a=call('/internal/mdt/alarms','POST',{'idempotency_key':k,'location_text':'Bank Centralny','kind':'bank'},key=True); ok(st==200 and a['alarm_status']=='OCZEKUJE' and not a['duplicate'],'alarm cichy: OCZEKUJE (opoznienie po stronie serwera)')
st,b=call('/internal/mdt/alarms','POST',{'idempotency_key':k,'location_text':'Bank Centralny','kind':'bank'},key=True); ok(b['duplicate'] and b['alarm_id']==a['alarm_id'],'ten sam klucz = ten sam alarm')
st,r=call('/internal/mdt/alarms','POST',{'idempotency_key':'x'+k,'location_key':'nie-ma','kind':'bank'},key=True); ok(st==404,'nieznana lokalizacja 404')
st,r=call('/mdt/locations','POST',{'key':'bank_c'+tag,'name':'Bank Centralny (zweryfikowany)','kind':'BANK'},tok=p1t); ok(st==403,'pracownik nie dodaje lokalizacji (brak alarms.manage)')
cur.execute("select count(*) from tickets where alarm_id=%s",(a['alarm_id'],)); ok(cur.fetchone()[0]==0,'przed czasem brak zgloszenia')
st,r=call('/internal/mdt/alarms/%s/cancel'%('x'+k),'POST',{},key=True); ok(r['cancelled']==False,'cancel nieistniejacego -> false')
time.sleep(9)
cur.execute("select count(*), min(ticket_id) from tickets where alarm_id=%s",(a['alarm_id'],)); n,tid=cur.fetchone(); ok(n==1,'po opoznieniu dokladnie 1 zgloszenie (#%s)'%tid)
st,b=call('/internal/mdt/alarms','POST',{'idempotency_key':k,'location_text':'Bank Centralny','kind':'bank'},key=True); cur.execute("select count(*) from tickets where alarm_id=%s",(a['alarm_id'],)); ok(cur.fetchone()[0]==1 and b['duplicate'],'powtorka po wyslaniu nie robi 2. zgloszenia')
st,s=call('/mdt/dispatch/state',tok=p1t); c=[x for x in s['calls'] if x['ticket_id']==tid]; ok(c and c[0]['priority']==1 and c[0]['source']=='ALARM','zgloszenie alarmowe w dispatchu P1')
st,s=call('/mdt/dispatch/state',tok=e1t); ok(any(x['ticket_id']==tid for x in s['calls']),'EMS dostaje wspolne zgloszenie z alarmu')
st,r=call('/mdt/radio/DISPATCH/messages',tok=p1t); ok(any(x['kind']=='ALARM' for x in r['messages']),'komunikat ALARM na radiu')
# anulowanie w oknie
k2='cancel-'+tag; st,a2=call('/internal/mdt/alarms','POST',{'idempotency_key':k2,'location_text':'Sklep 24/7','kind':'sklep'},key=True)
st,r=call('/internal/mdt/alarms/%s/cancel'%k2,'POST',{},key=True); ok(r['cancelled'],'anulowanie w oknie opoznienia'); time.sleep(8)
cur.execute("select count(*) from tickets where alarm_id=%s",(a2['alarm_id'],)); ok(cur.fetchone()[0]==0,'anulowany alarm nie tworzy zgloszenia')
# wspolbieznosc: rownolegle te same klucze
import threading
res=[]
def go(): res.append(call('/internal/mdt/alarms','POST',{'idempotency_key':'par-'+tag,'location_text':'Stacja','kind':'inne'},key=True)[1].get('alarm_id'))
th=[threading.Thread(target=go) for _ in range(8)]; [t.start() for t in th]; [t.join() for t in th]
ok(len(set(res))==1,'8 rownoleglych zadan = 1 alarm')
# audit nie zawiera hasel/tokenow
cur.execute("select count(*) from faction_audit where detail ilike '%%Bearer%%' or detail ilike '%%password%%'"); ok(cur.fetchone()[0]==0,'audyt bez tokenow/hasel')
print('WSZYSTKO OK 2')
