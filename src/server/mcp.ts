import { Context, Effect, Schema } from 'effect'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { requireMcpAuth } from '@better-auth/mcp'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { Bindings, Store, attempt, body, fail, jsonBody, admin } from './core'
import { adminEmails, webAuth } from './web-auth'
import { uploadAuthorized } from './library'
const Input=Schema.Struct({file:Schema.Struct({
 download_url:Schema.String,file_id:Schema.String,mime_type:Schema.optional(Schema.String),file_name:Schema.optional(Schema.String),
})})
export const toolSchema=Input.pipe(Schema.toStandardSchemaV1,Schema.toStandardJSONSchemaV1)
export const safeFileURL=(value:string)=>{
 if(value.length>8192)throw Error('Attachment URL too long')
 const u=new URL(value)
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||
 !(u.hostname.endsWith('.oaiusercontent.com')||u.hostname==='files.openai.com'))throw Error('Only ChatGPT-provided HTTPS file URLs are accepted')
 return u.href
}
const archiveFile=(input:typeof Input.Type)=>Effect.gen(function*(){
 const url=yield* Effect.try({try:()=>safeFileURL(input.file.download_url),catch:()=>fail(400,'Untrusted attachment URL')})
 const response=yield* Effect.tryPromise({try:()=>fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)}),catch:()=>fail(400,'Attachment download failed or timed out; attach the file again')})
 if(!response.ok||!response.body)return yield* Effect.fail(fail(400,'Attachment URL expired or could not be downloaded'))
 const mime=input.file.mime_type||response.headers.get('content-type')?.split(';')[0]||''
 const filename=input.file.file_name||(mime==='application/epub+zip'?'attachment.epub':mime==='application/pdf'?'attachment.pdf':'')
 if(!filename)return yield* Effect.fail(fail(400,'The attached file needs an EPUB/PDF filename or media type'))
 const headers=new Headers({'x-filename':filename,'content-type':mime||(/\.pdf$/i.test(filename)?'application/pdf':'application/epub+zip')})
 if(response.headers.has('content-length'))headers.set('content-length',response.headers.get('content-length')!)
 // Uses exactly the same bounded validator, duplicate handling and R2/D1 pipeline as browser upload.
 return yield* uploadAuthorized(new Request('https://library.invalid/api/books',{method:'POST',headers,body:response.body}))
})
export const serve=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings,s=yield* Store,context=yield* Effect.context<Bindings|Store>()
 if(!env.AUTH_ORIGIN)return yield* Effect.fail(fail(503,'OAuth is not configured'))
 const auth=webAuth(env)
 const handler=requireMcpAuth(auth,async(request,claims)=>{
  if(typeof claims.sub!=='string')return Response.json({error:'Forbidden'},{status:403})
  const users=await Effect.runPromise(s.all<{email:string;emailVerified:number}>('SELECT email,emailVerified FROM web_user WHERE id=?',claims.sub).pipe(Effect.provideContext(context)))
  if(!users[0]?.emailVerified||!adminEmails(env).includes(users[0].email.toLowerCase()))return Response.json({error:'Forbidden'},{status:403})
  const protocol=createMcpHandler(()=>{
   const server=new McpServer({name:'opds-library',version:'1.0.0'})
   server.registerTool('upload_book',{
    title:'Upload an ebook to my private library',
    description:'Archive an attached EPUB or PDF in your private opds-library library. Only upload files the user asks to save. Maximum 16 MiB. Original bytes are preserved.',
    inputSchema:toolSchema,
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
    _meta:{'openai/fileParams':['file'],securitySchemes:[{type:'oauth2',scopes:['library:upload']}]},
   },async(input)=>{
    const result=await Effect.runPromise(archiveFile(input).pipe(Effect.provideContext(context),Effect.match({
     onSuccess:book=>({content:[{type:'text' as const,text:'Archived '+book.title}],structuredContent:{id:book.id,title:book.title,url:env.AUTH_ORIGIN+'/'} }),
     onFailure:error=>({isError:true,content:[{type:'text' as const,text:error.message}]}),
    })))
    return result
   })
   return server
  },{legacy:'stateless'})
  return protocol.fetch(request)
 },{resource:env.AUTH_ORIGIN+'/mcp',issuer:env.AUTH_ORIGIN+'/api/auth',requiredScopes:['library:upload']})
 const bytes=yield* body(r,65536)
 const request=new Request(r.url,{method:r.method,headers:r.headers,...(r.method==='POST'?{body:bytes}:{})})
 return yield* attempt(()=>handler(request))
})
export const discovery=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings
 return yield* attempt(()=>webAuth(env).handler(r))
})
const signedQuery=(url:URL)=>{const allowed=new Set(['sig','ba_param',...url.searchParams.getAll('ba_param')]);return new URLSearchParams([...url.searchParams].filter(([key])=>allowed.has(key))).toString()}
export const consentInfo=(r:Request)=>Effect.gen(function*(){
 yield* admin(r);const env=yield* Bindings,auth=webAuth(env),query=signedQuery(new URL(r.url))
 const valid=yield* attempt(async()=>verifyOAuthQueryParams(query,(await auth.$context).secret))
 if(!valid)return yield* Effect.fail(fail(400,'Invalid or expired OAuth request'))
 const params=new URLSearchParams(query)
 const client=yield* attempt(()=>auth.api.getOAuthClientPublic({query:{client_id:params.get('client_id')!},headers:r.headers}))
 return {client:client.client_name||'OAuth client',redirect:new URL(params.get('redirect_uri')!).host,scope:params.get('scope')||'',oauth_query:query}
})
export const consent=(r:Request)=>Effect.gen(function*(){
 yield* admin(r);const env=yield* Bindings
 const v=yield* Schema.decodeUnknownEffect(Schema.Struct({accept:Schema.Boolean,oauth_query:Schema.String}))(yield* jsonBody(r)).pipe(Effect.mapError(()=>fail(400,'Invalid consent')))
 const headers=new Headers(r.headers);headers.set('accept','application/json');headers.set('content-type','application/json');headers.delete('content-length')
 return yield* attempt(()=>webAuth(env).handler(new Request(env.AUTH_ORIGIN+'/api/auth/oauth2/consent',{method:'POST',headers,body:JSON.stringify(v)})).then(async response=>{
 if(response.status>=300&&response.status<400)return Response.json({url:response.headers.get('location')},{headers:{'cache-control':'no-store'}})
 return response
 }))
})
