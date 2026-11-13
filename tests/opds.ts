import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'
import { readdirSync, readFileSync,statSync } from 'node:fs'
const ajv=new Ajv({strict:false,allErrors:true})
addFormats(ajv)
const add=(dir:string)=>{for(const name of readdirSync(dir)){const path=dir+'/'+name;if(statSync(path).isDirectory())add(path);else if(name.endsWith('.json'))ajv.addSchema(JSON.parse(readFileSync(path,'utf8')))}}
add('tests/vendor/readium');add('tests/vendor/opds')
export const validateOPDS=ajv.getSchema('https://specs.opds.io/schema/feed.schema.json')!
