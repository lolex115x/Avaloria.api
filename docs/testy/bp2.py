import json, urllib.request, urllib.error, psycopg2
B='http://localhost:3056'
def call(path, method='GET', body=None, tok=None, key=True, expect=200):
    h={'content-type':'application/json'}
    if tok: h['authorization']='Bearer '+tok
    if key: h['x-api-key']='k'
    r=urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        return 200, json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)
def mk(first,last,disc,ssn):
    st,c=call('/internal/customers','POST',{'first_name':first,'last_name':last,'discord_user_id':disc,'ssn_rp':ssn})
    assert st==200,c
    st,l=call('/customer/login','POST',{'username':c['username'],'password':c['temp_password']},key=False)
    return c['customer_id'], l['token']
db=psycopg2.connect('dbname=avtest user=postgres password=pw host=localhost'); db.autocommit=True; cur=db.cursor()
SS=str(__import__('random').randint(10**8,10**9))
DID='d-own'+SS
oid,otok=mk('Jan','Plecakowy',DID,SS)
for iid,n,cat,q in [('pistol','Pistolet 9mm','sklep',1),('bandaz','Bandaż','sklep',5),('lockpick','Wytrych','darkweb',2)]:
    cur.execute("INSERT INTO inventory VALUES(%s,%s,%s,%s,%s)",(oid,iid,n,cat,q))
def ok(c,m): print(('OK   ' if c else 'FAIL ')+m); assert c,m
# 1 przed udostępnieniem: PD nie może
st,r=call('/internal/backpack/search','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==409,'search bez /plecak daj -> 409: '+r['error'][:40])
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'pistol','qty':1,'actor':'pd#1'}); ok(st==409,'seize bez dostępu -> 409')
# 2 cudzy SSN nie otworzy
st,r=call('/internal/backpack/give','POST',{'discord_user_id':'d-ktos','ssn':SS,'actor':'x'}); ok(st==404,'give cudzą postacią -> 404')
# 3 admin widzi w każdej chwili
st,r=call('/internal/backpack/inspect','POST',{'ssn':SS,'actor':'admin#1'}); ok(st==200 and len(r['items'])==3 and r['shared']==False,'admin inspect bez udostępnienia: %d przedmioty'%len(r['items']))
# 4 give
st,r=call('/internal/backpack/give','POST',{'discord_user_id':DID,'ssn':' '.join([SS[:2],SS[2:]]),'actor':'Jan#1'}); ok(st==200 and r['minutes']==15,'give (SSN z spacją/myślnikiem) -> %s min'%r.get('minutes'))
st,r=call('/customer/backpack/status',tok=otok,key=False); ok(r['open'] and any(h['action']=='UDOSTEPNIONY' for h in r['history']),'telefon: open=true + historia')
# 5 search
st,r=call('/internal/backpack/search','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==200 and len(r['items'])==3,'search -> 3 pozycje')
# 6 seize
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'pistol','qty':1,'actor':'pd#1'}); ok(st==200 and r['left']==0,'seize pistolet (po id) -> left 0')
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'bandaz','qty':2,'actor':'pd#1'}); ok(st==200 and r['left']==3,'seize 2 bandaże po nazwie -> left 3')
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'wytrych','qty':0,'actor':'pd#1'}); ok(st==200 and r['qty']==2,'seize qty=0 -> całość (2)')
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'pistol','qty':1,'actor':'pd#1'}); ok(st==404,'seize nieistniejącego -> 404')
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'ban','qty':99,'actor':'pd#1'}); ok(st==200 and r['qty']==3,'seize więcej niż jest -> tyle ile jest (3)')
cur.execute("select item_id,qty from inventory where customer_id=%s order by 1",(oid,)); print('   stan bazy:',cur.fetchall())
# 7 wiele pasujących
cur.execute("INSERT INTO inventory VALUES(%s,'k1','Kamizelka lekka','sklep',1),(%s,'k2','Kamizelka ciężka','sklep',1)",(oid,oid))
st,r=call('/internal/backpack/seize','POST',{'ssn':SS,'item':'kamizelka','qty':1,'actor':'pd#1'}); ok(st==409,'niejednoznaczna nazwa -> 409: '+r['error'][:50])
# 8 oddaj
st,r=call('/internal/backpack/return','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==200 and r['was_open'],'oddaj -> was_open')
st,r=call('/internal/backpack/search','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==409,'po oddaniu search -> 409')
st,r=call('/internal/backpack/return','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==200 and not r['was_open'],'oddaj drugi raz -> was_open=false')
# 9 wygaśnięcie
call('/internal/backpack/give','POST',{'discord_user_id':DID,'ssn':SS,'actor':'Jan#1'})
cur.execute("update backpack_access set expires_at=now()-interval '1 minute' where customer_id=%s",(oid,))
st,r=call('/internal/backpack/search','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==409,'po wygaśnięciu -> 409')
# 10 gracz zabiera plecak
call('/internal/backpack/give','POST',{'discord_user_id':DID,'ssn':SS,'actor':'Jan#1'})
call('/customer/backpack/close','POST',{},tok=otok,key=False)
st,r=call('/internal/backpack/search','POST',{'ssn':SS,'actor':'pd#1'}); ok(st==409,'gracz zabrał plecak -> 409')
# 11 historia: konfiskaty widoczne, podgląd admina niewidoczny
st,r=call('/customer/backpack/status',tok=otok,key=False); acts=[h['action'] for h in r['history']]
ok('KONFISKATA' in acts and 'PODGLAD_ADMIN' not in acts,'historia gracza: %s'%sorted(set(acts)))
# 12 klucz API
st,r=call('/internal/backpack/inspect','POST',{'ssn':SS},key=False); ok(st==401,'bez klucza -> 401')
# 13 login remember + keep_session
st,c=call('/internal/customers','POST',{'first_name':'Rem','last_name':'Ember','discord_user_id':'d-r'+SS,'ssn_rp':'9'+SS})
st,l=call('/customer/login','POST',{'username':c['username'],'password':c['temp_password'],'remember':True},key=False)
cur.execute("select (expires_at - now()) > interval '29 days' from sessions where token=%s",(l['token'],)); ok(cur.fetchone()[0],'remember -> sesja 30 dni')
call('/customer/logout','POST',{'keep_session':True},tok=l['token'],key=False)
st,r=call('/customer/me',tok=l['token'],key=False); ok(st==200,'logout keep_session -> sesja żyje')
call('/customer/logout','POST',{},tok=l['token'],key=False)
st,r=call('/customer/me',tok=l['token'],key=False); ok(st==401,'logout zwykły -> sesja skasowana')
print('BACKEND OK')
