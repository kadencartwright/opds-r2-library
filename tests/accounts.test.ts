import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Miniflare} from 'miniflare'
import {readdir,readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {pdf} from './fixtures'

test('real D1/R2 admin reader lifecycle: distinct accounts, password rotation and cascading deletion',async()=>{
 const origin='http://localhost',password='first-device-password',nextPassword='updated-device-password',username='reader+one@example.com'
 const mf=new Miniflare({modules:true,scriptPath:'dist-worker/worker.js',compatibilityDate:'2026-07-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'accounts'},r2Buckets:{ARCHIVE:'books'},bindings:{LOCAL_DEV:'true',PRIVATE_LIBRARY:'true',AUTH_ORIGIN:origin,AUTH_SECRET:'test-only-secret-that-is-at-least-thirty-two-characters',ADMIN_EMAILS:'admin@example.com'}})
 const req=(path:string,init?:Parameters<Miniflare['dispatchFetch']>[1])=>mf.dispatchFetch(origin+path,init)
 const json=(value:unknown,cookie='',requestOrigin=origin)=>({headers:{cookie,origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify(value)})
 const path='/api/admin/accounts/'+encodeURIComponent(username)
 const md5=(p:string)=>createHash('md5').update(p).digest('hex')
 const protocol=(name:string,p:string)=>({'x-auth-user':name,'x-auth-key':md5(p)})
 const basic=(name:string,p:string)=>({authorization:'Basic '+Buffer.from(name+':'+p).toString('base64')})
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE')
  for(const f of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile('migrations/'+f,'utf8')).replace(/^--.*$/gm,'').split(';').filter(s=>s.trim()))await db.prepare(sql).run()
  for(const [method,url] of [['GET','/api/admin/accounts'],['PATCH',path],['DELETE',path]])assert.equal((await req(url,{method})).status,401)
  await req('/api/auth/sign-in/magic-link',{method:'POST',...json({email:'admin@example.com',callbackURL:'/'})})
  const mail=await db.prepare('SELECT url FROM local_mail ORDER BY created DESC LIMIT 1').first<{url:string}>()
  assert.ok(mail)
  const verify=await mf.dispatchFetch(mail.url,{redirect:'manual'}),cookie=verify.headers.get('set-cookie')!.split(';')[0]
  for(const name of [username,'reader-two'])assert.equal((await req('/api/admin/accounts',{method:'POST',...json({username:name,password},cookie)})).status,201)
  assert.equal((await req('/api/admin/accounts',{method:'POST',...json({username,password},cookie)})).status,409)
  assert.equal((await req('/api/admin/accounts',{headers:basic(username,password)})).status,401)
  const listing=await req('/api/admin/accounts',{headers:{cookie}}).then(r=>r.json()) as {accounts:{username:string;created:number}[];total:number}
  assert.equal(listing.total,2);assert.deepEqual(listing.accounts.map(a=>a.username),[username,'reader-two'])
  assert.ok(listing.accounts.every(a=>Object.keys(a).sort().join(',')==='created,username'))
  const bytes=pdf(),id=createHash('sha256').update(bytes).digest('hex')
  assert.equal((await req('/api/books',{method:'POST',headers:{cookie,'x-filename':'retained.pdf','content-type':'application/pdf'},body:bytes})).status,201)
  for(const name of [username,'reader-two']){
   const push=json({document:'same-doc',progress:'7',percentage:.7,device:'test',device_id:'device-'+name})
   assert.equal((await req('/syncs/progress',{method:'PUT',...push,headers:{...push.headers,...protocol(name,password)}})).status,200)
   await db.prepare('INSERT INTO documents(username,document,title,updated_at) VALUES (?,?,?,?)').bind(name,'same-doc','Private metadata',1).run()
   await db.prepare("INSERT INTO annotations(username,document,kind,id,payload,deleted,updated_at,revision) VALUES (?,?,'bookmarks','mark','{}',0,1,1)").bind(name,'same-doc').run()
  }
  const before=await db.prepare('SELECT salt,verifier FROM accounts WHERE username=?').bind(username).first<{salt:string;verifier:string}>()
  for(const method of ['PATCH','DELETE'])assert.equal((await req(path,{method,...json({password:nextPassword},cookie,'https://evil.invalid')})).status,403)
  assert.equal((await req(path,{method:'PATCH',...json({password:'short'},cookie)})).status,400)
  assert.equal((await req('/api/admin/accounts/missing',{method:'PATCH',...json({password:nextPassword},cookie)})).status,404)
  assert.equal((await req(path,{method:'PATCH',...json({password:nextPassword},cookie)})).status,200)
  const after=await db.prepare('SELECT salt,verifier FROM accounts WHERE username=?').bind(username).first<{salt:string;verifier:string}>()
  assert.notEqual(after!.salt,before!.salt);assert.notEqual(after!.verifier,before!.verifier);assert.notEqual(after!.verifier,md5(nextPassword));assert.notEqual(after!.verifier,nextPassword)
  assert.equal((await req('/users/auth',{headers:protocol(username,password)})).status,401)
  assert.equal((await req('/opds/v1/catalog.xml',{headers:basic(username,password)})).status,401)
  for(const [name,p] of [[username,nextPassword],['reader-two',password]]){
   assert.equal((await req('/users/auth',{headers:protocol(name,p)})).status,200)
   assert.equal((await req('/opds/v2/catalog.json',{headers:basic(name,p)})).status,200)
   assert.equal((await req('/syncs/progress/same-doc',{headers:protocol(name,p)}).then(r=>r.json()) as {progress:string}).progress,'7')
  }
  // Pagination includes every account; no unbounded response or hidden account limit.
  for(let n=0;n<26;n++)await db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind('extra-'+String(n).padStart(2,'0'),'test-salt','unused-verifier',0).run()
  const page2=await req('/api/admin/accounts?page=2',{headers:{cookie}}).then(r=>r.json()) as typeof listing
  assert.equal(page2.total,28);assert.equal(page2.accounts.length,3)
  assert.equal((await req('/api/admin/accounts?page=0',{headers:{cookie}})).status,400)
  assert.equal((await req(path,{method:'DELETE',...json({},cookie)})).status,200)
  assert.equal((await req(path,{method:'DELETE',...json({},cookie)})).status,404)
  for(const table of ['accounts','progress','device_progress','documents','annotations']){
   assert.equal((await db.prepare('SELECT count(*) n FROM '+table+' WHERE username=?').bind(username).first<{n:number}>())!.n,0,table+' cascaded')
   assert.ok((await db.prepare('SELECT count(*) n FROM '+table+" WHERE username='reader-two'").first<{n:number}>())!.n>0,table+' preserves other account')
  }
  assert.equal((await req('/users/auth',{headers:protocol(username,nextPassword)})).status,401)
  assert.equal((await req('/opds/v1/catalog.xml',{headers:basic(username,nextPassword)})).status,401)
  assert.equal((await req('/users/auth',{headers:protocol('reader-two',password)})).status,200)
  assert.deepEqual(Buffer.from(await req('/api/books/'+id+'/download',{headers:basic('reader-two',password)}).then(r=>r.arrayBuffer())),Buffer.from(bytes))
  assert.ok(await bucket.head('originals/'+id))
 }finally{await mf.dispose()}
})
