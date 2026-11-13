import { localState } from 'alchemy/State/LocalState'
import * as Alchemy from 'alchemy'
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Effect, Layer, Config } from 'effect'

// Production definition. Review a plan with --profile folio-library-prod before deployment.
export default Alchemy.Stack('Folio', {
 providers: Layer.merge(Cloudflare.providers(),Alchemy.RandomProvider()),
 state: localState(),
}, Effect.gen(function*(){
 const zoneId=yield* Config.String('OPDS_EMAIL_ZONE_ID')
 const origin=yield* Config.String('OPDS_AUTH_ORIGIN')
 const adminEmail=yield* Config.String('OPDS_ADMIN_EMAIL')
 const emailFrom=yield* Config.String('OPDS_EMAIL_FROM')
 if(new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin)throw Error('OPDS_AUTH_ORIGIN must be an HTTPS origin without a trailing slash or path')
 const sendingDomain=emailFrom.split('@')[1]
 if(!sendingDomain||!adminEmail.includes('@'))throw Error('Configure valid OPDS_EMAIL_FROM and OPDS_ADMIN_EMAIL addresses')
 const bucket=yield* Cloudflare.R2.Bucket('FolioOriginals',{name:'folio-originals'})
 const db=yield* Cloudflare.D1.Database('FolioCatalog',{name:'folio-catalog',migrations:'./migrations'})
 const secret=yield* Alchemy.makeRandom('WebAuthSecret')
 const mail=yield* Cloudflare.Email.SendEmail('EMAIL',{
  allowedSenderAddresses:[emailFrom],
  allowedDestinationAddresses:[adminEmail],
 })
 // Provision only the dedicated sending subdomain; root MX records are unchanged.
 yield* Cloudflare.Email.SendingSubdomain('AuthEmailDomain',{zoneId,name:sendingDomain,previewEnabled:false})
 yield* Cloudflare.Email.Address('AdminEmailDestination',{email:adminEmail})
 const worker=yield* Cloudflare.Worker('FolioLibrary',{
  name:'folio-library',
  domain:new URL(origin).hostname,
  main:'./src/server/worker.ts',
  compatibility:{date:'2026-07-01',flags:['nodejs_compat']},
  env:{ARCHIVE:bucket,DB:db,LOCAL_DEV:'false',PRIVATE_LIBRARY:'true',ENABLE_REGISTRATION:'false',EMAIL:mail,EMAIL_FROM:emailFrom,ADMIN_EMAILS:adminEmail,AUTH_SECRET:secret,AUTH_ORIGIN:origin},
  assets:{directory:'./dist',config:{notFoundHandling:'single-page-application',runWorkerFirst:['/api/*','/opds','/opds/*','/mcp','/.well-known/*','/users/*','/syncs/*','/healthcheck']}},
 })
 return {url:worker.url}
}))
