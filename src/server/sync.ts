import { md5 } from '@noble/hashes/legacy.js'
import { Effect, Schema } from 'effect'
import { Store, Bindings, jsonBody, body, fail, attempt, admin } from './core'
const valid=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256
const identity=(v:unknown):v is string=>valid(v)&&!v.includes(':')
export const protocolError=(code:number)=>fail(code===2001?401:code===2002||code===2005?402:403,
 ({2001:'Unauthorized',2002:'Username is already registered.',2003:'Invalid request',2004:"Field 'document' not provided.",2005:'User registration is disabled.'} as Record<number,string>)[code],code)
export const parse=(r:Request,limit=32768)=>body(r,limit).pipe(Effect.mapError(()=>protocolError(2003)),Effect.flatMap(b=>Effect.try({try:()=>JSON.parse(new TextDecoder().decode(b)),catch:()=>protocolError(2003)})),Effect.flatMap(v=>typeof v==='object'&&v!==null&&!Array.isArray(v)?Effect.succeed(v as Record<string,unknown>):Effect.fail(protocolError(2003))))
const verifier=(key:string,salt:string)=>attempt(async()=>{
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),'PBKDF2',false,['deriveBits'])
 const b=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:100000},material,256)
 return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('')
})
const equal=(a:string,b:string)=>{let difference=a.length^b.length;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0}
const throttle=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings;if(env.LOCAL_DEV==='true')return
 const s=yield* Store;const key=r.headers.get('cf-connecting-ip')||'unknown';const window=Math.floor(Date.now()/60000)
 yield* s.run('INSERT INTO throttle VALUES (?,?,1) ON CONFLICT(identity) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END, window=excluded.window',key,window)
 const rows=yield* s.all<{count:number}>('SELECT count FROM throttle WHERE identity=?',key)
 if(rows[0].count>60)return yield* Effect.fail(fail(429,'Too many requests',2001))
 yield* s.run('DELETE FROM throttle WHERE window<?',window-2)
})
export const register=(r:Request)=>Effect.gen(function*(){
 yield* throttle(r);const env=yield* Bindings
 if(env.LOCAL_DEV!=='true'&&env.ENABLE_REGISTRATION!=='true')return yield* Effect.fail(protocolError(2005))
 const v=yield* parse(r)
 if(!identity(v.username)||!valid(v.password))return yield* Effect.fail(protocolError(2003))
 const s=yield* Store;const salt=crypto.randomUUID();const hash=yield* verifier(v.password,salt)
 const result=yield* s.run('INSERT OR IGNORE INTO accounts VALUES (?,?,?,?)',v.username,salt,hash,Math.floor(Date.now()/1000))
 if(!result.meta.changes)return yield* Effect.fail(protocolError(2002))
 return {username:v.username}
})
export const auth=(r:Request)=>Effect.gen(function*(){
 yield* throttle(r)
 const username=r.headers.get('x-auth-user'),key=r.headers.get('x-auth-key')
 if(!identity(username)||!valid(key))return yield* Effect.fail(protocolError(2001))
 const s=yield* Store;const rows=yield* s.all<{salt:string;verifier:string}>('SELECT salt,verifier FROM accounts WHERE username=?',username)
 const hash=yield* verifier(key,rows[0]?.salt||'missing-user-salt')
 if(!rows[0]||!equal(rows[0].verifier,hash))return yield* Effect.fail(protocolError(2001))
 return {username,hash}
})
export const authenticate=(r:Request)=>auth(r).pipe(Effect.as({authorized:'OK'}))
export const diagnostics=(r:Request)=>Effect.gen(function*(){
 yield* admin(r);const s=yield* Store
 const accounts=yield* s.all('SELECT username,created FROM accounts ORDER BY username LIMIT 100')
 const progress=yield* s.all('SELECT username,document,payload,timestamp,book_id FROM progress ORDER BY timestamp DESC LIMIT 100')
 const incomplete=yield* s.all("SELECT id,state,filename FROM books WHERE state!='ready' LIMIT 100")
 const devices=yield* s.all('SELECT username,document,device_key,payload,timestamp FROM device_progress ORDER BY timestamp DESC,sequence DESC LIMIT 100')
 const annotations=yield* s.all('SELECT username,document,kind,count(*) items,sum(deleted) tombstones FROM annotations GROUP BY username,document,kind LIMIT 100')
 const documents=yield* s.all('SELECT * FROM documents ORDER BY updated_at DESC LIMIT 100')
 return {capabilities:['OPDS 1.2','OPDS 2.0','KOSync v1','CrossPoint rich progress','Bookmarks delta','Clippings v2 delta','Document metadata'],accounts,progress,devices,annotations,documents,incomplete}
})
export const mapDocument=(r:Request)=>Effect.gen(function*(){
 yield* admin(r);const v=yield* jsonBody(r)
 const s=Schema.Struct({username:Schema.String,document:Schema.String,book_id:Schema.String})
 const data=yield* Schema.decodeUnknownEffect(s)(v).pipe(Effect.mapError(()=>fail(400,'Invalid mapping')))
 const store=yield* Store
 const result=yield* store.run("UPDATE progress SET book_id=? WHERE username=? AND document=? AND EXISTS(SELECT 1 FROM books WHERE id=? AND state='ready')",data.book_id,data.username,data.document,data.book_id)
 if(!result.meta.changes)return yield* Effect.fail(fail(404,'Progress or book not found'))
 return {mapped:true}
})

export const createAccount=(r:Request)=>Effect.gen(function*(){
 yield* admin(r)
 const data=yield* Schema.decodeUnknownEffect(Schema.Struct({username:Schema.String,password:Schema.String}))(yield* jsonBody(r)).pipe(Effect.mapError(()=>fail(400,'Username and password required')))
 if(!/^[A-Za-z0-9._@+-]{1,64}$/.test(data.username)||data.password.length<16||data.password.length>128)return yield* Effect.fail(fail(400,'Use a valid username and a device password of 16–128 characters'))
 const key=Array.from(md5(new TextEncoder().encode(data.password)),b=>b.toString(16).padStart(2,'0')).join('')
 const salt=crypto.randomUUID(),hash=yield* verifier(key,salt),s=yield* Store
 const result=yield* s.run('INSERT OR IGNORE INTO accounts VALUES (?,?,?,?)',data.username,salt,hash,Math.floor(Date.now()/1000))
 if(!result.meta.changes)return yield* Effect.fail(fail(409,'Username is already registered'))
 return {username:data.username,created:true}
})

// These lifecycle routes are administrator-only; protocol clients cannot manage peers.
export const listAccounts=(r:Request)=>Effect.gen(function*(){
 yield* admin(r);const s=yield* Store,url=new URL(r.url),page=Number(url.searchParams.get('page')||1)
 if(!Number.isSafeInteger(page)||page<1||page>100000)return yield* Effect.fail(fail(400,'Invalid account page'))
 const [accounts,count]=yield* Effect.all([s.all<{username:string;created:number}>('SELECT username,created FROM accounts ORDER BY username LIMIT 25 OFFSET ?',(page-1)*25),s.all<{n:number}>('SELECT count(*) n FROM accounts')],{concurrency:2})
 return {accounts,total:count[0].n,page}
})
const accountName=(username:string)=>valid(username)&&!username.includes(':')
export const updatePassword=(r:Request,username:string)=>Effect.gen(function*(){
 yield* admin(r)
 if(!accountName(username))return yield* Effect.fail(fail(400,'Invalid username'))
 const data=yield* Schema.decodeUnknownEffect(Schema.Struct({password:Schema.String}))(yield* jsonBody(r)).pipe(Effect.mapError(()=>fail(400,'Password required')))
 if(data.password.length<16||data.password.length>128)return yield* Effect.fail(fail(400,'Device password must be 16–128 characters'))
 const salt=crypto.randomUUID(),key=Array.from(md5(new TextEncoder().encode(data.password)),b=>b.toString(16).padStart(2,'0')).join(''),hash=yield* verifier(key,salt),s=yield* Store
 const result=yield* s.run('UPDATE accounts SET salt=?,verifier=? WHERE username=?',salt,hash,username)
 if(!result.meta.changes)return yield* Effect.fail(fail(404,'Reader account not found'))
 return {username,updated:true}
})
export const deleteAccount=(r:Request,username:string)=>Effect.gen(function*(){
 yield* admin(r)
 if(!accountName(username))return yield* Effect.fail(fail(400,'Invalid username'))
 const s=yield* Store
 // D1 foreign keys atomically cascade progress, devices, documents and annotations.
 // Book records and R2 originals are independent of accounts and remain untouched.
 const result=yield* s.run('DELETE FROM accounts WHERE username=?',username)
 if(!result.meta.changes)return yield* Effect.fail(fail(404,'Reader account not found'))
 return {username,deleted:true}
})

export const reader=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings
 if(env.PRIVATE_LIBRARY==='false'&&env.LOCAL_DEV==='true'&&env.ALLOW_LOCAL_ADMIN==='true')return
 const authorization=r.headers.get('authorization')||''
 if(authorization.startsWith('Basic ')){
  const decoded=yield* Effect.try({try:()=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(authorization.slice(6)),c=>c.charCodeAt(0))),catch:()=>fail(401,'Reader credentials required')})
  const colon=decoded.indexOf(':')
  if(colon<1||decoded.length>1024)return yield* Effect.fail(fail(401,'Reader credentials required'))
  const username=decoded.slice(0,colon),password=decoded.slice(colon+1)
  const key=Array.from(md5(new TextEncoder().encode(password)),b=>b.toString(16).padStart(2,'0')).join('')
  yield* auth(new Request(r.url,{headers:{'x-auth-user':username,'x-auth-key':key,...(r.headers.has('cf-connecting-ip')?{'cf-connecting-ip':r.headers.get('cf-connecting-ip')!}:{})}}))
  return
 }
 yield* admin(r)
})
