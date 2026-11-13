// Run only when intentionally upgrading the Better Auth MCP/JWT schema.
import {mcp} from '@better-auth/mcp'
import {jwt} from 'better-auth/plugins/jwt'
import {writeFileSync} from 'node:fs'
const tables={...mcp({loginPage:'/',consentPage:'/',resource:'https://library.example.com/mcp'}).schema,...jwt().schema}
let sql='-- Generated from Better Auth MCP/JWT 1.7.18; reviewed, versioned migration.\n'
let ts="import {sqliteTable,text,integer} from 'drizzle-orm/sqlite-core'\n"
for(const [name,table] of Object.entries(tables)){
 const cols=['"id" TEXT PRIMARY KEY'],props=["id:text('id').primaryKey()"]
 for(const [key,f] of Object.entries(table.fields)){
  const numeric=['date','boolean','number'].includes(f.type)
  let col='"'+key+'" '+(numeric?'INTEGER':'TEXT')
  let prop=key+':'+(f.type==='date'?"integer('"+key+"',{mode:'timestamp_ms'})":f.type==='boolean'?"integer('"+key+"',{mode:'boolean'})":(numeric?'integer':'text')+"('"+key+"')")
  if(f.required!==false){col+=' NOT NULL';prop+='.notNull()'}
  if(f.unique){col+=' UNIQUE';prop+='.unique()'}
  if(f.references){const ref={user:'web_user',session:'web_session'}[f.references.model]||f.references.model;col+=' REFERENCES "'+ref+'"("'+f.references.field+'") ON DELETE '+(f.references.onDelete||'cascade').toUpperCase()}
  cols.push(col);props.push(prop)
 }
 sql+='CREATE TABLE "'+name+'" ('+cols.join(',')+');\n'
 for(const [key,f] of Object.entries(table.fields))if(f.index)sql+='CREATE INDEX "'+name+'_'+key+'" ON "'+name+'"("'+key+'");\n'
 for(const [i,index]of(table.indexes||[]).entries())sql+='CREATE '+(index.unique?'UNIQUE ':'')+'INDEX "'+name+'_idx'+i+'" ON "'+name+'"('+index.fields.map(k=>'"'+k+'"').join(',')+');\n'
 ts+='export const '+name+"=sqliteTable('"+name+"',{"+props.join(',')+'})\n'
}
writeFileSync('migrations/0006_mcp_auth.sql',sql)
writeFileSync('src/server/mcp-auth-schema.ts',ts)
