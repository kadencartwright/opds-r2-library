import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {epub} from '../tests/fixtures'
const origin=new URL(process.env.LIBRARY_URL||'http://localhost:8787').origin
const label='Local smoke '+Date.now(),ids:string[]=[]
let cookie=process.env.LIBRARY_COOKIE_FILE?(await readFile(process.env.LIBRARY_COOKIE_FILE,'utf8')).trim():'',localSession=false
const request=async(path:string,init?:RequestInit)=>{
 const url=new URL(path,origin);assert.equal(url.origin,origin,'Smoke requests must stay on the configured origin')
 const headers=new Headers(init?.headers);headers.set('origin',origin);if(cookie)headers.set('cookie',cookie)
 const r=await fetch(url,{...init,headers,redirect:'manual'});assert.ok(r.ok,r.status+' '+await r.clone().text());return r
}
if(!cookie){
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname),'Remote smoke requires LIBRARY_COOKIE_FILE containing an authenticated Cookie header value')
 const signin=await request('/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@example.com',callbackURL:'/'})})
 assert.equal(signin.status,200)
 const mails=await request('/api/local/mail').then(r=>r.json()) as {recipient:string;url:string}[]
 const mail=mails.find(m=>m.recipient==='admin@example.com');assert.ok(mail,'Local simulated sign-in mail must exist')
 const url=new URL(mail.url);assert.equal(url.origin,origin,'Use the configured AUTH_ORIGIN for local smoke')
 const verified=await fetch(url,{redirect:'manual'});assert.equal(verified.status,302)
 cookie=verified.headers.get('set-cookie')?.split(';')[0]||'';assert.ok(cookie,'Local sign-in must establish a session');localSession=true
 console.log('AUTH local simulated email sign-in PASS (no credentials printed)')
}
try{
try{
 for(let n=1;n<=2;n++){
 const bytes=epub(label+' '+n)
 const r=await request('/api/books',{method:'POST',headers:{'content-type':'application/epub+zip','x-filename':'smoke.epub'},body:bytes})
 assert.equal(r.status,201)
 const book=await r.json() as {id:string;title:string}
 ids.push(book.id);console.log('UPLOAD',r.status,book.title)
 const downloaded=Buffer.from(await request('/api/books/'+book.id+'/download').then(r=>r.arrayBuffer()))
 assert.deepEqual(downloaded,Buffer.from(bytes))
 assert.equal(createHash('sha256').update(downloaded).digest('hex'),book.id)
 console.log('DOWNLOAD 200 byte comparison PASS SHA256',book.id)
 }
 const listing=await request('/api/books?q='+encodeURIComponent(label)).then(r=>r.json()) as {total:number}
 assert.equal(listing.total,2);console.log('LIST metadata/search PASS total='+listing.total)
 const feed=await request('/opds/v2/catalog.json?limit=1&q='+encodeURIComponent(label))
 assert.equal(feed.headers.get('content-type'),'application/opds+json')
 const data=await feed.json() as {metadata:{numberOfItems:number};publications:unknown[];links:{rel:string;href:string}[]}
 assert.equal(data.metadata.numberOfItems,2);assert.equal(data.publications.length,1)
 const next=data.links.find(l=>l.rel==='next');assert.ok(next)
 assert.equal((await request(next.href).then(r=>r.json()) as typeof data).publications.length,1)
 console.log('OPDS 200 application/opds+json total=2 page-size=1 next-page PASS')
}finally{
 for(const id of ids){const r=await request('/api/books/'+id,{method:'DELETE'});assert.equal(r.status,200);console.log('DELETE 200',id)}
}
const remaining=await request('/api/books?q='+encodeURIComponent(label)).then(r=>r.json()) as {total:number}
assert.equal(remaining.total,0);console.log('VERIFY no longer listed PASS total=0')
}finally{
 if(localSession){await request('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});console.log('AUTH local session signed out PASS')}
}
