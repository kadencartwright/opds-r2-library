import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Miniflare} from 'miniflare'
import {readFile,readdir} from 'node:fs/promises'
import {createHash,randomBytes} from 'node:crypto'
import {epub} from './fixtures'
import {safeFileURL,toolSchema} from '../src/server/mcp'
test('MCP attachment URL policy rejects arbitrary hosts and redirects at the boundary',()=>{
 for(const url of ['http://files.oaiusercontent.com/x','https://127.0.0.1/x','https://files.oaiusercontent.com.evil.com/x','https://user:pass@files.oaiusercontent.com/x','https://files.oaiusercontent.com:444/x'])assert.throws(()=>safeFileURL(url))
 assert.equal(safeFileURL('https://files.oaiusercontent.com/test'),'https://files.oaiusercontent.com/test')
 const schema=toolSchema['~standard'].jsonSchema.input({target:'draft-2020-12'})
 assert.ok(JSON.stringify(schema).includes('download_url'))
})
test('real D1/R2 MCP OAuth PKCE, consent, scopes and attachment archive',async()=>{
 const origin='http://127.0.0.1:8793',fixture=epub('Chat attachment')
 let mf:Miniflare
 mf=new Miniflare({modules:true,scriptPath:'dist-worker/worker.js',compatibilityDate:'2026-07-01',compatibilityFlags:['nodejs_compat'],port:8793,
 d1Databases:{DB:'mcp'},r2Buckets:{ARCHIVE:'mcp'},bindings:{LOCAL_DEV:'true',PRIVATE_LIBRARY:'true',AUTH_ORIGIN:origin,AUTH_SECRET:'test-mcp-secret-longer-than-thirty-two-characters',ADMIN_EMAILS:'admin@example.com'},
 outboundService:async(request:{url:string})=>{
  if(request.url.includes('/redirect'))return Response.redirect('https://127.0.0.1/private',302)
  if(new URL(request.url).hostname==='files.oaiusercontent.com')return new Response(fixture,{headers:{'content-type':'application/epub+zip'}})
  if(request.url.startsWith(origin))return mf.dispatchFetch(request.url)
  return new Response('External network disabled in tests',{status:403})
 }})
 const req=(path:string,init?:Parameters<Miniflare['dispatchFetch']>[1])=>mf.dispatchFetch(new URL(path,origin).href,init)
 const json=(v:unknown,cookie='')=>({headers:{'content-type':'application/json',origin,cookie,'cf-connecting-ip':'127.0.0.1'},body:JSON.stringify(v)})
 try{
 const db=await mf.getD1Database('DB')
 for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile('migrations/'+file,'utf8')).replace(/^--.*$/gm,'').split(';').filter(s=>s.trim()))await db.prepare(sql).run()
 await mf.ready
 const denied=await req('/mcp',{method:'POST',...json({jsonrpc:'2.0',id:1,method:'tools/list'})})
 assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate')||'',/resource_metadata/)
 const meta=await req('/.well-known/oauth-protected-resource').then(r=>r.json()) as Record<string,unknown>
 assert.equal(meta.resource,origin+'/mcp')
 const discovery=await req('/.well-known/oauth-authorization-server/api/auth')
 assert.equal(discovery.status,200,await discovery.clone().text())
 const oauth=await discovery.json() as Record<string,string>
 const register=await req('/api/auth/oauth2/register',{method:'POST',...json({client_name:'ChatGPT integration test',redirect_uris:['https://chatgpt.com/connector_platform/oauth_redirect'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'openid offline_access library:upload'})})
 assert.equal(register.status,201,await register.clone().text())
 const client=await register.json() as {client_id:string}
 const signin=await req('/api/auth/sign-in/magic-link',{method:'POST',...json({email:'admin@example.com',callbackURL:'/'})})
 assert.equal(signin.status,200,await signin.clone().text())
 const mail=await db.prepare('SELECT url FROM local_mail ORDER BY created DESC LIMIT 1').first<{url:string}>()
 const verified=await req(mail!.url,{redirect:'manual'});const cookie=verified.headers.get('set-cookie')!.split(';')[0]
 const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url')
 const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',scope:'openid offline_access library:upload',resource:origin+'/mcp',state:'test-state',code_challenge:challenge,code_challenge_method:'S256'})
 const authorize=await req('/api/auth/oauth2/authorize?'+query,{headers:{cookie,accept:'text/html'},redirect:'manual'})
 assert.ok([200,302,307].includes(authorize.status),await authorize.clone().text())
 const consentURL=authorize.headers.get('location')||(await authorize.json() as {url:string}).url
 assert.ok(consentURL.includes('/consent?'),consentURL)
 const consentQuery=new URL(consentURL,origin).searchParams
 const info=await req('/api/mcp/consent?'+consentQuery,{headers:{cookie}})
 assert.equal(info.status,200,await info.clone().text())
 const details=await info.json() as {oauth_query:string}
 const consent=await req('/api/mcp/consent',{method:'POST',...json({accept:true,oauth_query:details.oauth_query},cookie)})
 assert.equal(consent.status,200,await consent.clone().text())
 const approved=await consent.json() as Record<string,string>
 const redirect=approved.url||approved.redirect_uri
 assert.ok(redirect,JSON.stringify(approved))
 const code=new URL(redirect).searchParams.get('code')!
 const tokenRequest=(codeVerifier:string)=>req('/api/auth/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:codeVerifier,redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',resource:origin+'/mcp'}).toString()})
 const tokens=await tokenRequest(verifier)
 assert.equal(tokens.status,200,await tokens.clone().text())
 const token=await tokens.json() as {access_token:string}
 assert.ok(token.access_token)
 const rpc=(id:number,method:string,params:unknown)=>req('/mcp',{method:'POST',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})})
 const init=await rpc(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}})
 assert.equal(init.status,200,await init.clone().text())
 const tools=await rpc(2,'tools/list',{});assert.equal(tools.status,200,await tools.clone().text())
 const toolsText=await tools.text();assert.ok(toolsText.includes('openai/fileParams'));assert.ok(toolsText.includes('upload_book'))
 const upload=await rpc(3,'tools/call',{name:'upload_book',arguments:{file:{download_url:'https://files.oaiusercontent.com/legal.epub',file_id:'file-test',mime_type:'application/epub+zip',file_name:'chat.epub'}}})
 assert.equal(upload.status,200,await upload.clone().text())
 const result=await upload.text();assert.ok(result.includes('Chat attachment'),result)
 const id=createHash('sha256').update(fixture).digest('hex')
 const bucket=await mf.getR2Bucket('ARCHIVE')
 assert.deepEqual(Buffer.from(await (await bucket.get('originals/'+id))!.arrayBuffer()),Buffer.from(fixture))
 assert.equal((await req('/api/books')).status,401)
 const invalid=await rpc(4,'tools/call',{name:'upload_book',arguments:{file:{download_url:'https://127.0.0.1/private',file_id:'file-test',file_name:'bad.epub'}}})
 assert.ok((await invalid.text()).includes('Untrusted attachment URL'))
 assert.equal((await tokenRequest(verifier)).status,400)
 const redirectUpload=await rpc(5,'tools/call',{name:'upload_book',arguments:{file:{download_url:'https://files.oaiusercontent.com/redirect',file_id:'file-test',file_name:'bad.epub'}}})
 assert.ok((await redirectUpload.text()).includes('Attachment URL expired or could not be downloaded'))
 const noScopeQuery=new URLSearchParams(query);noScopeQuery.set('scope','openid');noScopeQuery.set('prompt','consent')
 const noScopeAuthorize=await req('/api/auth/oauth2/authorize?'+noScopeQuery,{headers:{cookie},redirect:'manual'})
 const noScopeURL=noScopeAuthorize.headers.get('location')||(await noScopeAuthorize.json() as {url:string}).url
 const noScopeInfo=await req('/api/mcp/consent?'+new URL(noScopeURL,origin).searchParams,{headers:{cookie}}).then(r=>r.json()) as {oauth_query:string}
 const noScopeConsent=await req('/api/mcp/consent',{method:'POST',...json({accept:true,oauth_query:noScopeInfo.oauth_query},cookie)})
 assert.equal(noScopeConsent.status,200,await noScopeConsent.clone().text())
 const noScopeRedirect=await noScopeConsent.json() as {url:string}
 const noScopeCode=new URL(noScopeRedirect.url).searchParams.get('code')!
 const noScopeTokens=await req('/api/auth/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:noScopeCode,code_verifier:verifier,redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',resource:origin+'/mcp'}).toString()})
 assert.equal(noScopeTokens.status,200,await noScopeTokens.clone().text())
 const noScopeToken=await noScopeTokens.json() as {access_token:string}
 const insufficient=await req('/mcp',{method:'POST',headers:{authorization:'Bearer '+noScopeToken.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:6,method:'tools/list'})})
 assert.equal(insufficient.status,403,await insufficient.clone().text())
 assert.match(insufficient.headers.get('www-authenticate')||'',/insufficient_scope/)
 await db.prepare("UPDATE web_user SET email='removed@example.com'").run()
 assert.equal((await rpc(7,'tools/list',{})).status,403)

 }finally{await mf.dispose()}
})
