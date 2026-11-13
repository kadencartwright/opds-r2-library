import { Effect, Schema } from 'effect'
import { Store, fail } from './core'
import { auth, parse, protocolError } from './sync'
type Json=Record<string,unknown>
type Statement=readonly [string,...unknown[]]
const now=()=>Math.floor(Date.now()/1000)
const object=(v:unknown):v is Json=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const bytes=(s:string)=>new TextEncoder().encode(s).length
const uint=(n:unknown,max=0xffffffff):n is number=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=max
const doc=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(v)
const document=(v:unknown)=>doc(v)?Effect.succeed(v):Effect.fail(protocolError(2004))
const Position=Schema.Struct({pctQ:Schema.Number,spine:Schema.Number,page:Schema.Number,pages:Schema.Number,para:Schema.optional(Schema.Number),li:Schema.optional(Schema.Number),anchor:Schema.optional(Schema.String),xpath:Schema.optional(Schema.String)})
export const position=(value:unknown)=>Effect.gen(function*(){
 const p=yield* Schema.decodeUnknownEffect(Position)(value).pipe(Effect.catch(()=>Effect.succeed(null)))
 if(!p||!uint(p.pctQ,1000000)||![p.spine,p.page,p.pages].every(n=>uint(n,65535))||[p.para,p.li].some(n=>n!==undefined&&!uint(n,65535))||(p.anchor!==undefined&&bytes(p.anchor)>48)||(p.xpath!==undefined&&bytes(p.xpath)>120))return null
 return p
})
const metaStatements=(username:string,document:string,metadata:unknown,timestamp:number):Statement[]=>{
 if(!object(metadata))return []
 const field=(key:string)=>typeof metadata[key]==='string'&&(metadata[key] as string).length<=512?metadata[key]:null
 const language=field('language')
 const size=uint(metadata.filesize)?metadata.filesize:null
 return [[
 'INSERT INTO documents(username,document,title,author,filename,language,filesize,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(username,document) DO UPDATE SET title=coalesce(excluded.title,documents.title),author=coalesce(excluded.author,documents.author),filename=coalesce(excluded.filename,documents.filename),language=coalesce(documents.language,excluded.language),filesize=coalesce(excluded.filesize,documents.filesize),updated_at=excluded.updated_at',
 username,document,field('title'),field('authors')??field('author'),field('filename'),typeof language==='string'&&/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(language)?language:null,size,timestamp]]
}
const Progress=Schema.Struct({progress:Schema.String,percentage:Schema.Number,device:Schema.String,device_id:Schema.optional(Schema.String)})
export const push=(r:Request,extended=false)=>Effect.gen(function*(){
 const {username,hash}=yield* auth(r);const v=yield* parse(r)
 const documentId=yield* document(v.document)
 const p=yield* Schema.decodeUnknownEffect(Progress)(v).pipe(Effect.mapError(()=>protocolError(2003)))
 if(!Number.isFinite(p.percentage)||p.percentage<0||p.percentage>1||bytes(p.progress)>4096||p.device.length>128||(p.device_id?.length||0)>128)return yield* Effect.fail(protocolError(2003))
 const s=yield* Store,device=p.device_id||p.device
 if(!device)return yield* Effect.fail(protocolError(2003))
 const rich=yield* position(v.position)
 let timestamp=now()
 if(extended && uint(v.timestamp)&&v.timestamp>=946684800)timestamp=Math.min(v.timestamp,timestamp)
 // SQL merges preserve the position for THIS device; plain devices cannot erase another's rich state.
 const payload=JSON.stringify({document:documentId,...p,device_id:device,timestamp,...(rich?{position:rich}:{}),...(object(v.metadata)?{metadata:Object.fromEntries(Object.entries(v.metadata).filter(([k,value])=>['title','authors','filename','language'].includes(k)&&typeof value==='string'&&value.length<=512))}:{})})
 const statements:Statement[]=[
 ['UPDATE sync_clock SET sequence=sequence+1 WHERE id=1'],
 ["INSERT INTO device_progress(username,document,device_key,payload,timestamp,sequence) SELECT username,?,?,?, ?, (SELECT sequence FROM sync_clock WHERE id=1) FROM accounts WHERE username=? AND verifier=? ON CONFLICT(username,document,device_key) DO UPDATE SET payload=CASE WHEN json_type(excluded.payload,'$.position')='object' THEN json_set(json_patch(device_progress.payload,excluded.payload),'$.position',json_extract(excluded.payload,'$.position')) ELSE json_patch(device_progress.payload,excluded.payload) END,timestamp=excluded.timestamp,sequence=excluded.sequence WHERE excluded.timestamp>=device_progress.timestamp",documentId,device,payload,timestamp,username,hash],
 ...metaStatements(username,documentId,v.metadata,timestamp),
 // Keep the shared winner row for diagnostics and explicit archive mapping.
 ["INSERT INTO progress(username,document,payload,timestamp) SELECT username,document,payload,timestamp FROM device_progress WHERE username=? AND document=? ORDER BY timestamp DESC,sequence DESC LIMIT 1 ON CONFLICT(username,document) DO UPDATE SET payload=excluded.payload,timestamp=excluded.timestamp",username,documentId]
 ]
 yield* s.batch(statements)
 return {document:documentId,timestamp}
})
export const pull=(r:Request,id:string,extended=false)=>Effect.gen(function*(){
 const {username}=yield* auth(r);yield* document(id);const s=yield* Store
 const rows=yield* s.all<{payload:string}>('SELECT payload FROM device_progress WHERE username=? AND document=? ORDER BY timestamp DESC,sequence DESC LIMIT 100',username,id)
 const values=rows.map(row=>JSON.parse(row.payload) as Json)
 if(extended)return {document:id,devices:values.map(({document,metadata,...v})=>({position:null,...v}))}
 return values[0]||{}
})
const pagination=(r:Request,defaultLimit:number,max:number)=>Effect.gen(function*(){
 const u=new URL(r.url),limit=Number(u.searchParams.get('limit')||defaultLimit),cursor=u.searchParams.get('cursor')
 if(!Number.isSafeInteger(limit)||limit<1||limit>max)return yield* Effect.fail(protocolError(2003))
 if(cursor&&!/^\d+:[A-Za-z0-9._-]{1,64}$/.test(cursor))return yield* Effect.fail(protocolError(2003))
 return {limit,time:cursor?Number(cursor.split(':')[0]):Number.MAX_SAFE_INTEGER,id:cursor?cursor.split(':')[1]:'~'}
})
export const listProgress=(r:Request)=>Effect.gen(function*(){
 const {username}=yield* auth(r),{limit,time,id}=yield* pagination(r,100,500),s=yield* Store
 const rows=yield* s.all<{document:string;payload:string;timestamp:number;title:string|null;author:string|null;filename:string|null}>(
 'SELECT p.document,p.payload,p.timestamp,d.title,d.author,d.filename FROM progress p LEFT JOIN documents d ON d.username=p.username AND d.document=p.document WHERE p.username=? AND (p.timestamp<? OR (p.timestamp=? AND p.document<?)) ORDER BY p.timestamp DESC,p.document DESC LIMIT ?',username,time,time,id,limit+1)
 const items=rows.slice(0,limit).map(row=>({...JSON.parse(row.payload),title:row.title,author:row.author,filename:row.filename,status:Number(JSON.parse(row.payload).percentage)>=.98?'finished':'reading',status_at:null,cover_url:null,page_count:null}))
 const last=rows[Math.min(rows.length,limit)-1]
 return {items,next:rows.length>limit?last.timestamp+':'+last.document:null}
})
export const putDocuments=(r:Request)=>Effect.gen(function*(){
 const {username}=yield* auth(r),v=yield* parse(r),s=yield* Store
 if(!Array.isArray(v.items)||v.items.length<1||v.items.length>50)return yield* Effect.fail(protocolError(2003))
 const statements:Statement[]=[]
 for(const item of v.items){
  if(!object(item))return yield* Effect.fail(protocolError(2003))
  const id=yield* document(item.document)
  for(const key of ['title','authors','author','filename','language'])if(item[key]!==undefined&&(typeof item[key]!=='string'||(item[key] as string).length>512))return yield* Effect.fail(protocolError(2003))
  if(item.filesize!==undefined&&!uint(item.filesize))return yield* Effect.fail(protocolError(2003))
  statements.push(...metaStatements(username,id,item,now()))
 }
 yield* s.batch(statements);return {accepted:v.items.length}
})
export const getDocuments=(r:Request)=>Effect.gen(function*(){
 const {username}=yield* auth(r),{limit,time,id}=yield* pagination(r,500,500),s=yield* Store
 const rows=yield* s.all<{document:string;updated_at:number}>('SELECT document,title,author,filename,language,filesize,updated_at FROM documents WHERE username=? AND (updated_at<? OR (updated_at=? AND document<?)) ORDER BY updated_at DESC,document DESC LIMIT ?',username,time,time,id,limit+1)
 const last=rows[Math.min(rows.length,limit)-1]
 return {items:rows.slice(0,limit),next:rows.length>limit?last.updated_at+':'+last.document:null}
})
const annotationItem=(raw:unknown,kind:string):Effect.Effect<Json,import('./core').Failure>=>Effect.gen(function*(){
 if(!object(raw)||typeof raw.id!=='string'||!/^[a-fA-F0-9]{16}$/.test(raw.id))return yield* Effect.fail(protocolError(2003))
 if(raw.deleted===1||raw.deleted===true)return {id:raw.id,deleted:1}
 const isBookmark=kind==='bookmarks'
 if(isBookmark){
  const schema=Schema.Struct({id:Schema.String,xpath:Schema.String,percentage:Schema.Number})
  const v=yield* Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError(()=>protocolError(2003)))
  if(v.xpath.length>512||!Number.isFinite(v.percentage)||v.percentage<0||v.percentage>1||['si','pc','pp'].some(k=>raw[k]!=null&&!uint(raw[k],65535)))return yield* Effect.fail(protocolError(2003))
  return {...v,summary:typeof raw.summary==='string'?raw.summary.slice(0,256):'',si:raw.si??null,pc:raw.pc??null,pp:raw.pp??null,deleted:0}
 }
 if(!uint(raw.spine)||typeof raw.text!=='string'||bytes(raw.text)>4096||typeof (raw.chapter??'')!=='string'||String(raw.chapter??'').length>64||
 ['start_page','end_page','pages','start_word','end_word','words','created_at','layout_signature','para','start_offset','end_offset'].some(k=>raw[k]!=null&&!uint(raw[k]))||
 ((raw.start_offset==null)!==(raw.end_offset==null))||(raw.start_offset!=null&&Number(raw.end_offset)<=Number(raw.start_offset))||
 (raw.note!==undefined&&raw.note!==null&&(typeof raw.note!=='string'||bytes(raw.note)>4096))||
 (raw.color!==undefined&&raw.color!==null&&(typeof raw.color!=='string'||raw.color.length>64)))return yield* Effect.fail(protocolError(2003))
 return {id:raw.id,spine:raw.spine,text:raw.text,chapter:raw.chapter??'',start_page:raw.start_page??0,end_page:raw.end_page??0,pages:raw.pages??1,start_word:raw.start_word??0,end_word:raw.end_word??0,words:raw.words??0,created_at:raw.created_at??0,layout_signature:raw.layout_signature??0,para:raw.para??null,start_offset:raw.start_offset??null,end_offset:raw.end_offset??null,...(raw.note!==undefined?{note:raw.note}:{}),...(raw.color!==undefined?{color:raw.color}:{}),deleted:0}
})
export const putAnnotations=(r:Request,id:string,kind:'bookmarks'|'clippings')=>Effect.gen(function*(){
 const {username}=yield* auth(r);yield* document(id);const v=yield* parse(r,524288),s=yield* Store
 if(!Array.isArray(v.items)||v.items.length<1||v.items.length>50)return yield* Effect.fail(protocolError(2003))
 // Complete validation precedes the transaction: a bad tail cannot partially commit.
 const items:Json[]=[];for(const raw of v.items)items.push(yield* annotationItem(raw,kind))
 const statements:Statement[]=[]
 for(const item of items){
  statements.push(['UPDATE sync_clock SET sequence=sequence+1,bookmark_time=max(bookmark_time+1,?) WHERE id=1',now()])
  statements.push([
  "INSERT INTO annotations(username,document,kind,id,payload,deleted,updated_at,revision) VALUES (?,?,?,?,?,?,CASE WHEN ?='bookmarks' THEN (SELECT bookmark_time FROM sync_clock WHERE id=1) ELSE ? END,(SELECT sequence FROM sync_clock WHERE id=1)) ON CONFLICT(username,document,kind,id) DO UPDATE SET payload=json_patch(annotations.payload,excluded.payload),deleted=excluded.deleted,updated_at=excluded.updated_at,revision=excluded.revision WHERE annotations.kind='bookmarks' OR annotations.deleted=0 OR excluded.deleted=1",
  username,id,kind,item.id,JSON.stringify(item),item.deleted,kind,now()])
 }
 yield* s.batch(statements)
 const clock=yield* s.all<{bookmark_time:number}>('SELECT bookmark_time FROM sync_clock WHERE id=1')
 return {until:kind==='bookmarks'?clock[0].bookmark_time:now(),accepted:items.length}
})
export const getAnnotations=(r:Request,id:string,kind:'bookmarks'|'clippings')=>Effect.gen(function*(){
 const {username}=yield* auth(r);yield* document(id);const s=yield* Store,u=new URL(r.url)
 const limit=Number(u.searchParams.get('limit')||50),since=Number(u.searchParams.get('since')||0),cursor=u.searchParams.get('cursor')
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!uint(since,Number.MAX_SAFE_INTEGER)||(cursor!==null&&!uint(Number(cursor),Number.MAX_SAFE_INTEGER)))return yield* Effect.fail(protocolError(2003))
 const revisionMode=kind==='clippings'&&cursor!==null
 const column=revisionMode?'revision':'updated_at'
 const rows=yield* s.all<{payload:string;deleted:number;updated_at:number;revision:number}>('SELECT payload,deleted,updated_at,revision FROM annotations WHERE username=? AND document=? AND kind=? AND '+column+'>? ORDER BY '+column+',revision LIMIT ?',username,id,kind,revisionMode?Number(cursor):since,limit+1)
 const more=rows.length>limit,page=rows.slice(0,limit),last=page.at(-1)
 const items=page.map(row=>{
  const payload=JSON.parse(row.payload) as Json
  const value={...(kind==='clippings'?{note:null,color:null}:{}),...payload,deleted:row.deleted,updated_at:row.updated_at,...(kind==='clippings'?{revision:row.revision}:{})}
  if(kind==='clippings'&&u.searchParams.get('format')==='reader'){delete value.note;delete value.color}
  return value
 })
 return {document:id,until:last?.updated_at??since,more,items,...(kind==='clippings'?{sync_version:2,cursor:last?.revision??Number(cursor||0)}:{})}
})
