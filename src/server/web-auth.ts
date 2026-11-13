import { mcp } from '@better-auth/mcp'
import { jwt } from 'better-auth/plugins/jwt'
import * as mcpSchema from './mcp-auth-schema'
import { drizzle } from 'drizzle-orm/d1'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import * as schema from './auth-schema'
import { betterAuth } from 'better-auth/minimal'
import { magicLink } from 'better-auth/plugins/magic-link'
import { Effect } from 'effect'
import { Bindings, Store, attempt, fail, type Env } from './core'
export const adminEmails=(env:Env)=>(env.ADMIN_EMAILS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
export const webAuth=(env:Env)=>{
 if(!env.AUTH_SECRET||env.AUTH_SECRET.length<32||!env.AUTH_ORIGIN)throw new Error('Production web auth is not configured')
 return betterAuth({
  database:drizzleAdapter(drizzle(env.DB),{provider:'sqlite',schema:{...schema,...mcpSchema}}),
  baseURL:env.AUTH_ORIGIN,
  secret:env.AUTH_SECRET,
  trustedOrigins:[env.AUTH_ORIGIN],
  disabledPaths:['/token'],
  user:{modelName:'web_user'},session:{modelName:'web_session',expiresIn:86400,updateAge:3600},
  account:{modelName:'web_account'},verification:{modelName:'web_verification'},
  rateLimit:{enabled:true,storage:'database',modelName:'web_rate_limit',window:60,max:30},
  advanced:{ipAddress:{ipAddressHeaders:['cf-connecting-ip']},useSecureCookies:new URL(env.AUTH_ORIGIN).protocol==='https:'},
  plugins:[jwt({disableSettingJwtHeader:true,jwks:{keyPairConfig:{alg:'ES256'}}}),mcp({loginPage:'/sign-in',consentPage:'/consent',resource:env.AUTH_ORIGIN+'/mcp',scopes:['openid','offline_access','library:upload'],accessTokenExpiresIn:300,refreshTokenExpiresIn:2592000,allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true}),magicLink({
   storeToken:'hashed',expiresIn:300,
   sendMagicLink:async({email,url})=>{
    // Never send login mail to an unapproved recipient; keep the generic response.
    if(!adminEmails(env).includes(email.toLowerCase()))return
    if(env.LOCAL_DEV==='true'){
     const id=crypto.randomUUID()
     await env.DB.prepare('INSERT INTO local_mail(id,recipient,url,created) VALUES (?,?,?,?)').bind(id,email,url,Date.now()).run()
    }else{
     if(!env.EMAIL||!env.EMAIL_FROM)throw new Error('Email delivery is not configured')
     await env.EMAIL.send({from:env.EMAIL_FROM,to:email,subject:'Sign in to opds-library',text:'Sign in to your library (expires in 5 minutes):\n'+url+'\nIf you did not request this, ignore this email.'})
    }
   }
  })],
 })
}
export const requireAdmin=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings
 // Even local cookie-authenticated writes require same-origin when Origin is present.
 if(r.method!=='GET'&&r.method!=='HEAD'){
  const origin=r.headers.get('origin')
  if(origin&&origin!==(env.AUTH_ORIGIN||new URL(r.url).origin))return yield* Effect.fail(fail(403,'Cross-origin administration is not allowed'))
 }
 if(env.LOCAL_DEV==='true'&&env.ALLOW_LOCAL_ADMIN==='true')return
 if(!env.AUTH_SECRET||!env.AUTH_ORIGIN)return yield* Effect.fail(fail(401,'Administrator sign-in required'))
 const session=yield* attempt(()=>webAuth(env).api.getSession({headers:r.headers}))
 if(!session?.user.emailVerified||!adminEmails(env).includes(session.user.email.toLowerCase()))return yield* Effect.fail(fail(401,'Administrator sign-in required'))
})
export const authHandler=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings
 if(!env.AUTH_SECRET||!env.AUTH_ORIGIN)return yield* Effect.fail(fail(503,'Web sign-in is not configured'))
 // Better Auth owns its cookie, CSRF/origin, token-consumption and session implementation.
 return yield* attempt(()=>webAuth(env).handler(r))
})
export const localMail=(r:Request)=>Effect.gen(function*(){
 const env=yield* Bindings
 if(env.LOCAL_DEV!=='true')return yield* Effect.fail(fail(404,'Not found'))
 const s=yield* Store
 return yield* s.all('SELECT id,recipient,url,created FROM local_mail ORDER BY created DESC LIMIT 10')
})
