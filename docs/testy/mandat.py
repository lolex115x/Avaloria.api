exec(open('mdt_common.py').read())
civ,ctok,cph=mk('Jan','Kierowca'); p1,p1t,_=mk('Piotr','Policjant'); f1,f1t,_=mk('Franek','Strazak'); ps,pst,_=mk('Szymon','SzefPD')
mem(p1,'LAPD','PRACOWNIK'); mem(f1,'LAFD','PRACOWNIK')
cur.execute("select phone_number from customers where customer_id=%s",(civ,)); ph=cur.fetchone()[0]
cur.execute("select account_id from accounts where customer_id=%s",(civ,)); 
if not cur.fetchone():
    print('brak konta - otwieram'); st,r=call(f'/internal/customers/{civ}/open-account','POST',{},key=True); print(st,r)
cur.execute("update accounts set balance=5000 where customer_id=%s",(civ,))
st,r=call('/customer/factions/me',tok=p1t); ok(st==200 and any(x['faction']=='LAPD' and x.get('invoiceKind')=='MANDAT' for x in r),'me: LAPD invoiceKind=MANDAT'); 
cur.execute("select coalesce(sum(balance),0) from treasury_accounts where holder='LAPD'") if False else None
st,r=call('/customer/factions/LAPD/invoices','POST',{'to_phone_number':ph,'amount':400,'title':'Przekroczenie predkosci'},tok=p1t); ok(st==200 and r['invoice']['kind']=='MANDAT','mandat wystawiony kind=MANDAT'); iid=r['invoice']['invoice_id']
st,r=call('/customer/invoices',tok=ctok); print(str(r)[:200]); L=r['pending']; ok(any(i['invoice_id']==iid and i['kind']=='MANDAT' for i in L),'platnik widzi kind=MANDAT')
st,r=call('/customer/factions/LAPD/invoices','POST',{'to_phone_number':ph,'amount':100,'title':'x'},tok=f1t); ok(st==403,'LAFD nie wystawia mandatu jako LAPD (403)')
st,r=call(f'/customer/invoices/{iid}/pay','POST',{},tok=ctok); ok(st==200,'zaplata mandatu')
st,r=call(f'/customer/invoices/{iid}/pay','POST',{},tok=ctok); ok(st==400,'podwojna zaplata odrzucona')
cur.execute("select vat,status,kind from invoices where invoice_id=%s",(iid,)); v=cur.fetchone(); ok(v==(0,'OPLACONA','MANDAT'),f'VAT=0 {v}')
cur.execute("select balance from accounts where customer_id=%s",(civ,)); ok(cur.fetchone()[0]==4600,'saldo -400')
cur.execute("select amount,type from treasury_ledger where ref like %s",(f'MANDAT #{iid}',)) if False else None
st,r=call(f'/customer/factions/LAPD/invoices/history?phone={ph}',tok=p1t); ok(st==200 and r['items'][0]['kind']=='MANDAT' and r['items'][0]['status']=='OPLACONA','historia mandatow osoby')
st,r=call(f'/customer/factions/LAPD/invoices/history?phone={ph}',tok=ctok); ok(st==403,'cywil bez dostepu do historii')
# faktura EMS nadal z VAT
e1,e1t,_=mk('Ewa','Medyk2'); mem(e1,'EMS','PRACOWNIK')
st,r=call('/customer/factions/EMS/invoices','POST',{'to_phone_number':ph,'amount':1000,'title':'Leczenie'},tok=e1t); ok(st==200 and r['invoice']['kind']=='FAKTURA','EMS faktura')
st,_=call(f"/customer/invoices/{r['invoice']['invoice_id']}/pay",'POST',{},tok=ctok); cur.execute("select vat from invoices where invoice_id=%s",(r['invoice']['invoice_id'],)); ok(st==200 and cur.fetchone()[0]>0,'faktura EMS ma VAT (regresja)')
# panele mdt jako lapd/lafd z naglowkiem
st,r=call('/mdt/persons?q=Kierowca',tok=p1t,fac='LAPD'); ok(st==200 and any(x['customer_id']==civ for x in r),'LAPD: wyszukiwanie osoby')
st,r=call(f'/mdt/persons/{civ}',tok=p1t,fac='LAPD'); ok(st==200 and 'vehicles' in r,'LAPD: karta osoby')
st,r=call('/mdt/vehicles','POST',{'plate':'LA-'+rs()[:5],'model':'Charger','color':'czarny','owner_phone':ph},tok=p1t,fac='LAPD'); ok(st==200,f'LAPD: dodanie pojazdu z owner_phone {r}')
st,r=call('/mdt/vehicles?q=Charger',tok=p1t,fac='LAPD'); ok(st==200 and any(x['owner_customer_id']==civ for x in r),'pojazd przypisany do wlasciciela')
st,r=call('/mdt/vehicles','POST',{'plate':'LA-999','owner_phone':'000-0000'},tok=p1t,fac='LAPD'); ok(st==404,'zly numer wlasciciela -> 404')
st,r=call('/mdt/warrants','POST',{'kind':'POSZUKIWANY','subject_name':'Jan Kierowca','reason':'ucieczka'},tok=p1t,fac='LAPD'); ok(st==200,f'warrant {r}')
st,r=call('/mdt/warrants?all=1',tok=p1t,fac='LAPD'); ok(st==200 and r,'lista poszukiwanych')
st,r=call('/mdt/reports','POST',{'title':'Kontrola drogowa','body':'Tresc raportu','kind':'RAPORT'},tok=p1t,fac='LAPD'); ok(st==200,'LAPD raport'); rid=r['id']
st,r=call('/mdt/reports','POST',{'title':'Pozar budynku','body':'Tresc raportu','kind':'INCYDENT'},tok=f1t,fac='LAFD'); ok(st==200,f'LAFD raport {r}'); r2=r['id']
st,r=call(f'/mdt/reports/{rid}',tok=f1t,fac='LAFD'); ok(st==404,'LAFD nie widzi raportu LAPD')
st,r=call(f'/mdt/reports/{r2}',tok=p1t,fac='LAPD'); ok(st==404,'LAPD nie widzi raportu LAFD')
st,r=call('/mdt/persons?q=Kierowca',tok=f1t,fac='LAFD'); print('LAFD persons ->',st)
st,r=call('/mdt/warrants?all=1',tok=f1t,fac='LAFD'); print('LAFD warrants ->',st)
st,r=call('/mdt/reports','POST',{'title':'Niedozwolony','body':'abc abc'},tok=ctok); ok(st in (401,403),'cywil bez raportow')
print('ALL OK')
