import { Effect } from 'effect'
import { Store, Book, body, fail, attempt, sha256, admin, jsonBody, decode, Edit } from './core'
import { extract, MAX_UPLOAD } from './ingest'
export const list=(url:URL,newestFirst=false)=>Effect.gen(function*(){
 const s=yield* Store
 const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||12),q=url.searchParams.get('q')??url.searchParams.get('query')??''
 if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(limit)||limit<1||limit>100||q.length>200)return yield* Effect.fail(fail(400,'Invalid pagination or search'))
 const where="state='ready' AND (instr(lower(title),lower(?))>0 OR instr(lower(authors),lower(?))>0)"
 const [books,count]=yield* Effect.all([s.all<Book>('SELECT * FROM books WHERE '+where+' ORDER BY '+(newestFirst?'modified DESC, id':'id')+' LIMIT ? OFFSET ?',q,q,limit,(page-1)*limit),s.all<{n:number}>('SELECT count(*) n FROM books WHERE '+where,q,q)],{concurrency:2})
 return {books,total:count[0].n,page,limit}
})
export const get=(id:string,includeDeleting=false)=>Effect.gen(function*(){
 const s=yield* Store;const rows=yield* s.all<Book>("SELECT * FROM books WHERE id=? AND state "+(includeDeleting?"IN ('ready','deleting')":"='ready'"),id)
 if(!rows[0])return yield* Effect.fail(fail(404,'Book not found'))
 return rows[0]
})
export const uploadAuthorized=(r:Request)=>Effect.gen(function*(){
 const filename=r.headers.get('x-filename')||''
 if(!filename||filename.length>250||/[\x00-\x1f/\\]/.test(filename))return yield* Effect.fail(fail(400,'Provide a safe x-filename'))
 const bytes=yield* body(r,MAX_UPLOAD)
 const metadata=yield* extract(bytes,filename,r.headers.get('content-type')?.split(';')[0]||'')
 const id=yield* sha256(bytes);const s=yield* Store;const key='originals/'+id
 const existing=yield* s.all<Book>('SELECT * FROM books WHERE id=?',id)
 if(existing.length)return yield* Effect.fail(fail(409,'Duplicate or pending book: '+id))
 const now=new Date().toISOString()
 // Claim before R2 write: concurrent duplicate requests never own another request's cleanup.
 const claim=yield* s.run("INSERT OR IGNORE INTO books(id,object_key,title,authors,filename,media_type,size,modified,state) VALUES (?,?,?,?,?,?,?,?,'pending')",id,key,metadata.title,metadata.authors,filename,metadata.media_type,bytes.length,now)
 if(!claim.meta.changes)return yield* Effect.fail(fail(409,'Upload already in progress'))
 yield* Effect.uninterruptible(Effect.gen(function*(){
  yield* attempt(()=>s.bucket.put(key,bytes,{httpMetadata:{contentType:metadata.media_type}}))
  if(metadata.cover)yield* attempt(()=>s.bucket.put(key+'.cover',metadata.cover!,{httpMetadata:{contentType:metadata.cover_type}}))
  yield* s.run("UPDATE books SET state='ready',cover_type=? WHERE id=?",metadata.cover_type||null,id)
 }).pipe(Effect.catch(e=>Effect.gen(function*(){
  // Keep a pending row if cleanup fails, so an operator can safely recover it.
  yield* attempt(()=>s.bucket.delete([key,key+'.cover']))
  yield* s.run("DELETE FROM books WHERE id=? AND state='pending'",id)
  return yield* Effect.fail(e)
 }))))
 return yield* get(id)
})
export const remove=(r:Request,id:string)=>Effect.gen(function*(){
 yield* admin(r);yield* get(id,true);const s=yield* Store
 yield* Effect.uninterruptible(Effect.gen(function*(){
 yield* s.run("UPDATE books SET state='deleting' WHERE id=?",id)
 yield* attempt(()=>s.bucket.delete(['originals/'+id,'originals/'+id+'.cover']))
 yield* s.run('DELETE FROM books WHERE id=?',id)
 }))
 return {deleted:id}
})
export const edit=(r:Request,id:string)=>Effect.gen(function*(){
 yield* admin(r);yield* get(id);const v=yield* decode(Edit,yield* jsonBody(r))
 if(!v.title.trim()||v.title.length>300||v.authors.length>1000)return yield* Effect.fail(fail(400,'Title required (max 300); authors max 1000'))
 const s=yield* Store;yield* s.run("UPDATE books SET title=?,authors=?,modified=? WHERE id=? AND state='ready'",v.title.trim(),v.authors,new Date().toISOString(),id)
 return yield* get(id)
})
export const download=(id:string,headOnly=false)=>Effect.gen(function*(){
 const b=yield* get(id);const s=yield* Store;const object=yield* attempt(()=>headOnly?s.bucket.head(b.object_key):s.bucket.get(b.object_key))
 if(!object)return yield* Effect.fail(fail(503,'Original missing; contact administrator'))
 // KOReader's filename probe reads filename= but does not understand filename*=.
 const fallback=b.filename.replace(/[^\x20-\x7e]|["\\]/g,'_')
 return new Response(headOnly?null:(object as R2ObjectBody).body,{headers:{'content-type':b.media_type,'content-length':String(b.size),'content-disposition':'attachment; filename="'+fallback+'"; filename*=UTF-8\'\''+encodeURIComponent(b.filename),'etag':object.httpEtag,'x-content-type-options':'nosniff','cache-control':'private, no-store'}})
})
export const ATOM_TYPE='application/atom+xml;profile=opds-catalog;kind=acquisition'
const catalogPage=(url:URL,path:string,page:number,limit:number)=>{
 const u=new URL(path,url),q=url.searchParams.get('q')??url.searchParams.get('query')
 u.searchParams.set('page',String(page));u.searchParams.set('limit',String(limit));if(q)u.searchParams.set('q',q)
 return u.href
}
const xml=(value:string|number)=>String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
const xmlResponse=(value:string,type:string)=>new Response(value,{headers:{'content-type':type,'cache-control':'private, no-store','x-content-type-options':'nosniff'}})
export const catalogAtom=(url:URL)=>Effect.gen(function*(){
 const result=yield* list(url,true),path='/opds/v1/catalog.xml'
 const href=(page:number)=>catalogPage(url,path,page,result.limit)
 const link=(rel:string,href:string,type=ATOM_TYPE)=>'<link rel="'+rel+'" href="'+xml(href)+'" type="'+xml(type)+'" />'
 const entries=result.books.map(b=>'<entry><id>urn:sha256:'+b.id+'</id><title>'+xml(b.title)+'</title><updated>'+xml(b.modified)+'</updated>'+
  (b.authors?b.authors.split(', ').map(name=>'<author><name>'+xml(name)+'</name></author>').join(''):'')+
  '<summary type="text">'+xml(b.filename)+'</summary>'+
  '<link rel="http://opds-spec.org/acquisition" href="'+xml(new URL('/api/books/'+b.id+'/download',url).href)+'" type="'+xml(b.media_type)+'" length="'+b.size+'" />'+
  (b.cover_type?link('http://opds-spec.org/image',new URL('/api/books/'+b.id+'/cover',url).href,b.cover_type):'')+'</entry>').join('')
 return xmlResponse('<?xml version="1.0" encoding="UTF-8"?>'+
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'+
  '<id>'+xml(new URL(path,url).href)+'</id><title>opds-library</title><updated>'+new Date().toISOString()+'</updated><author><name>opds-library</name></author>'+
  link('self',href(result.page))+link('start',new URL(path,url).href)+link('first',href(1))+
  (result.page>1?link('previous',href(result.page-1)):'')+(result.page*result.limit<result.total?link('next',href(result.page+1)):'')+
  link('search',new URL('/opds/v1/search.xml',url).href,'application/opensearchdescription+xml')+
  link('alternate',new URL('/opds/v2/catalog.json',url).href,'application/opds+json')+
  '<opensearch:totalResults>'+result.total+'</opensearch:totalResults><opensearch:itemsPerPage>'+result.limit+'</opensearch:itemsPerPage><opensearch:startIndex>'+((result.page-1)*result.limit+1)+'</opensearch:startIndex>'+
  entries+'</feed>',ATOM_TYPE)
})
export const searchAtom=(url:URL)=>Effect.succeed(xmlResponse('<?xml version="1.0" encoding="UTF-8"?>'+
 '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>opds-library</ShortName><Description>Search your private ebook library</Description><InputEncoding>UTF-8</InputEncoding>'+
 '<Url type="'+xml(ATOM_TYPE)+'" template="'+xml(new URL('/opds/v1/catalog.xml',url).href+'?q={searchTerms}')+'" /></OpenSearchDescription>','application/opensearchdescription+xml'))
export const catalog=(url:URL)=>Effect.gen(function*(){
 const result=yield* list(url,true);const path='/opds/v2/catalog.json'
 const href=(page:number)=>catalogPage(url,path,page,result.limit)
 const link=(rel:string,href:string)=>({rel,href,type:'application/opds+json'})
 return {metadata:{title:'opds-library',numberOfItems:result.total,itemsPerPage:result.limit,currentPage:result.page},
 links:[link('self',href(result.page)),link('start',new URL(path,url).href),link('first',href(1)),
 ...(result.page>1?[link('previous',href(result.page-1))]:[]),...(result.page*result.limit<result.total?[link('next',href(result.page+1))]:[]),
 // Explicit query= is understood by KOReader's basic OPDS 2 URI-template handler.
 {rel:'search',href:new URL(path+'?query={searchTerms}',url).href.replace(/%7B/g,'{').replace(/%7D/g,'}'),type:'application/opds+json',templated:true},
 {rel:'alternate',href:new URL('/opds/v1/catalog.xml',url).href,type:ATOM_TYPE}],
 ...(result.books.length?{publications:result.books.map(b=>({metadata:{'@type':'http://schema.org/Book',identifier:'urn:sha256:'+b.id,title:b.title,...(b.authors?{author:b.authors.split(', ').map(name=>({name}))}:{}),modified:b.modified},...(b.cover_type?{images:[{href:new URL('/api/books/'+b.id+'/cover',url).href,type:b.cover_type}]}:{}),links:[{rel:'http://opds-spec.org/acquisition',href:new URL('/api/books/'+b.id+'/download',url).href,type:b.media_type}]}))}:{navigation:[{href:href(1),title:'All books',type:'application/opds+json'}]})}
})

export const cover=(id:string,headOnly=false)=>Effect.gen(function*(){
 const b=yield* get(id);if(!b.cover_type)return yield* Effect.fail(fail(404,'No cover'))
 const s=yield* Store;const object=yield* attempt(()=>headOnly?s.bucket.head(b.object_key+'.cover'):s.bucket.get(b.object_key+'.cover'))
 if(!object)return yield* Effect.fail(fail(404,'No cover'))
 return new Response(headOnly?null:(object as R2ObjectBody).body,{headers:{'content-type':b.cover_type,'content-length':String(object.size),'x-content-type-options':'nosniff','cache-control':'private, no-store'}})
})

export const upload=(r:Request)=>admin(r).pipe(Effect.andThen(uploadAuthorized(r)))
