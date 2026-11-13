-- Runs unmodified KOReader feed HTTP/parser/menu/sync code. Only UI/device services
-- are stubbed; LuaSocket, Basic auth, JSON, luxl and OPDSParser are real.
local root, version, origin, download_dir = arg[1], arg[2], arg[3], arg[4]
package.path = root .. '/' .. version .. '/?.lua;' .. root .. '/master/?.lua;' .. root .. '/?.lua;' .. package.path
local http = require('socket.http')
local url = require('socket.url')
local json = require('cjson')
package.preload['json'] = function() return json end
local function obj() return {new=function(self, x) return x or {} end} end
local Menu = {extend=function(self,x) return x end}
package.preload['ui/widget/menu'] = function() return Menu end
local Cache = {new=function() return {check=function() end,insert=function() end} end}
package.preload['cache'] = function() return Cache end
local shows={}
package.preload['ui/uimanager'] = function() return {show=function(_,x) table.insert(shows,x) end} end
local util={
 tableGetValue=function(t,...) for _, k in ipairs({...}) do if type(t)~='table' then return end;t=t[k] end;return t end,
 getFileNameSuffix=function(s) return s:match('%.([^./]+)$') or '' end,
 stringEndsWith=function(s,suffix) return s:sub(-#suffix)==suffix end,
 urlDecode=function(s) return (s:gsub('%%(%x%x)',function(h) return string.char(tonumber(h,16)) end)) end,
 removeFile=os.remove,
 unicodeCodepointToUtf8=function(n) if n<128 then return string.char(n) elseif n<2048 then return string.char(192+math.floor(n/64),128+n%64) else return string.char(224+math.floor(n/4096),128+math.floor(n/64)%64,128+n%64) end end,
}
package.preload['util']=function() return util end
package.preload['document/documentregistry']=function() return {hasProvider=function(_,name,kind) return (name and name:match('%.epub$')) or (name and name:match('%.pdf$')) or kind=='application/epub+zip' or kind=='application/pdf' end} end
package.preload['socketutil']=function() return {set_timeout=function() end,reset_timeout=function() end,redact_request=function(x) return x end,redact_headers=function(x) return x end,describe_error=function() end} end
package.preload['cookiejar']=function() return {new=function() return {headerFor=function() end,store=function() end} end} end
package.preload['ui/network/manager']=function() return {runWhenConnected=function(_,fn) fn() end} end
package.preload['ffi/util']=function() return {template=function(s,...) return s end} end
package.preload['gettext']=function() return setmetatable({ngettext=function(s) return s end},{__call=function(_,s) return s end}) end
for _, name in ipairs({'ui/bidi','ui/widget/buttondialog','ui/widget/checkbutton','ui/widget/confirmbox','device','ui/widget/infomessage','ui/widget/inputdialog','ui/widget/multiinputdialog','opdsdownloadlist','opdspse','ui/widget/spinwidget','ui/widget/textboxwidget','ui/widget/textviewer','ui/trapper','logger','apps/filemanager/filemanagerutil','libs/libkoreader-lfs','ui/widget/notification'}) do
 package.preload[name]=function() return setmetatable(obj(),{__index=function() return function() end end}) end
end
local B=assert(loadfile(root..'/'..version..'/opdsbrowser.lua'))()
B.settings={no_loading_notification=true};B.root_catalog_username='reader';B.root_catalog_password='reader-password-for-test'
local raw_request=http.request
local requests={}
http.request=function(req)
 assert(req.headers['Accept-Encoding']=='identity','KOReader should request uncompressed responses')
 table.insert(requests,{method=req.method or 'GET',url=req.url,has_credentials=(req.user=='reader' and req.password==B.root_catalog_password)})
 return raw_request(req)
end
-- Verify that the HTML website root is not a valid catalog.
-- The parser sees no Atom entries or OPDS navigation; updateCatalog never opens.
B.paths={};B.downloads={};B.page_num=2;local root_opened=false
B.switchItemTable=function() root_opened=true end
B.setTitleBarLeftIcon=function() end
B:onMenuSelect({idx=2,text='opds-library',url=origin,username='reader',password=B.root_catalog_password})
assert(not root_opened and #B.paths==0,'website root reproduces silent catalog tap')
print(version..': website root HTML reproduces silent tap (no menu, no error dialog)')
local expected_title='A <Tiny> & "Journey"'
for _, path in ipairs({'/opds/v2/catalog.json','/opds/v1/catalog.xml','/opds','/opds/'}) do
 local endpoint=origin..path..'?limit=1'
 local catalog=B:parseFeed(endpoint)
 assert(catalog,'feed parsed')
 local items=B:genItemTableFromURL(endpoint)
 assert(#items==1 and items[1].title==expected_title,'book title survived actual parser')
 assert(items[1].author:find('Legal & Author',1,true),'author parsed')
 local link=items[1].acquisitions[1]
 assert(link and link.type=='application/epub+zip' and link.href:sub(1,#origin)==origin,'original acquisition parsed')
 assert(items.hrefs.next,'pagination parsed')
 assert(#B:genItemTableFromURL(items.hrefs.next)==1,'second page parsed')
 assert(B.search_url,'search discovered')
 local search=B.search_url:gsub('%%s','Journey')
 assert(#B:genItemTableFromURL(search)==1,'reader-generated search works')
 assert(B:getServerFileName(link.href,'EPUB')=='tiny.epub','HEAD gives original filename')
 local file=download_dir..'/'..version..'-'..path:gsub('/','_')..'.epub'
 assert(B:downloadFile(file,link.href,'reader',B.root_catalog_password),'Basic-auth original download')
 local stream=assert(io.open(file,'rb'));assert(stream:read(2)=='PK');stream:close()
 -- Exercise actual OnMenuSelect + updateCatalog, stubbing only the visual menu switch.
 B.paths={};B.downloads={};B.item_table={};B.page_num=2;local opened=false
 B.switchItemTable=function(_,_,table_) opened=#table_>0 end
 B.setTitleBarLeftIcon=function() end
 B:onMenuSelect({idx=2,text='opds-library',url=endpoint,username='reader',password=B.root_catalog_password})
 assert(opened and #B.paths==1,'catalog tap opens a menu')
 B.sync_server={url=endpoint};B.sync_max_dl=10;B.sync_force=true
 local pending=B:getSyncDownloadList()
 assert(#pending==2,'actual KOReader sync discovers both pages')
 print(version..' '..path..': parse, title/author, pagination, search, HEAD filename, authenticated download, tap and sync PASS')
end
for _, request in ipairs(requests) do assert(request.has_credentials,'HEAD and GET carry Basic credentials') end
assert(#shows==0,'no HTTP error dialog should be shown')
print(version..': '..#requests..' real LuaSocket HTTP requests with credentials and identity encoding PASS')
