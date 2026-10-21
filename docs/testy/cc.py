exec(open('mdt_common.py').read().split("civ,ctok")[0].split("db=psycopg2")[0])
import threading, uuid
db=psycopg2.connect('dbname=avtest user=postgres password=pw host=localhost'); db.autocommit=True; cur=db.cursor()
def ok(c,m): print(('OK   ' if c else 'FAIL ')+m); assert c,m
did='cc'+rs(); ssn='CC'+rs()
body={'discord_user_id':did,'first_name':'Test','last_name':'Postac','ssn_rp':ssn,'date_of_birth':'1990-01-01'}
res=[]
def go(): res.append(call('/internal/customers/activate-phone','POST',body,key=True))
ts=[threading.Thread(target=go) for _ in range(6)]; [t.start() for t in ts]; [t.join() for t in ts]
good=[r for st,r in res if st==200]; ok(len(good)==1,f'6 rownoleglych zadan -> 1 sukces ({[st for st,_ in res]})')
g=good[0]; ok(g['account_number'] and g['phone_number'] and g['username'] and g['temp_password'] and g['must_change_password'],'jest telefon, konto, login, haslo')
cur.execute("select count(*) from customers where ssn_rp=%s",(ssn,)); ok(cur.fetchone()[0]==1,'1 rekord postaci')
cur.execute("select count(*) from accounts a join customers c using(customer_id) where c.ssn_rp=%s",(ssn,)); ok(cur.fetchone()[0]==1,'1 konto')
cur.execute("select password_hash,must_change_password from customers where ssn_rp=%s",(ssn,)); h,m=cur.fetchone(); ok(g['temp_password'] not in h and h.startswith('$2') and m,'haslo tylko jako bcrypt, must_change=true')
st,r=call('/internal/customers/activate-phone','POST',body,key=True); ok(st==409,'powtorka -> 409, bez nowych danych')
st,l=call('/customer/login','POST',{'username':g['username'],'password':g['temp_password']}); ok(st==200 and l.get('must_change_password'),'login hasłem tymczasowym, wymagana zmiana')
tok=l['token']
st,r=call('/customer/change-password','POST',{'old_password':g['temp_password'],'new_password':'NoweHaslo123'},tok=tok); print('change-password',st,r)
# kolizja loginu: wymus ten sam prefix, wiele postaci o tym samym imieniu
import concurrent.futures as cf
def mkc(n): return call('/internal/customers/activate-phone','POST',{'discord_user_id':'cx'+rs(),'first_name':'Kol','last_name':'Izja','ssn_rp':'KX'+rs()+str(n)},key=True)
with cf.ThreadPoolExecutor(20) as ex: rr=list(ex.map(mkc,range(40)))
ok(all(st==200 for st,_ in rr),'40 postaci Kol Izja rownolegle, zero 500: '+str(sorted(set(st for st,_ in rr))))
ok(len({r['username'] for _,r in rr})==40 and len({r['phone_number'] for _,r in rr})==40,'loginy i numery unikalne')
# reissue
st,r=call('/internal/customers/reissue-password','POST',{'discord_user_id':did,'ssn_rp':ssn},key=True); ok(st==200 and r['temp_password']!=g['temp_password'],'reissue: nowe haslo')
st,_=call('/customer/login','POST',{'username':g['username'],'password':g['temp_password']}); ok(st in (400,401,403),'stare haslo nie dziala')
st,l2=call('/customer/login','POST',{'username':g['username'],'password':r['temp_password']}); ok(st==200 and l2['must_change_password'],'nowe haslo dziala + wymusza zmiane')
st,_=call('/customer/factions/me',tok=tok); ok(st==401,'stara sesja uniewazniona')
st,_=call('/internal/customers/reissue-password','POST',{'discord_user_id':'cudzy'+rs(),'ssn_rp':ssn},key=True); ok(st==404,'obcy discord id + cudzy SSN -> 404')
st,_=call('/internal/customers/reissue-password','POST',{'discord_user_id':did,'ssn_rp':ssn}); ok(st in (401,403),'bez klucza API -> odmowa')
