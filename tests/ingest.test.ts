import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Effect } from 'effect'
import { zipSync, strToU8 } from 'fflate'
import { extract } from '../src/server/ingest'
import { epub,pdf } from './fixtures'
test('EPUB extracts package title and authors',async()=>{const m=await Effect.runPromise(extract(epub(),'tiny.epub','application/epub+zip'));assert.equal(m.title,'A Tiny Journey');assert.equal(m.authors,'Folio Test Author')})
test('PDF uses filename fallback',async()=>assert.equal((await Effect.runPromise(extract(pdf(),'Legal.pdf','application/pdf'))).title,'Legal'))
test('content and XML validation reject malformed books',async()=>{
 for(const [b,n,m] of [[pdf(),'fake.epub','application/epub+zip'],[epub(),'fake.pdf','application/pdf'],[zipSync({'mimetype':strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<!DOCTYPE x><container/>')}),'bad.epub','application/epub+zip']] as const)
 await assert.rejects(Effect.runPromise(extract(b,n,m)))
})
test('archive metadata expansion is bounded',async()=>{const b=zipSync({mimetype:strToU8('application/epub+zip'),'large.opf':new Uint8Array(600000)});await assert.rejects(Effect.runPromise(extract(b,'bomb.epub','application/epub+zip')))})
