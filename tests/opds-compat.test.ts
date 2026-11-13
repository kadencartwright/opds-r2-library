import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Miniflare} from 'miniflare'
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createHash,pbkdf2Sync} from 'node:crypto'
import {execFile,spawnSync} from 'node:child_process'
import {promisify} from 'node:util'
import {XMLParser,XMLValidator} from 'fast-xml-parser'
import {epub,pdf,coverPNG} from './fixtures'
import {validateOPDS} from './opds'

test('private OPDS 1.2/2.0 GET and HEAD, Atom escaping, search, pagination and acquisition',async t=>{
 const origin='http://127.0.0.1:8794',dir=await mkdtemp(tmpdir()+'/folio-opds-')
 const mf=new Miniflare({modules:true,scriptPath:'dist-worker/worker.js',assets:{directory:'dist',binding:'ASSETS',routerConfig:{has_user_worker:true,static_routing:{user_worker:['/api/*','/opds','/opds/*']}}},port:8794,compatibilityDate:'2026-07-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'opds'},r2Buckets:{ARCHIVE:'opds'},bindings:{LOCAL_DEV:'true',PRIVATE_LIBRARY:'true'}})
 const basic='Basic '+Buffer.from('reader:reader-password-for-test').toString('base64')
 const headers={authorization:basic,accept:'application/opds+json, application/atom+xml;profile=opds-catalog, */*','accept-encoding':'identity'}
 const req=(path:string,init?:Parameters<Miniflare['dispatchFetch']>[1])=>mf.dispatchFetch(new URL(path,origin).href,{redirect:'manual',...init})
 const parse=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',isArray:name=>['entry','link','author'].includes(name)})
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE')
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile('migrations/'+file,'utf8')).replace(/^--.*$/gm,'').split(';').filter(s=>s.trim()))await db.prepare(sql).run()
  const key=createHash('md5').update('reader-password-for-test').digest('hex'),salt='test-salt'
  await db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind('reader',salt,pbkdf2Sync(key,salt,100000,32,'sha256').toString('hex'),0).run()
  const paths=['/opds/v2/catalog.json','/opds/v1/catalog.xml','/opds/v1/search.xml','/opds','/opds/']
  // Empty feeds still use their own correct formats and discovery, without fake books.
  for(const path of paths)for(const method of ['HEAD','GET']){
   const unsigned=await req(path,{method});assert.equal(unsigned.status,401,path+' '+method);assert.match(unsigned.headers.get('www-authenticate')||'',/^Basic /)
   assert.equal((await req(path,{method,headers:{authorization:'Basic '+Buffer.from('reader:wrong').toString('base64')}})).status,401)
   const r=await req(path,{method,headers});assert.equal(r.status,200,path+' '+method);assert.equal(r.headers.get('location'),null);assert.equal(r.headers.get('content-encoding'),null)
   if(method==='HEAD')assert.equal(await r.text(),'')
   else if(path.endsWith('.json'))assert.ok(validateOPDS(await r.json()),JSON.stringify(validateOPDS.errors))
   else assert.equal(XMLValidator.validate(await r.text()),true)
  }
  const bytes=epub(),id=createHash('sha256').update(bytes).digest('hex'),pdfBytes=pdf(),pdfId=createHash('sha256').update(pdfBytes).digest('hex')
  for(const b of [{id,bytes,title:'A <Tiny> & "Journey"',authors:'Legal & Author',media:'application/epub+zip',filename:'tiny.epub',modified:'2026-11-08T01:00:00.000Z',cover:'image/png'}, {id:pdfId,bytes:pdfBytes,title:'PDF title',authors:'',media:'application/pdf',filename:'tiny.pdf',modified:'2026-11-07T01:00:00.000Z',cover:null}]){
   await db.prepare("INSERT INTO books(id,object_key,title,authors,filename,media_type,size,modified,state,cover_type) VALUES (?,?,?,?,?,?,?,?,'ready',?)").bind(b.id,'originals/'+b.id,b.title,b.authors,b.filename,b.media,b.bytes.length,b.modified,b.cover).run()
   await bucket.put('originals/'+b.id,b.bytes)
  }
  await bucket.put('originals/'+id+'.cover',coverPNG)
  for(const path of ['/opds/v1/catalog.xml','/opds','/opds/']){
   const response=await req(path+'?limit=1',{headers});assert.match(response.headers.get('content-type')||'',/^application\/atom\+xml;profile=opds-catalog;kind=acquisition/)
   const text=await response.text();assert.equal(XMLValidator.validate(text),true)
   const {feed}=parse.parse(text);assert.equal(feed.xmlns,'http://www.w3.org/2005/Atom');assert.equal(feed['opensearch:totalResults'],2)
   assert.equal(feed.entry.length,1);assert.equal(feed.entry[0].title,'A <Tiny> & "Journey"');assert.equal(feed.entry[0].author[0].name,'Legal & Author');assert.ok(!text.includes('<Tiny>'))
   const link=feed.entry[0].link.find((l:{rel:string})=>l.rel==='http://opds-spec.org/acquisition');assert.equal(link.type,'application/epub+zip');assert.equal(Number(link.length),bytes.length)
   assert.deepEqual(Buffer.from(await req(link.href,{headers}).then(r=>r.arrayBuffer())),Buffer.from(bytes))
   const next=feed.link.find((l:{rel:string})=>l.rel==='next');assert.ok(next.href.startsWith(origin+'/opds/v1/catalog.xml?'))
   assert.equal(parse.parse(await req(next.href,{headers}).then(r=>r.text())).feed.entry[0].title,'PDF title')
   assert.equal(parse.parse(await req(path+'?q=Journey&limit=1',{headers}).then(r=>r.text())).feed.entry.length,1)
  }
  const feed=await req('/opds/v2/catalog.json?limit=1',{headers}).then(r=>r.json()) as {metadata:{numberOfItems:number};publications:{metadata:{title:string};links:{href:string}[]}[];links:{rel:string;href:string}[]}
  assert.ok(validateOPDS(feed),JSON.stringify(validateOPDS.errors));assert.equal(feed.publications[0].metadata.title,'A <Tiny> & "Journey"');assert.equal(feed.metadata.numberOfItems,2)
  const search=feed.links.find(l=>l.rel==='search')!.href.replace('{searchTerms}','Journey')
  assert.equal((await req(search,{headers}).then(r=>r.json()) as typeof feed).metadata.numberOfItems,1)
  for(const path of ['/api/books/'+id,'/api/books/'+id+'/download','/api/books/'+id+'/cover'])for(const method of ['HEAD','GET']){
   assert.equal((await req(path,{method})).status,401)
   const r=await req(path,{method,headers});assert.equal(r.status,200);assert.equal(r.headers.get('location'),null)
   if(method==='HEAD')assert.equal(await r.text(),'')
   if(path.endsWith('download')){assert.match(r.headers.get('content-disposition')||'',/filename="tiny.epub"/);if(method==='HEAD')assert.equal(r.headers.get('content-length'),String(bytes.length))}
  }
  for(const method of ['HEAD','GET']){assert.equal((await req('/opds/v2/catalog.json?page=0',{method,headers})).status,400);assert.equal((await req('/api/books/missing/download',{method,headers})).status,404)}
  // Real LuaSocket and unmodified KOReader code, not a reimplementation of field parsing.
  const lua=spawnSync('luajit',['-v'])
  await t.test('unmodified KOReader v2026.07, v2026.07.2 and pinned current master over real HTTP', {skip:lua.error?'Install luajit lua-socket lua-cjson to run native compatibility harness':false},async()=>{
   await mf.ready
   for(const version of ['v2026.07','v2026.07.2','master']){
    const {stdout}=await promisify(execFile)('luajit',['tests/koreader-harness.lua','tests/vendor/koreader',version,origin,dir])
    console.log(stdout)
    for(const path of ['/opds/v2/catalog.json','/opds/v1/catalog.xml','/opds','/opds/'])assert.deepEqual(await readFile(dir+'/'+version+'-'+path.replaceAll('/','_')+'.epub'),Buffer.from(bytes))
   }
  })
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true})}
})
