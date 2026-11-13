import { requireAdmin } from './web-auth'
import { Context, Data, Effect, Layer, Schema } from 'effect'
export class Failure extends Data.TaggedError('Failure')<{ status: number; message: string; code?: number }> {}
export const fail = (status: number, message: string, code?: number) => new Failure({status,message,code})
export const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({try:f,catch:()=>fail(503,'Storage unavailable; retry the operation')})
export interface Env { DB: D1Database; ARCHIVE: R2Bucket; ASSETS: Fetcher; LOCAL_DEV?: string; ALLOW_LOCAL_ADMIN?:string; PRIVATE_LIBRARY?:string; ENABLE_REGISTRATION?: string; AUTH_SECRET?:string; AUTH_ORIGIN?:string; ADMIN_EMAILS?:string; EMAIL_FROM?:string; EMAIL?:{send:(message:{from:string;to:string;subject:string;text:string})=>Promise<unknown>} }
export class Bindings extends Context.Service<Bindings, Env>()('Bindings') {}
export class Store extends Context.Service<Store, {
  all: <A>(sql:string,...args:unknown[])=>Effect.Effect<A[],Failure>;
  run: (sql:string,...args:unknown[])=>Effect.Effect<D1Result,Failure>;
  batch: (statements: ReadonlyArray<readonly [string, ...unknown[]]>)=>Effect.Effect<D1Result[],Failure>;
  bucket: R2Bucket
}>()('Store') {}
export const StoreLive = Layer.effect(Store, Effect.gen(function*(){
 const env = yield* Bindings
 return { all:<A>(sql:string,...args:unknown[])=>attempt(()=>env.DB.prepare(sql).bind(...args).all<A>()).pipe(Effect.map(r=>r.results)),
 batch:(statements:ReadonlyArray<readonly [string,...unknown[]]>)=>attempt(()=>env.DB.batch(statements.map(([sql,...args])=>env.DB.prepare(sql).bind(...args)))),
 run:(sql:string,...args:unknown[])=>attempt(()=>env.DB.prepare(sql).bind(...args).run()), bucket:env.ARCHIVE }
}))
export const Book = Schema.Struct({id:Schema.String,object_key:Schema.String,title:Schema.String,authors:Schema.String,filename:Schema.String,media_type:Schema.String,size:Schema.Number,modified:Schema.String,state:Schema.String,cover_type:Schema.NullOr(Schema.String)})
export type Book = typeof Book.Type
export const Edit = Schema.Struct({ title:Schema.String, authors:Schema.String })
export const decode = <S extends Schema.Top & {DecodingServices:never}>(schema:S, value:unknown) =>
 Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(()=>fail(400,'Invalid fields')))
export const body = (request: Request, limit:number) => Effect.tryPromise({
 try:async()=>{
  if(Number(request.headers.get('content-length'))>limit) throw fail(413,'Body too large')
  const reader=request.body?.getReader(); if(!reader) return new Uint8Array()
  const chunks:Uint8Array[]=[];let size=0
  try { while(true){ const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit){await reader.cancel();throw fail(413,'Body too large')} chunks.push(r.value) } }
  finally { reader.releaseLock() }
  const out=new Uint8Array(size);let pos=0;for(const c of chunks){out.set(c,pos);pos+=c.length}return out
 },catch:e=>e instanceof Failure?e:fail(400,'Cannot read request')
})
export const jsonBody=(r:Request)=>body(r,65536).pipe(Effect.flatMap(b=>Effect.try({try:()=>JSON.parse(new TextDecoder().decode(b)) as unknown,catch:()=>fail(400,'Invalid JSON')})))
export const sha256=(bytes: Uint8Array)=>attempt(()=>crypto.subtle.digest('SHA-256',bytes as BufferSource)).pipe(Effect.map(b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('')))
export const admin=requireAdmin
