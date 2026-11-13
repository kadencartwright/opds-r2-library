import { Context, Effect, Layer } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse as R } from 'effect/http'
import { Bindings, StoreLive, admin, type Env } from './core'
import * as Library from './library'
import * as MCP from './mcp'
import * as WebAuth from './web-auth'
import * as Sync from './sync'
import * as CrossPoint from './crosspoint'
const request=HttpServerRequest.HttpServerRequest.pipe(Effect.map(r=>r.source as Request))
const json=(value:unknown,status=200,type='application/json')=>R.jsonUnsafe(value,{status,headers:{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'}})
const handle=<A>(fn:(r:Request)=>Effect.Effect<A,import('./core').Failure,Bindings|import('./core').Store>,status=200,type='application/json')=>
 Effect.gen(function*(){const r=yield* request;const value=yield* fn(r).pipe(Effect.provide(StoreLive));const response=value instanceof Response?R.fromWeb(value):json(value,status,type);return r.method==='HEAD'?R.empty({status:response.status,headers:response.headers}):response}).pipe(
 Effect.catchTag('Failure',e=>Effect.succeed(R.setHeader(json({message:e.message,...(e.code?{code:e.code}:{})},e.status),'www-authenticate',e.status===401?'Basic realm="Folio Library", charset="UTF-8"':''))))
const read=<A>(f:(r:Request)=>Effect.Effect<A,import('./core').Failure,Bindings|import('./core').Store>)=>(r:Request)=>Sync.reader(r).pipe(Effect.andThen(f(r)))
const id=(r:Request)=>new URL(r.url).pathname.split('/')[3]
const routes=Layer.mergeAll(
 HttpRouter.add('*','/mcp',handle(MCP.serve)),
 HttpRouter.add('GET','/.well-known/*',handle(MCP.discovery)),
 HttpRouter.add('GET','/api/mcp/consent',handle(MCP.consentInfo)),
 HttpRouter.add('POST','/api/mcp/consent',handle(MCP.consent)),
 HttpRouter.add('*','/api/auth/*',handle(WebAuth.authHandler)),
 HttpRouter.add('GET','/api/local/mail',handle(WebAuth.localMail)),
 HttpRouter.add('GET','/api/session',handle(r=>admin(r).pipe(Effect.as({authenticated:true}),Effect.catchTag('Failure',e=>e.status===401?Effect.succeed({authenticated:false}):Effect.fail(e))))),
 HttpRouter.add('POST','/api/admin/accounts',handle(Sync.createAccount,201)),
 HttpRouter.add('GET','/api/admin/accounts',handle(Sync.listAccounts)),
 HttpRouter.add('PATCH','/api/admin/accounts/:username',handle(r=>Sync.updatePassword(r,decodeURIComponent(new URL(r.url).pathname.split('/')[4])))),
 HttpRouter.add('DELETE','/api/admin/accounts/:username',handle(r=>Sync.deleteAccount(r,decodeURIComponent(new URL(r.url).pathname.split('/')[4])))),

 HttpRouter.add('GET','/api/books',handle(read(r=>Library.list(new URL(r.url))))),
 HttpRouter.add('GET','/api/books/:id',handle(read(r=>Library.get(id(r))))),
 HttpRouter.add('GET','/api/books/:id/cover',handle(read(r=>Library.cover(id(r),r.method==='HEAD')))),
 HttpRouter.add('GET','/api/books/:id/download',handle(read(r=>Library.download(id(r),r.method==='HEAD')))),
 HttpRouter.add('GET','/opds/v2/catalog.json',handle(read(r=>Library.catalog(new URL(r.url))),200,'application/opds+json')),
 HttpRouter.add('GET','/opds/v1/catalog.xml',handle(read(r=>Library.catalogAtom(new URL(r.url))))),
 HttpRouter.add('GET','/opds/v1/search.xml',handle(read(r=>Library.searchAtom(new URL(r.url))))),
 // Conventional entry points serve Atom directly: no redirect can drop reader credentials.
 HttpRouter.add('GET','/opds',handle(read(r=>Library.catalogAtom(new URL(r.url))))),

 HttpRouter.add('POST','/api/books',handle(Library.upload,201)),
 HttpRouter.add('PATCH','/api/books/:id',handle(r=>Library.edit(r,id(r)))),
 HttpRouter.add('DELETE','/api/books/:id',handle(r=>Library.remove(r,id(r)))),
 HttpRouter.add('GET','/healthz',R.jsonUnsafe({status:'ok',version:'0.1.0'})),
 HttpRouter.add('GET','/healthcheck',R.jsonUnsafe({state:'OK'})),
 HttpRouter.add('POST','/users/create',handle(Sync.register,201)),
 HttpRouter.add('GET','/users/auth',handle(Sync.authenticate)),
 HttpRouter.add('PUT','/syncs/progress',handle(r=>CrossPoint.push(r))),
 HttpRouter.add('GET','/syncs/progress/:document',handle(r=>CrossPoint.pull(r,decodeURIComponent(new URL(r.url).pathname.split('/')[3])))),
 HttpRouter.add('PUT','/api/v1/progress',handle(r=>CrossPoint.push(r,true))),
 HttpRouter.add('GET','/api/v1/progress',handle(CrossPoint.listProgress)),
 HttpRouter.add('GET','/api/v1/progress/changes',json({code:2003,message:'Progress change feed not implemented'},404)),
 HttpRouter.add('GET','/api/v1/progress/:document',handle(r=>CrossPoint.pull(r,decodeURIComponent(new URL(r.url).pathname.split('/')[4]),true))),
 HttpRouter.add('PUT','/api/v1/documents',handle(CrossPoint.putDocuments)),
 HttpRouter.add('GET','/api/v1/documents',handle(CrossPoint.getDocuments)),
 ...(['bookmarks','clippings'] as const).flatMap(kind=>[
 HttpRouter.add('PUT',`/api/v1/${kind}/:document`,handle(r=>CrossPoint.putAnnotations(r,decodeURIComponent(new URL(r.url).pathname.split('/')[4]),kind))),
 HttpRouter.add('GET',`/api/v1/${kind}/:document`,handle(r=>CrossPoint.getAnnotations(r,decodeURIComponent(new URL(r.url).pathname.split('/')[4]),kind))),
 ]),
 HttpRouter.add('GET','/api/admin/sync',handle(Sync.diagnostics)),
 HttpRouter.add('PUT','/api/admin/mapping',handle(Sync.mapDocument)),
 // A wildcard-method catch-all captures HEAD before Effect can fall back to GET.
 ...(['GET','POST','PUT','PATCH','DELETE','OPTIONS','QUERY'] as const).map(method=>HttpRouter.add(method,'/*',json({code:2003,message:'Not found'},404)))
)
const app=HttpRouter.toWebHandler(routes,{disableLogger:true})
export default { fetch:(r:Request,env:Env)=>app.handler(r,Context.make(Bindings,env)) }
