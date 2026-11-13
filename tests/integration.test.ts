import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Miniflare } from 'miniflare'
import { mkdtemp,readFile,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { epub,pdf,coverPNG } from './fixtures'
import { validateOPDS } from './opds'
test('real workerd D1 + R2 unified library and KOSync vertical slice',async()=>{
 await mkdir('test-results',{recursive:true})
 const dir=await mkdtemp(tmpdir()+'/opds-library-test-')
 const make=(local=true)=>new Miniflare({modules:true,scriptPath:'dist-worker/worker.js',compatibilityDate:'2026-07-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'catalog'},r2Buckets:{ARCHIVE:'archive'},d1Persist:dir+'/d1',r2Persist:dir+'/r2',bindings:{LOCAL_DEV:String(local),ALLOW_LOCAL_ADMIN:local?'true':'false',PRIVATE_LIBRARY:local?'false':'true',ADMIN_TOKEN:'test-admin',AUTH_SECRET:'test-only-auth-secret-at-least-thirty-two-characters',AUTH_ORIGIN:'http://localhost',ADMIN_EMAILS:'admin@example.com'},port:8790})
 let mf=make()
 const req=(path:string,init?:Parameters<Miniflare["dispatchFetch"]>[1])=>mf.dispatchFetch('http://localhost'+path,init)
 const key=createHash('md5').update('test-pass').digest('hex')
 const auth={'x-auth-user':'alice','x-auth-key':key}
 const json=(data:unknown,headers:Record<string,string>={})=>({headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)})
 try{
 const db=await mf.getD1Database('DB')
 for(const file of ['0001_books.sql','0002_sync.sql','0003_cover.sql','0004_crosspoint.sql','0005_web_auth.sql','0006_mcp_auth.sql'])for(const sql of (await readFile('migrations/'+file,'utf8')).replace(/^--.*$/gm,'').split(';').filter(x=>x.trim()))await db.prepare(sql).run()
 assert.equal((await req('/api/books')).status,200)
 assert.ok(validateOPDS(await req('/opds/v2/catalog.json').then(r=>r.json())),JSON.stringify(validateOPDS.errors))
 const bytes=epub()
 await mkdir('tests/fixtures',{recursive:true});await writeFile('tests/fixtures/tiny.epub',bytes);await writeFile('tests/fixtures/tiny.pdf',pdf())
 const upload=()=>req('/api/books',{method:'POST',headers:{'content-type':'application/epub+zip','x-filename':'tiny.epub'},body:bytes})
 const up=await upload();assert.equal(up.status,201,await up.clone().text())
 const b=await up.json() as {id:string;title:string;authors:string;object_key:string}
 assert.deepEqual(Buffer.from(await req('/api/books/'+b.id+'/cover').then(r=>r.arrayBuffer())),Buffer.from(coverPNG));
 assert.equal(b.title,'A Tiny Journey');assert.equal(b.authors,'opds-library Test Author')
 assert.equal(b.id,createHash('sha256').update(bytes).digest('hex'))
 assert.equal((await upload()).status,409)
 const r2=await mf.getR2Bucket('ARCHIVE');assert.ok(await r2.head(b.object_key))
 const original=await req('/api/books/'+b.id+'/download');assert.deepEqual(Buffer.from(await original.arrayBuffer()),Buffer.from(bytes))
 // Inject an actual SQLite failure after R2 put; compensation must remove all objects and the pending row.
 await db.prepare("CREATE TRIGGER fail_ready BEFORE UPDATE OF state ON books WHEN NEW.title='Fail test' BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run()
 const failedBytes=epub('Fail test'),failedId=createHash('sha256').update(failedBytes).digest('hex')
 const failed=await req('/api/books',{method:'POST',headers:{'x-filename':'failed.epub','content-type':'application/epub+zip'},body:failedBytes})
 assert.equal(failed.status,503)
 assert.equal(await r2.head('originals/'+failedId),null)
 assert.equal(await db.prepare('SELECT id FROM books WHERE id=?').bind(failedId).first(),null)
 await db.prepare('DROP TRIGGER fail_ready').run()
 await r2.delete(b.object_key)
 assert.equal((await req('/api/books/'+b.id+'/download')).status,503)
 await r2.put(b.object_key,bytes)
 const upPdf=await req('/api/books',{method:'POST',headers:{'content-type':'application/pdf','x-filename':'tiny.pdf'},body:pdf()});assert.equal(upPdf.status,201);const pdfBook=await upPdf.json() as {id:string}
 const feed=await req('/opds/v2/catalog.json?limit=1')
 assert.equal(feed.headers.get('content-type'),'application/opds+json')
 const f=await feed.json() as {metadata:{numberOfItems:number};links:{rel:string;href:string}[];publications:unknown[]}
 assert.ok(validateOPDS(f),JSON.stringify(validateOPDS.errors));assert.equal(f.metadata.numberOfItems,2);assert.equal(f.publications.length,1);assert.ok(f.links.some(l=>l.rel==='next'))
 const next=await req(new URL(f.links.find(l=>l.rel==='next')!.href).pathname+new URL(f.links.find(l=>l.rel==='next')!.href).search)
 assert.equal(next.status,200);assert.equal((await next.json() as typeof f).publications.length,1)
 assert.equal((await req('/api/books?page=0')).status,400)
 assert.equal((await req('/api/books',{method:'POST',headers:{'x-filename':'bad.pdf','content-type':'application/pdf'},body:'not a PDF'})).status,400)
 const edit=await req('/api/books/'+b.id,{method:'PATCH',...json({title:'Edited journey',authors:'Legal Author'})});assert.equal(edit.status,200)
 assert.equal((await req('/api/books?q=Edited').then(r=>r.json()) as {total:number}).total,1)
 assert.equal((await req('/users/create',{method:'POST',...json({username:'alice',password:key})})).status,201)
 assert.equal((await req('/users/create',{method:'POST',...json({username:'bob',password:key})})).status,201)
 assert.equal((await req('/users/auth',{headers:auth})).status,200)
 assert.equal((await req('/users/auth',{headers:{...auth,'x-auth-key':'wrong'}})).status,401)
 const pos={document:'opaque_digest',progress:'/body/p[2]',percentage:.5,device:'CrossPoint',device_id:'device1',metadata:{title:'Tiny'}}
 const put=await req('/syncs/progress',{method:'PUT',...json(pos,auth)});assert.equal(put.status,200)
 assert.equal((await req('/syncs/progress/'+pos.document,{headers:{...auth,'x-auth-user':'bob'}}).then(r=>r.json()) as Record<string,unknown>).percentage,undefined)
 const second=await req('/syncs/progress',{method:'PUT',...json({...pos,percentage:.2,device_id:'device2',timestamp:1},auth)});assert.equal(second.status,200)
 const pulled=await req('/syncs/progress/'+pos.document,{headers:auth}).then(r=>r.json()) as Record<string,unknown>
 assert.equal(pulled.percentage,.2);assert.equal(pulled.device_id,'device2');assert.ok(Number(pulled.timestamp)>1700000000)
 assert.equal((await req('/syncs/progress',{method:'PUT',...json({...pos,percentage:'bad'},auth)})).status,403)
 await req('/api/admin/mapping',{method:'PUT',...json({username:'alice',document:pos.document,book_id:b.id})})
 // Run the unmodified upstream verifier over a real local TCP socket.
 await mf.ready
 const {stdout}=await promisify(execFile)('node',['tests/vendor/kosync-verify.mjs','--base-url','http://127.0.0.1:8790','--user','verifier','--password','verifier-pass','--register','--second-user','bob','--second-key',key,'--json','test-results/kosync.json'])
 console.log(stdout)
 
 // CrossPoint rich progress shares the same accounts and winner service.
 assert.deepEqual(await req('/healthz').then(r=>r.json()),{status:'ok',version:'0.1.0'})
 const richDoc='rich_book',position={pctQ:700000,spine:2,page:4,pages:10,para:9,li:0,anchor:'chapter',xpath:'/body/p[9]'}
 const rich={document:richDoc,progress:'/body/p[9]',percentage:.7,device:'CrossPoint',device_id:'rich-device',position,metadata:{title:'Rich title',authors:'Rich Author',filename:'rich.epub'}}
 assert.equal((await req('/api/v1/progress',{method:'PUT',...json(rich,auth)})).status,200)
 assert.equal((await req('/syncs/progress',{method:'PUT',...json({document:richDoc,progress:'10',percentage:.2,device:'KOReader',device_id:'plain-device'},auth)})).status,200)
 const richGet=await req('/api/v1/progress/'+richDoc,{headers:auth}).then(r=>r.json()) as {devices:Record<string,unknown>[]}
 assert.equal(richGet.devices.length,2)
 assert.equal(richGet.devices[0].device_id,'plain-device')
 assert.deepEqual(richGet.devices.find(d=>d.device_id==='rich-device')!.position,position)
 assert.equal((await req('/syncs/progress/'+richDoc,{headers:auth}).then(r=>r.json()) as Record<string,unknown>).device_id,'plain-device')
 // Downgrade on the SAME device preserves rich position, invalid position ignored.
 await req('/syncs/progress',{method:'PUT',...json({...rich,position:{pctQ:-1},percentage:.8},auth)})
 const retained=await req('/api/v1/progress/'+richDoc,{headers:auth}).then(r=>r.json()) as typeof richGet
 assert.deepEqual(retained.devices[0].position,position)
 // Old extended timestamp never defeats the newest cross-device winner.
 await req('/api/v1/progress',{method:'PUT',...json({...rich,device_id:'delayed-device',timestamp:1000000000},auth)})
 assert.equal((await req('/syncs/progress/'+richDoc,{headers:auth}).then(r=>r.json()) as Record<string,unknown>).device_id,'rich-device')
 assert.deepEqual((await req('/api/v1/progress/'+richDoc,{headers:{...auth,'x-auth-user':'bob'}}).then(r=>r.json()) as typeof richGet).devices,[])
 assert.equal((await req('/api/v1/progress?cursor=bad',{headers:auth})).status,403)
 const listRich=await req('/api/v1/progress?limit=1',{headers:auth}).then(r=>r.json()) as {items:unknown[];next:string}
 assert.equal(listRich.items.length,1);assert.ok(listRich.next)
 assert.equal((await req('/api/v1/progress?limit=1&cursor='+encodeURIComponent(listRich.next),{headers:auth})).status,200)
 assert.equal((await req('/api/v1/documents',{method:'PUT',...json({items:[{document:'doc_meta',title:'Metadata only',authors:'One',language:'en',filesize:12}]},auth)})).status,200)
 await req('/api/v1/documents',{method:'PUT',...json({items:[{document:'doc_meta',filename:'later.epub'}]},auth)})
 const docs=await req('/api/v1/documents',{headers:auth}).then(r=>r.json()) as {items:Record<string,unknown>[]}
 assert.equal(docs.items.find(d=>d.document==='doc_meta')!.title,'Metadata only')
 assert.equal((await req('/api/v1/documents',{headers:{...auth,'x-auth-user':'bob'}}).then(r=>r.json()) as typeof docs).items.length,0)
 for(const kind of ['bookmarks','clippings']){
 const path='/api/v1/'+kind+'/'+richDoc
 const first=kind==='bookmarks'?{id:'1111111111111111',xpath:'/body/p[1]',percentage:.1,summary:'First',si:1,pc:10,pp:2}:{id:'1111111111111111',spine:1,text:'Public domain words',chapter:'Chapter',created_at:1700000000,note:'Keep this',start_offset:1,end_offset:20}
 const second={...first,id:'2222222222222222'}
 assert.equal((await req(path,{method:'PUT',...json({items:[first,second]},auth)})).status,200)
 const mode=kind==='clippings'?'cursor':'since'
 const delta=await req(path+'?'+mode+'=0&limit=1',{headers:auth}).then(r=>r.json()) as {until:number;cursor?:number;more:boolean;items:Record<string,unknown>[]}
 assert.equal(delta.items.length,1);assert.equal(delta.more,true)
 const delta2=await req(path+'?'+mode+'='+(delta.cursor??delta.until)+'&limit=1',{headers:auth}).then(r=>r.json()) as typeof delta
 assert.equal(delta2.items.length,1);assert.equal(delta2.items[0].id,second.id);assert.equal(delta2.more,false)
 assert.equal((await req(path,{headers:{...auth,'x-auth-user':'bob'}}).then(r=>r.json()) as typeof delta).items.length,0)
 assert.equal((await req(path,{method:'PUT',...json({items:[{...first,id:'3333333333333333'},{}]},auth)})).status,403)
 assert.equal((await req(path,{method:'PUT',...json({items:Array(51).fill(first)},auth)})).status,403)
 assert.equal((await req(path+'?limit=101',{headers:auth})).status,403)
 assert.equal((await req(path,{method:'PUT',...json({items:[{id:first.id,deleted:1}]},auth)})).status,200)
 const tombstones=await req(path+'?'+mode+'=0',{headers:auth}).then(r=>r.json()) as typeof delta
 assert.equal(tombstones.items.find(i=>i.id===first.id)!.deleted,1)
 assert.equal(tombstones.items.some(i=>i.id==='3333333333333333'),false)
 if(kind==='clippings'){
  // Delayed client cannot resurrect a deleted clipping.
  await req(path,{method:'PUT',...json({items:[first]},auth)})
  const read=await req(path+'?cursor=0&format=reader',{headers:auth}).then(r=>r.json()) as typeof delta
  assert.equal(read.items.find(i=>i.id===first.id)!.deleted,1)
  assert.equal('note' in read.items[0],false)
  await req(path,{method:'PUT',...json({items:[{...second,note:undefined}]},auth)})
  const noteRead=await req(path+'?cursor=0',{headers:auth}).then(r=>r.json()) as typeof delta
  assert.equal(noteRead.items.find(i=>i.id===second.id)!.note,'Keep this')
 }
 }
 
 await mf.dispose();mf=make()
 assert.equal((await req('/api/books')).status,200)
 assert.equal((await req('/api/v1/progress/'+richDoc,{headers:auth}).then(r=>r.json()) as typeof richGet).devices.length,3)
 assert.equal((await req('/api/v1/clippings/'+richDoc+'?cursor=0',{headers:auth}).then(r=>r.json()) as {items:unknown[]}).items.length,2)
 assert.equal((await req('/syncs/progress/'+pos.document,{headers:auth}).then(r=>r.json()) as Record<string,unknown>).percentage,.2)
 assert.deepEqual(Buffer.from(await req('/api/books/'+b.id+'/download').then(r=>r.arrayBuffer())),Buffer.from(bytes))
 assert.equal((await req('/api/books/'+b.id,{method:'DELETE'})).status,200)
 assert.equal((await req('/api/books/'+b.id)).status,404)
 assert.equal((await req('/api/books/'+b.id+'/download')).status,404)
 assert.equal((await req('/api/books?q=Edited').then(r=>r.json()) as {total:number}).total,0)
 assert.equal(await (await mf.getR2Bucket('ARCHIVE')).head(b.object_key),null)

 const adminPassword='a-strong-reader-password-1234'
 const provision=await req('/api/admin/accounts',{method:'POST',...json({username:'provisioned',password:adminPassword})})
 assert.equal(provision.status,201,await provision.clone().text())
 assert.equal((await req('/api/admin/accounts',{method:'POST',...json({username:'provisioned',password:adminPassword})})).status,409)
 assert.equal((await req('/api/admin/accounts',{method:'POST',...json({username:'weak',password:'short'})})).status,400)
 const provisionKey=createHash('md5').update(adminPassword).digest('hex')
 assert.equal((await req('/users/auth',{headers:{'x-auth-user':'provisioned','x-auth-key':provisionKey}})).status,200)
 const stored=await (await mf.getD1Database('DB')).prepare('SELECT * FROM accounts WHERE username=?').bind('provisioned').first()
 assert.ok(!JSON.stringify(stored).includes(provisionKey));assert.ok(!JSON.stringify(stored).includes(adminPassword))

 const blockedMail=await req('/api/auth/sign-in/magic-link',{method:'POST',...json({email:'not-an-admin@example.com',callbackURL:'/'},{origin:'http://localhost'})})
 assert.equal(blockedMail.status,200)
 assert.equal(await (await mf.getD1Database('DB')).prepare('SELECT id FROM local_mail WHERE recipient=?').bind('not-an-admin@example.com').first(),null)
 const signin=await req('/api/auth/sign-in/magic-link',{method:'POST',...json({email:'admin@example.com',callbackURL:'/'},{origin:'http://localhost'})})
 assert.equal(signin.status,200,await signin.clone().text())
 const sent=await (await mf.getD1Database('DB')).prepare('SELECT url FROM local_mail ORDER BY created DESC LIMIT 1').first<{url:string}>()
 assert.ok(sent)
 const token=new URL(sent.url).searchParams.get('token')!
 const persistedTokens=await (await mf.getD1Database('DB')).prepare('SELECT * FROM web_verification').all()
 assert.ok(!JSON.stringify(persistedTokens.results).includes(token))
 const verify=await req(new URL(sent.url).pathname+new URL(sent.url).search,{redirect:'manual'})
 assert.ok([302,307].includes(verify.status),await verify.clone().text())
 const cookie=verify.headers.get('set-cookie')!
 assert.ok(cookie&&cookie.includes('HttpOnly'))
 const replay=await req(new URL(sent.url).pathname+new URL(sent.url).search,{redirect:'manual'})
 assert.ok(!replay.headers.get('set-cookie')?.includes('session_token='))
 await mf.dispose();mf=make(false)
 assert.equal((await req('/api/books',{method:'POST'})).status,401)
 assert.equal((await req('/api/admin/sync')).status,401)
 assert.equal((await req('/api/admin/sync',{headers:{authorization:'Bearer test-admin'}})).status,401)
 const sessionCookie=cookie.split(';')[0]
 assert.equal((await req('/api/admin/sync',{headers:{cookie:sessionCookie}})).status,200)

 const productionDb=await mf.getD1Database('DB')
 await productionDb.prepare("UPDATE web_user SET email='removed@example.com' WHERE email='admin@example.com'").run()
 assert.equal((await req('/api/admin/sync',{headers:{cookie:sessionCookie}})).status,401)
 await productionDb.prepare("UPDATE web_user SET email='admin@example.com' WHERE email='removed@example.com'").run()
 assert.equal((await req('/api/local/mail')).status,404)
 assert.equal((await req('/api/admin/accounts',{method:'POST',...json({username:'prod-created',password:adminPassword},{cookie:sessionCookie,origin:'https://evil.invalid'})})).status,403)
 assert.equal((await req('/api/admin/accounts',{method:'POST',...json({username:'prod-created',password:adminPassword},{cookie:sessionCookie,origin:'http://localhost'})})).status,201)
 assert.equal((await req('/api/auth/sign-out',{method:'POST',...json({},{cookie:sessionCookie,origin:'http://localhost'})})).status,200)
 assert.equal((await req('/api/admin/sync',{headers:{cookie:sessionCookie}})).status,401)
 assert.equal((await req('/api/v1/progress/changes',{headers:auth})).status,404)
 assert.equal((await req('/users/create',{method:'POST',...json({username:'closed',password:key})})).status,402)
 assert.equal((await req('/opds/v2/catalog.json')).status,401)
 for(const path of ['/api/books','/api/books/'+pdfBook.id,'/api/books/'+pdfBook.id+'/download','/api/books/'+pdfBook.id+'/cover'])assert.equal((await req(path)).status,401)
 const basic='Basic '+Buffer.from('provisioned:'+adminPassword).toString('base64')
 assert.equal((await req('/opds/v2/catalog.json',{headers:{authorization:basic}})).status,200)
 assert.equal((await req('/api/books',{headers:{authorization:basic}})).status,200)
 assert.equal((await req('/api/books/'+pdfBook.id+'/download',{headers:{authorization:basic}})).status,200)
 assert.equal((await req('/api/books',{headers:{authorization:'Basic '+Buffer.from('provisioned:wrong').toString('base64')}})).status,401)
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true})}
})
