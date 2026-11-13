import { Effect, Schema } from 'effect'
import { Runtime, Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import './style.css'

const Book=Schema.Struct({id:Schema.String,title:Schema.String,authors:Schema.String,filename:Schema.String,media_type:Schema.String,size:Schema.Number,modified:Schema.String,cover_type:Schema.NullOr(Schema.String)})
type Book=typeof Book.Type
const ReaderAccount=Schema.Struct({username:Schema.String,created:Schema.Number})
export const Model=Schema.Struct({accounts:Schema.Array(ReaderAccount),accountTotal:Schema.Number,accountPage:Schema.Number,accountEditing:Schema.String,accountPassword:Schema.String,accountDelete:Schema.String,oauthQuery:Schema.String,oauthMode:Schema.String,consentText:Schema.String,authenticated:Schema.Boolean,books:Schema.Array(Book),total:Schema.Number,page:Schema.Number,q:Schema.String,busy:Schema.Boolean,notice:Schema.String,error:Schema.Boolean,email:Schema.String,deviceUsername:Schema.String,devicePassword:Schema.String,selected:Schema.NullOr(Book),title:Schema.String,authors:Schema.String,diagnostics:Schema.String,confirmation:Schema.String,mapping:Schema.String})
type Model=typeof Model.Type
const Message=defineMessageUnion({
 AccountsLoad:{page:Schema.Number},AccountsLoaded:{accounts:Schema.Array(ReaderAccount),total:Schema.Number,page:Schema.Number},EditAccount:{username:Schema.String},AccountPassword:{value:Schema.String},SaveAccountPassword:{},CancelAccount:{},AskAccountDelete:{username:Schema.String},CancelAccountDelete:{},DeleteAccount:{},
 Query:{value:Schema.String},Email:{value:Schema.String},DeviceUsername:{value:Schema.String},DevicePassword:{value:Schema.String},SignIn:{},SignOut:{},CreateAccount:{},Title:{value:Schema.String},Authors:{value:Schema.String},Mapping:{value:Schema.String},
 Load:{page:Schema.Number},Loaded:{books:Schema.Array(Book),total:Schema.Number,page:Schema.Number},
 Upload:{files:Schema.Array(Schema.instanceOf(File))},Done:{notice:Schema.String},Failed:{notice:Schema.String},
 Select:{book:Book},Close:{},Save:{},AskDelete:{id:Schema.String},Cancel:{},Delete:{},
 Session:{authenticated:Schema.Boolean},ConsentInfo:{text:Schema.String,query:Schema.String},Consent:{accept:Schema.Boolean},Diagnostics:{},Diagnosed:{text:Schema.String},Map:{}
})
type Message=typeof Message.Type
const call=async(path:string,init?:RequestInit)=>{
 const response=await fetch(path,init);const data=await response.json() as Record<string,unknown>
 if(!response.ok)throw Error(String(data.message||'Request failed'))
 return data
}
const command=(name:string,run:()=>Promise<Message>)=>({name,effect:Effect.tryPromise({try:run,catch:e=>e}).pipe(Effect.catch(e=>Effect.succeed(Message.Failed({notice:e instanceof Error?e.message:'Request failed'}))))})
const load=(q:string,page:number)=>command('LoadLibrary',async()=>{const r=await call('/api/books?limit=12&page='+page+'&q='+encodeURIComponent(q));return Message.Loaded(Schema.decodeUnknownSync(Schema.Struct({books:Schema.Array(Book),total:Schema.Number,page:Schema.Number}))(r))})
const accounts=(page=1)=>command('ListReaderAccounts',async()=>{const data=await call('/api/admin/accounts?page='+page);return Message.AccountsLoaded(Schema.decodeUnknownSync(Schema.Struct({accounts:Schema.Array(ReaderAccount),total:Schema.Number,page:Schema.Number}))(data))})
const session=()=>command('CheckAdminSession',async()=>Message.Session({authenticated:(await call('/api/session')).authenticated===true}))
const oauthLocation=()=>{const u=new URL(location.href);const allowed=new Set(['sig','ba_param',...u.searchParams.getAll('ba_param')]);return {mode:u.pathname==='/consent'?'consent':u.pathname==='/sign-in'?'login':u.searchParams.get('mcp')||'',query:new URLSearchParams([...u.searchParams].filter(([key])=>allowed.has(key))).toString()}}
const consentInfo=(query:string)=>command('InspectOAuthConsent',async()=>{const r=await call('/api/mcp/consent?'+query);return Message.ConsentInfo({text:String(r.client)+' requests '+String(r.scope)+'; callback: '+String(r.redirect),query:String(r.oauth_query)})})
const headers=(_m:Model)=>({'content-type':'application/json'})
export const init:Runtime.ApplicationInit<Model,Message>=()=>({model:{accounts:[],accountTotal:0,accountPage:1,accountEditing:'',accountPassword:'',accountDelete:'',oauthQuery:oauthLocation().query,oauthMode:oauthLocation().mode,consentText:'',authenticated:false,books:[],total:0,page:1,q:'',busy:true,notice:'',error:false,email:'',deviceUsername:'',devicePassword:'',selected:null,title:'',authors:'',diagnostics:'',confirmation:'',mapping:''},commands:[session()]})
export const update=(m:Model,msg:Message):Update.Return<Model,Message>=>{
 switch(msg._tag){
 case 'Session':{
 if(msg.authenticated&&m.oauthMode==='resume'&&m.oauthQuery)return {model:{...m,authenticated:true,busy:true},commands:[command('ResumeOAuth',async()=>{location.assign('/api/auth/oauth2/authorize?'+m.oauthQuery);return Message.Done({notice:'Continuing authorization…'})})]}
 return {model:{...m,authenticated:msg.authenticated,busy:msg.authenticated,...(!msg.authenticated?{accounts:[],accountEditing:'',accountPassword:'',accountDelete:''}:{})},commands:msg.authenticated?[load(m.q,1),accounts(),...(m.oauthMode==='consent'?[consentInfo(m.oauthQuery)]:[])]:[]}
 }
 case 'ConsentInfo':return {model:{...m,consentText:msg.text,oauthQuery:msg.query}}
 case 'Consent':return {model:{...m,busy:true},commands:[command('SubmitOAuthConsent',async()=>{const r=await call('/api/mcp/consent',{method:'POST',headers:headers(m),body:JSON.stringify({accept:msg.accept,oauth_query:m.oauthQuery})});if(typeof r.url==='string')location.assign(r.url);else if(typeof r.redirect_uri==='string')location.assign(r.redirect_uri);return Message.Done({notice:'Authorization completed.'})})]}
 case 'AccountsLoad':return {model:{...m,busy:true},commands:[accounts(msg.page)]}
 case 'AccountsLoaded':return {model:{...m,accounts:msg.accounts,accountTotal:msg.total,accountPage:msg.page,busy:false}}
 case 'EditAccount':return {model:{...m,accountEditing:msg.username,accountPassword:'',accountDelete:''}}
 case 'AccountPassword':return {model:{...m,accountPassword:msg.value}}
 case 'CancelAccount':return {model:{...m,accountEditing:'',accountPassword:''}}
 case 'SaveAccountPassword':return {model:{...m,busy:true,accountPassword:''},commands:[command('UpdateReaderPassword',async()=>{await call('/api/admin/accounts/'+encodeURIComponent(m.accountEditing),{method:'PATCH',headers:headers(m),body:JSON.stringify({password:m.accountPassword})});return Message.Done({notice:'Password updated for '+m.accountEditing+'. Update it on every reader using this account; progress is preserved.'})})]}
 case 'AskAccountDelete':return {model:{...m,accountDelete:msg.username,accountEditing:'',accountPassword:''}}
 case 'CancelAccountDelete':return {model:{...m,accountDelete:''}}
 case 'DeleteAccount':return {model:{...m,busy:true},commands:[command('DeleteReaderAccount',async()=>{await call('/api/admin/accounts/'+encodeURIComponent(m.accountDelete),{method:'DELETE',headers:headers(m)});return Message.Done({notice:'Reader account '+m.accountDelete+' and its sync data deleted. Library books are unchanged.'})})]}
 case 'Query':return {model:{...m,q:msg.value}}
 case 'Email':return {model:{...m,email:msg.value}}
 case 'DeviceUsername':return {model:{...m,deviceUsername:msg.value}}
 case 'DevicePassword':return {model:{...m,devicePassword:msg.value}}
 case 'SignIn':return {model:{...m,busy:true},commands:[command('RequestAdminSignIn',async()=>{
 await call('/api/auth/sign-in/magic-link',{method:'POST',headers:headers(m),body:JSON.stringify({email:m.email,callbackURL:m.oauthQuery?'/?mcp=resume&'+m.oauthQuery:'/'})})
 return Message.Done({notice:'If your email is approved, a sign-in link is on its way. Local development: /api/local/mail.'})})]}
 case 'SignOut':return {model:{...m,busy:true},commands:[command('SignOut',async()=>{await call('/api/auth/sign-out',{method:'POST',headers:headers(m),body:'{}'});return Message.Done({notice:'Signed out.'})})]}
 case 'CreateAccount':return {model:{...m,busy:true,devicePassword:''},commands:[command('CreateSyncAccount',async()=>{
 await call('/api/admin/accounts',{method:'POST',headers:headers(m),body:JSON.stringify({username:m.deviceUsername,password:m.devicePassword})})
 return Message.Done({notice:'Sync account created. Enter that username and password on your readers.'})})]}
 case 'Title':return {model:{...m,title:msg.value}}
 case 'Authors':return {model:{...m,authors:msg.value}}
 case 'Mapping':return {model:{...m,mapping:msg.value}}
 case 'Load':return {model:{...m,busy:true},commands:[load(m.q,msg.page)]}
 case 'Loaded':return {model:{...m,...msg,busy:false}}
 case 'Upload':{
 const file=msg.files[0];if(!file)return {model:m}
 return {model:{...m,busy:true,notice:'Uploading original…',error:false},commands:[command('UploadOriginal',async()=>{
 await call('/api/books',{method:'POST',headers:{...headers(m),'content-type':file.name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/epub+zip','x-filename':file.name},body:file})
 return Message.Done({notice:'Original archived successfully.'})})]}
 }
 case 'Done':return {model:{...m,busy:true,selected:null,accountEditing:'',accountPassword:'',accountDelete:'',deviceUsername:'',notice:msg.notice,error:false,confirmation:''},commands:[session()]}
 case 'Failed':return {model:{...m,busy:false,notice:msg.notice,error:true}}
 case 'Select':return {model:{...m,selected:msg.book,title:msg.book.title,authors:msg.book.authors}}
 case 'Close':return {model:{...m,selected:null}}
 case 'Save':return {model:{...m,busy:true},commands:[command('SaveMetadata',async()=>{await call('/api/books/'+m.selected!.id,{method:'PATCH',headers:headers(m),body:JSON.stringify({title:m.title,authors:m.authors})});return Message.Done({notice:'Metadata saved.'})})]}
 case 'AskDelete':return {model:{...m,confirmation:msg.id}}
 case 'Cancel':return {model:{...m,confirmation:''}}
 case 'Delete':return {model:{...m,busy:true},commands:[command('DeleteOriginal',async()=>{await call('/api/books/'+m.confirmation,{method:'DELETE',headers:headers(m)});return Message.Done({notice:'Book and original deleted.'})})]}
 case 'Diagnostics':return {model:{...m,busy:true},commands:[command('LoadSyncDiagnostics',async()=>Message.Diagnosed({text:JSON.stringify(await call('/api/admin/sync',{headers:headers(m)}),null,2)}))]}
 case 'Diagnosed':return {model:{...m,busy:false,diagnostics:msg.text}}
 case 'Map':return {model:{...m,busy:true},commands:[command('MapVerifiedDocument',async()=>{const parts=m.mapping.split(' ');if(parts.length!==3)throw Error('Enter username document-digest book-id');await call('/api/admin/mapping',{method:'PUT',headers:headers(m),body:JSON.stringify({username:parts[0],document:parts[1],book_id:parts[2]})});return Message.Done({notice:'Explicit document mapping saved.'})})]}
 }
}
const ICONS:Record<string,string>={
 book:'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20M8 7h8',
 search:'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM16.5 16.5 21 21',
 upload:'M12 16V4M7 9l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
 download:'M12 4v12M7 11l5 5 5-5M4 20h16',
 mail:'M3 6h18v12H3zM3 7l9 6 9-6',
 key:'M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM12 12v9M12 17h3M12 20h2',
 lock:'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
 sync:'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
 link:'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
 out:'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
 close:'M6 6l12 12M18 6 6 18',
 trash:'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
 shield:'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM9 12l2 2 4-4',
 arrowL:'M15 6l-6 6 6 6',arrowR:'M9 6l6 6-6 6'
}
const formatSize=(bytes:number)=>bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(0)+' KB':(bytes/1048576).toFixed(1)+' MB'
const formatDate=(iso:string)=>{const d=new Date(iso);return isNaN(d.getTime())?iso:d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}
const formatOf=(b:Book)=>b.media_type.includes('pdf')||b.filename.toLowerCase().endsWith('.pdf')?'PDF':'EPUB'
const hue=(id:string)=>{let n=0;for(const c of id)n=(n*31+c.charCodeAt(0))>>>0;return n%5}
export const view=(m:Model,h:HtmlBuilder<Message>):Document=>{
 const icon=(name:string)=>h.svg([h.Class('icon'),h.ViewBox('0 0 24 24'),h.Fill('none'),h.Stroke('currentColor'),h.StrokeWidth('1.6'),h.StrokeLinecap('round'),h.StrokeLinejoin('round'),h.AriaHidden(true)],[h.path([h.D(ICONS[name]??'')],[])])
 const btn=(label:string,msg:Message,variant='',iconName='')=>h.button([h.Type('button'),h.Class(('btn '+variant).trim()),h.OnClick(msg),h.Disabled(m.busy)],[...(iconName?[icon(iconName)]:[]),h.span([],[label])])
 const submit=(label:string,variant='',iconName='')=>h.button([h.Type('submit'),h.Class(('btn '+variant).trim()),h.Disabled(m.busy)],[...(iconName?[icon(iconName)]:[]),h.span([],[label])])
 const field=(id:string,label:string,input:ReturnType<typeof h.input>,hint='')=>h.div([h.Class('field')],[h.label([h.For(id)],[label]),input,...(hint?[h.p([h.Class('hint'),h.Id(id+'-hint')],[hint])]:[])])
 const mark=h.span([h.Class('mark')],[icon('book'),h.span([h.Class('mark-word')],['opds-library'])])

 if(!m.authenticated&&m.busy&&!m.notice&&!m.email&&!m.error)return {title:'opds-library',body:h.div([h.Class('gate')],[h.div([h.Class('gate-loading'),h.Role('status')],[mark,h.span([],['Opening the library…'])])])}
 if(!m.authenticated){
  const oauth=m.oauthMode==='login'||m.oauthMode==='consent'||m.oauthMode==='resume'
  const status=m.busy?'Checking access…':m.notice
  return {title:'Sign in · opds-library',body:h.div([h.Class('gate')],[
   h.main([h.Class('gate-card')],[
    h.div([h.Class('gate-head')],[mark,h.span([h.Class('pill')],[icon('lock'),'Private'])]),
    h.h1([h.Class('gate-title')],[oauth?'Sign in to authorize access':'Sign in to your library']),
    h.p([h.Class('gate-lede')],[oauth?'An application is asking to connect to this library. Sign in with your approved email first; you will review the request before anything is shared.':'This is a private reading room. Enter the email address approved for this library and we will send you a one-time sign-in link.']),
    h.form([h.Class('gate-form'),h.OnSubmit(Message.SignIn())],[
     field('signin-email','Email address',h.input([h.Id('signin-email'),h.Type('email'),h.Name('email'),h.Autocomplete('email'),h.Required(true),h.Value(m.email),h.Placeholder('you@example.com'),h.OnInput(value=>Message.Email({value}))])),
     submit('Email me a sign-in link','primary block','mail')
    ]),
    h.p([h.Role('status'),h.AriaLive('polite'),h.Class('gate-status'+(m.error?' is-error':'')+(status?'':' is-empty'))],[status]),
    h.div([h.Class('gate-aside')],[icon('key'),h.p([],[h.strong([],['Using an e-reader? ']),'OPDS catalogs and reading sync use a separate device username and password, not this email. Ask the library owner for reader credentials.'])])
   ]),
   h.p([h.Class('gate-foot')],['opds-library · a private library'])
  ])}
 }

 const pages=Math.max(1,Math.ceil(m.total/12))
 const status=m.busy?'Working…':m.notice
 const consent=m.oauthMode==='consent'?[h.section([h.Class('consent'),h.AriaLabel('Authorization request')],[
  h.div([h.Class('consent-icon')],[icon('shield')]),
  h.div([h.Class('consent-body')],[
   h.p([h.Class('kicker')],['Authorization request']),
   h.h2([],['Allow this application to add books?']),
   h.p([h.Class('consent-text'+(m.error&&!m.consentText?' is-error':''))],[m.consentText||(m.error?'This authorization request could not be verified. It may have expired — start the connection again from the application.':'Checking authorization request…')]),
   ...(m.consentText?[h.div([h.Class('row')],[btn('Allow uploads',Message.Consent({accept:true}),'primary'),btn('Deny',Message.Consent({accept:false}),'ghost')])]:[])
  ])
 ])]:[]

 const cover=(b:Book,cls:string)=>b.cover_type
  ?h.div([h.Class(cls+' has-image')],[h.img([h.Src('/api/books/'+b.id+'/cover'),h.Alt(''),h.Loading('lazy')])])
  :h.div([h.Class(cls+' plate plate-'+hue(b.id)),h.AriaHidden(true)],[h.span([h.Class('plate-format')],[formatOf(b)]),h.span([h.Class('plate-title')],[b.title]),h.span([h.Class('plate-author')],[b.authors||''])])

 const card=(b:Book)=>h.li([h.Class('book')],[
  h.button([h.Type('button'),h.Class('book-open'),h.OnClick(Message.Select({book:b})),h.AriaLabel('Details for '+b.title)],[
   cover(b,'cover'),
   h.span([h.Class('book-text')],[
    h.span([h.Class('book-title')],[b.title]),
    h.span([h.Class('book-author'+(b.authors?'':' is-missing'))],[b.authors||'Unknown author']),
    h.span([h.Class('book-meta')],[formatOf(b)+' · '+formatSize(b.size)])
   ])
  ]),
  h.a([h.Class('book-dl'),h.Href('/api/books/'+b.id+'/download'),h.AriaLabel('Download '+b.title),h.Title('Download original')],[icon('download')])
 ])

 const library=h.section([h.Class('library'),h.Id('library'),h.AriaLabelledBy('library-title')],[
  h.div([h.Class('library-head')],[
   h.div([],[h.p([h.Class('kicker')],['The collection']),h.h1([h.Id('library-title')],['Library']),h.p([h.Class('count')],[m.total===1?'1 volume':m.total+' volumes',...(m.q?[' matching “'+m.q+'”']:[])])]),
   h.label([h.Class('btn primary upload'+(m.busy?' is-disabled':''))],[icon('upload'),h.span([],['Add a book']),h.input([h.Type('file'),h.Accept('.epub,.pdf'),h.Disabled(m.busy),h.AriaLabel('Upload EPUB or PDF'),h.OnFileChange(files=>Message.Upload({files}))])])
  ]),
  h.form([h.Class('search'),h.Role('search'),h.OnSubmit(Message.Load({page:1}))],[
   icon('search'),
   h.input([h.Type('search'),h.Name('q'),h.AriaLabel('Search title or author'),h.Value(m.q),h.Placeholder('Search by title or author'),h.EnterKeyHint('search'),h.OnInput(value=>Message.Query({value}))]),
   h.button([h.Type('submit'),h.Class('search-go'),h.Disabled(m.busy)],['Search'])
  ]),
  h.p([h.Class('status'+(m.error?' is-error':'')+(status?'':' is-empty')),h.Role('status'),h.AriaLive('polite')],[status]),
  ...(m.books.length===0&&!m.busy?[h.div([h.Class('empty')],[
   h.p([h.Class('empty-glyph')],['❦']),
   h.h2([],[m.q?'Nothing on these shelves matches.':'The shelves are waiting.']),
   h.p([],[m.q?'Try a shorter title or an author’s surname.':'Add an EPUB or PDF. The original file is archived untouched, and readers can find it through the OPDS catalog.'])
  ])]:[]),
  h.ul([h.Class('shelf')],m.books.map(card)),
  ...(pages>1||m.page>1?[h.nav([h.Class('pager'),h.AriaLabel('Pages')],[
   btn('Previous',Message.Load({page:Math.max(1,m.page-1)}),'ghost small'+(m.page<=1?' is-hidden':''),'arrowL'),
   h.span([h.Class('pager-label')],['Page '+m.page+' of '+pages]),
   btn('Next',Message.Load({page:m.page+1}),'ghost small next'+(m.page>=pages?' is-hidden':''),'arrowR')
  ])]:[])
 ])

 const s=m.selected
 const drawer=s?[h.div([h.Class('scrim'),h.OnClick(Message.Close())],[]),h.aside([h.Class('sheet'),h.Role('dialog'),h.AriaModal(true),h.AriaLabelledBy('sheet-title')],[
  h.div([h.Class('sheet-head')],[h.p([h.Class('kicker')],['Catalogue entry']),h.button([h.Type('button'),h.Class('icon-btn'),h.OnClick(Message.Close()),h.AriaLabel('Close details')],[icon('close')])]),
  h.div([h.Class('sheet-intro')],[cover(s,'cover sheet-cover'),h.div([],[h.h2([h.Id('sheet-title')],[s.title]),h.p([h.Class('book-author')],[s.authors||'Unknown author']),h.a([h.Class('btn ghost small'),h.Href('/api/books/'+s.id+'/download')],[icon('download'),h.span([],['Download original'])])])]),
  h.dl([h.Class('facts')],[
   h.dt([],['Format']),h.dd([],[formatOf(s)+' · '+formatSize(s.size)]),
   h.dt([],['File']),h.dd([],[s.filename]),
   h.dt([],['Modified']),h.dd([],[formatDate(s.modified)]),
   h.dt([],['Digest']),h.dd([h.Class('mono')],[s.id])
  ]),
  h.form([h.Class('sheet-form'),h.OnSubmit(Message.Save())],[
   h.h3([],['Edit metadata']),
   field('meta-title','Title',h.input([h.Id('meta-title'),h.Value(m.title),h.OnInput(value=>Message.Title({value}))])),
   field('meta-authors','Authors',h.input([h.Id('meta-authors'),h.Value(m.authors),h.AriaDescribedBy('meta-authors-hint'),h.OnInput(value=>Message.Authors({value}))]),'Separate several authors with commas.'),
   h.div([h.Class('row')],[submit('Save changes','primary'),btn('Close',Message.Close(),'ghost')])
  ]),
  h.div([h.Class('sheet-danger')],[h.div([],[h.h3([],['Remove from library']),h.p([h.Class('hint')],['Deletes the catalogue entry and the archived original.'])]),btn('Delete…',Message.AskDelete({id:s.id}),'danger-ghost small','trash')])
 ])]:[]

 const confirm=m.confirmation?[h.div([h.Class('scrim scrim-top'),h.OnClick(Message.Cancel())],[]),h.div([h.Class('confirm'),h.Role('alertdialog'),h.AriaModal(true),h.AriaLabelledBy('confirm-title'),h.AriaDescribedBy('confirm-text')],[
  h.div([h.Class('confirm-icon')],[icon('trash')]),
  h.h2([h.Id('confirm-title')],['Delete this book and its original?']),
  h.p([h.Id('confirm-text')],[(s&&s.id===m.confirmation?'“'+s.title+'” will be permanently removed, including the archived file. ':'This permanently removes the archived file. ')+'Reading progress is retained under its separate document identity.']),
  h.div([h.Class('row end')],[btn('Cancel',Message.Cancel(),'ghost'),btn('Delete permanently',Message.Delete(),'danger')])
 ])]:[]

 const accountConfirm=m.accountDelete?[h.div([h.Class('scrim scrim-top'),h.OnClick(Message.CancelAccountDelete())],[]),h.div([h.Class('confirm'),h.Role('alertdialog'),h.AriaModal(true),h.AriaLabelledBy('account-confirm-title')],[
  h.h2([h.Id('account-confirm-title')],['Delete reader “'+m.accountDelete+'”?']),
  h.p([],['This permanently removes this account and its reading progress, device positions, bookmarks, clippings and document metadata. Its credentials stop working. Library books and other accounts are kept.']),
  h.div([h.Class('row end')],[btn('Cancel',Message.CancelAccountDelete(),'ghost'),btn('Delete account',Message.DeleteAccount(),'danger')])
 ])]:[]
 const desk=h.section([h.Class('desk'),h.Id('desk'),h.AriaLabelledBy('desk-title')],[
  h.div([h.Class('desk-head')],[h.p([h.Class('kicker')],['The front desk']),h.h2([h.Id('desk-title')],['Readers & administration']),h.p([h.Class('lede')],['Create credentials for your e-readers and check reading-progress sync. Device credentials are separate from your admin sign-in.'])]),
  h.div([h.Class('desk-grid')],[
   h.article([h.Class('tile tile-wide')],[
    h.header([h.Class('tile-head')],[icon('key'),h.div([],[h.h3([],['Reader accounts']),h.p([h.Class('hint')],['Create separate accounts for each reader or person. Each has its own progress and annotations; all access the shared book library. Reuse an account on devices that should sync together.'])])]),
    h.div([h.Class('reader-accounts')],[
     h.div([h.Class('row')],[h.h4([],['Accounts ('+m.accountTotal+')']),btn('Refresh',Message.AccountsLoad({page:m.accountPage}),'ghost small')]),
     ...(m.accounts.length?m.accounts.map(account=>h.div([h.Class('reader-account')],[
      h.div([h.Class('reader-account-heading')],[h.strong([],[account.username]),h.span([h.Class('hint')],['Created '+formatDate(new Date(account.created*1000).toISOString())])]),
      ...(m.accountEditing===account.username?[
       h.form([h.Class('tile-form'),h.OnSubmit(Message.SaveAccountPassword())],[
        field('reader-new-password','New password for '+account.username,h.input([h.Id('reader-new-password'),h.Type('password'),h.Autocomplete('new-password'),h.Minlength(16),h.Maxlength(128),h.Required(true),h.Value(m.accountPassword),h.OnInput(value=>Message.AccountPassword({value}))]),'16–128 characters. Update this password on every device using this account. Progress is preserved.'),
        h.div([h.Class('row')],[submit('Update password','primary small'),btn('Cancel',Message.CancelAccount(),'ghost small')])
       ])
      ]:[h.div([h.Class('row')],[btn('Change password',Message.EditAccount({username:account.username}),'ghost small','key'),btn('Delete…',Message.AskAccountDelete({username:account.username}),'danger-ghost small','trash')])])
     ])):[h.p([h.Class('hint')],[m.busy?'Loading accounts…':'No reader accounts yet. Create your first account below.'])]),
     h.div([h.Class('row')],[...(m.accountPage>1?[btn('Previous accounts',Message.AccountsLoad({page:m.accountPage-1}),'ghost small')]:[]),...(m.accountPage*25<m.accountTotal?[btn('More accounts',Message.AccountsLoad({page:m.accountPage+1}),'ghost small')]:[])])
    ]),
    h.h4([],['Create another reader account']),
    h.form([h.Class('tile-form'),h.OnSubmit(Message.CreateAccount())],[
     h.div([h.Class('pair')],[
      field('dev-user','Reader username',h.input([h.Id('dev-user'),h.Name('username'),h.Autocomplete('off'),h.Autocapitalize('none'),h.Spellcheck(false),h.Value(m.deviceUsername),h.OnInput(value=>Message.DeviceUsername({value}))])),
      field('dev-pass','Device password',h.input([h.Id('dev-pass'),h.Type('password'),h.Name('new-password'),h.Autocomplete('new-password'),h.Minlength(16),h.Maxlength(128),h.Value(m.devicePassword),h.AriaDescribedBy('dev-pass-hint'),h.OnInput(value=>Message.DevicePassword({value}))]),'16–128 characters. Save it in your password manager first — it is never shown again.')
     ]),
     h.div([h.Class('row')],[submit('Create sync account','primary')])
    ]),
    h.div([h.Class('endpoint')],[h.span([h.Class('endpoint-label')],['Reading-progress sync URL']),h.code([],[location.origin])]),
    h.div([h.Class('endpoint')],[h.span([h.Class('endpoint-label')],['KOReader OPDS catalog (1.2)']),h.code([],[location.origin+'/opds/v1/catalog.xml'])]),
    h.div([h.Class('endpoint')],[h.span([h.Class('endpoint-label')],['OPDS 2.0 catalog']),h.code([],[location.origin+'/opds/v2/catalog.json'])]),
    h.p([h.Class('hint')],['Use your reader username and password for catalogs and downloads. A sync folder does not configure a catalog URL.']),
   ]),
   h.article([h.Class('tile')],[
    h.header([h.Class('tile-head')],[icon('sync'),h.div([],[h.h3([],['Sync diagnostics']),h.p([h.Class('hint')],['KOSync v1, CrossPoint rich progress, bookmarks and clippings.'])])]),
    btn(m.diagnostics?'Refresh status':'Load sync status',Message.Diagnostics(),'ghost small','sync'),
    h.pre([h.Class('diag'+(m.diagnostics?'':' is-empty'))],[m.diagnostics||'No diagnostics loaded yet.'])
   ]),
   h.article([h.Class('tile')],[
    h.header([h.Class('tile-head')],[icon('link'),h.div([],[h.h3([],['Map a document']),h.p([h.Class('hint')],['Link a reader’s document digest to a book — only after verifying its identity.'])])]),
    h.form([h.Class('tile-form'),h.OnSubmit(Message.Map())],[
     field('mapping','Mapping',h.input([h.Id('mapping'),h.Class('mono'),h.Autocapitalize('none'),h.Spellcheck(false),h.Value(m.mapping),h.AriaDescribedBy('mapping-hint'),h.OnInput(value=>Message.Mapping({value})),h.Placeholder('username digest book-id')]),'Three values separated by single spaces.'),
     h.div([h.Class('row')],[submit('Save mapping','ghost small')])
    ])
   ]),
   h.article([h.Class('tile')],[
    h.header([h.Class('tile-head')],[icon('lock'),h.div([],[h.h3([],['This browser']),h.p([h.Class('hint')],['You are signed in as the library administrator. Reader accounts above take effect immediately.'])])]),
    h.div([h.Class('row')],[btn('Sign out',Message.SignOut(),'ghost small','out')])
   ])
  ])
 ])

 return {title:'opds-library · Your library',body:h.div([h.Class('app'+(s||m.confirmation||m.accountDelete?' is-locked':''))],[
  h.header([h.Class('topbar')],[
   h.a([h.Class('brand'),h.Href('/'),h.AriaLabel('opds-library home')],[mark]),
   h.nav([h.Class('topnav'),h.AriaLabel('Primary')],[
    h.a([h.Href('#library')],['Library']),
    h.a([h.Href('#desk')],['Readers']),
    h.a([h.Class('hide-sm'),h.Href('/opds/v2/catalog.json')],['OPDS ↗']),
    h.button([h.Type('button'),h.Class('icon-btn'),h.OnClick(Message.SignOut()),h.Disabled(m.busy),h.AriaLabel('Sign out'),h.Title('Sign out')],[icon('out')])
   ])
  ]),
  h.main([h.Class('page')],[...consent,library,desk]),
  h.footer([h.Class('foot')],[h.span([],['opds-library · originals archived in R2 · catalogue & progress in D1']),h.span([],[h.a([h.Href('/opds/v2/catalog.json')],['OPDS 2.0 catalog']),' · ',h.a([h.Href('/opds/v1/catalog.xml')],['KOReader / OPDS 1.2']),' · ',h.a([h.Href('/healthcheck')],['Server health'])])]),
  ...drawer,...confirm,...accountConfirm
 ])}
}
Runtime.run(Runtime.makeApplication({Model,init,update,view,container:document.getElementById('root')}))
