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
