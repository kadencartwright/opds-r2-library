import { Effect } from 'effect'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { fail } from './core'
export const MAX_UPLOAD=16*1024*1024
const text=(b:Uint8Array)=>new TextDecoder().decode(b)
export const extract=(bytes:Uint8Array,filename:string,mime:string)=>Effect.try({
 try:()=>{
 const fallback={title:filename.replace(/\.[^.]+$/,''),authors:''}
 if(/\.pdf$/i.test(filename)){
  if(mime!=='application/pdf' && mime!=='application/octet-stream')throw Error('PDF media type required')
  if(!text(bytes.subarray(0,8)).startsWith('%PDF-') || !text(bytes.subarray(-2048)).includes('%%EOF'))throw Error('Invalid PDF signature')
  return {...fallback,media_type:'application/pdf'}
 }
 if(!/\.epub$/i.test(filename)|| !['application/epub+zip','application/octet-stream'].includes(mime))throw Error('Use an EPUB or PDF')
 let total=0,entries=0
 const files=unzipSync(bytes,{filter:f=>{
  if(++entries>2048 || (total+=f.originalSize)>64*1024*1024)throw Error('Archive expansion limit')
  const wanted=f.name==='mimetype'||f.name==='META-INF/container.xml'||f.name.endsWith('.opf')
  if(wanted && f.originalSize>512*1024)throw Error('Metadata exceeds limit')
  return wanted
 }})
 if(!files.mimetype||text(files.mimetype)!=='application/epub+zip')throw Error('Invalid EPUB mimetype')
 const xml=(b:Uint8Array)=>{
  const s=text(b);if(/<!DOCTYPE|<!ENTITY/i.test(s))throw Error('Unsafe XML')
  return new XMLParser({ignoreAttributes:false,removeNSPrefix:true,processEntities:false}).parse(s)
 }
 const path=xml(files['META-INF/container.xml']).container.rootfiles.rootfile['@_full-path']
 if(typeof path!=='string'||!files[path])throw Error('Missing EPUB package')
 const md=xml(files[path]).package.metadata
 const val=(x:unknown):string=>typeof x==='string'?x:typeof x==='object'&&x!==null?val((x as Record<string,unknown>)['#text']):''
 const title=val(Array.isArray(md.title)?md.title[0]:md.title).trim().slice(0,300)
 const authors=(Array.isArray(md.creator)?md.creator:[md.creator]).map(val).filter(Boolean).join(', ').slice(0,1000)
 let cover:Uint8Array|undefined,cover_type:string|undefined
 const pkg=xml(files[path]).package
 const items=Array.isArray(pkg.manifest?.item)?pkg.manifest.item:[pkg.manifest?.item]
 const metas=Array.isArray(md.meta)?md.meta:[md.meta]
 const coverId=metas.find((m:Record<string,unknown>)=>m?.['@_name']==='cover')?.['@_content']
 const item=items.find((i:Record<string,unknown>)=>i && (String(i['@_properties']||'').split(' ').includes('cover-image')||i['@_id']===coverId))
 if(item && ['image/png','image/jpeg'].includes(item['@_media-type']) && typeof item['@_href']==='string'){
  const base=new URL(path,'https://epub.invalid/')
  const target=new URL(item['@_href'],base)
  if(target.origin===base.origin&&!target.search&&!target.hash){
   const name=decodeURIComponent(target.pathname.slice(1))
   const image=unzipSync(bytes,{filter:f=>f.name===name && f.originalSize<=2*1024*1024})[name]
   if(image && ((item['@_media-type']==='image/png' && image[0]===137&&text(image.subarray(1,4))==='PNG')||(item['@_media-type']==='image/jpeg'&&image[0]===255&&image[1]===216&&image[2]===255))){cover=image;cover_type=item['@_media-type']}
  }
 }
 return {title:title||fallback.title,authors,media_type:'application/epub+zip',cover,cover_type}
 },catch:e=>fail(400,e instanceof Error?e.message:'Invalid book')
})
