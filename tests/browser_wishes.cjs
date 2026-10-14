const {chromium}=require('../xbox/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results/wishes');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  let admin=true,allowed=false,items=[];const errors=[];
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://wishes.test/**',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   const reply=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   if(p==='/api/state')return reply({user:{id:admin?'admin':'viewer',name:admin?'Administrator':'Anna',admin,can_request:admin||allowed},managed:false,gpu:false});
   if(p==='/api/movies')return reply([]);
   if(p==='/api/admin')return reply({users:[{id:'viewer',name:'Anna',admin:false,can_request:allowed}],gpu:false,free_gb:100,streams:0,max_streams:3});
   if(p==='/api/admin/users/viewer/wishes'){allowed=req.postDataJSON().enabled;return reply({ok:true});}
   if(p==='/api/wishes'){
    if(req.method()==='POST'){items.push({id:'wish',sender:'Anna',...req.postDataJSON(),created:Date.now()/1000,status:'new',reply:''});return reply({ok:true});}
    return reply({items,has_more:false,admin});
   }
   if(p==='/api/admin/wishes/wish'){Object.assign(items[0],req.postDataJSON());return reply({ok:true});}
   if(p.startsWith('/api/'))return reply({ok:true,pending:false,streams:[],sources:[],providers:[],configured:false});
   const file=p==='/'?path.join(root,'app/static/index.html'):path.join(root,'app',p);
   if(!file.startsWith(path.join(root,'app'))||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({path:file});
  });
  await page.goto('https://wishes.test');await page.locator('#admin-open').click();
  await page.locator('[data-settings-tab="users"]').click();
  await page.getByRole('checkbox',{name:'Tillad ønsker for Anna'}).check();
  await page.waitForFunction(()=>!document.querySelector('.wish-permission input').disabled);assert.equal(allowed,true);
  await page.screenshot({path:path.join(out,'admin-permission.png')});
  admin=false;await page.reload();await page.locator('#wishes-sidebar').click();
  assert.equal(await page.locator('#wish-form').isVisible(),true);
  await page.locator('#wish-form input[name="title"]').fill('The Great Adventure (2026)');
  await page.locator('#wish-form textarea').fill('Gerne med danske undertekster.');await page.locator('#wish-form button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('wishes-message').textContent.includes('sendt'));assert.equal(items.length,1);
  admin=true;await page.reload();await page.locator('#wishes-sidebar').click();
  assert.equal(await page.locator('#wish-form').isVisible(),false);
  await page.locator('.wish-decision select').selectOption('fulfilled',{force:true});await page.locator('.wish-decision textarea').fill('Filmen er klar i biblioteket.');await page.locator('.wish-decision button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('wishes-message').textContent.includes('gemt'));assert.equal(items[0].status,'fulfilled');
  admin=false;await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('#wishes-open').click();
  await page.locator('.wish-card').waitFor();assert.match(await page.locator('.wish-card').textContent(),/Filmen er klar/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'mobile-wishes.png')});
  allowed=false;await page.reload();assert.equal(await page.locator('#wishes-open').isVisible(),false);assert.deepEqual(errors,[]);await page.close();
  for(const app of ['lg','xbox']){
   const tv=await browser.newPage({viewport:{width:1920,height:1080}}),tvErrors=[];tv.on('pageerror',e=>tvErrors.push(e.message));
   await tv.addInitScript(()=>localStorage.setItem('fjordflix.connection',JSON.stringify({server:'https://tv-wishes.test',token:'a'.repeat(43)})));
   let sent;
   await tv.route('https://tv-wishes.test/**',route=>{
    const req=route.request(),p=new URL(req.url()).pathname,headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'};
    const reply=data=>route.fulfill({headers,contentType:'application/json',body:JSON.stringify(data)});
    if(req.method()==='OPTIONS')return reply({});
    if(p.endsWith('/state'))return reply({user:{id:'viewer',name:'Anna',can_request:true}});
    if(p.endsWith('/info'))return reply({features:[]});
    if(p.endsWith('/movies'))return reply([]);
    if(p.endsWith('/wishes')){if(req.method()==='POST'){assert.match(req.headers().authorization,/^Bearer /);sent=req.postDataJSON();return reply({ok:true});}return reply({items:[],has_more:false,admin:false});}
    return reply({ok:true});
   });
   await tv.goto(require('node:url').pathToFileURL(path.join(root,app,'dist/app/index.html')).href);
   await tv.locator('#wishes-open').click();await tv.locator('#wish-title').click();await tv.locator('#wish-title').fill('En ønsket serie');
   await tv.locator('#wishes-panel form button[type=submit]').click();await tv.waitForFunction(()=>document.getElementById('wish-message').textContent.includes('sendt'));assert.equal(sent.title,'En ønsket serie');
   await tv.locator('#wishes-panel form button[type=submit]').focus();await tv.keyboard.press('Escape');assert.equal(await tv.locator('#wishes-panel').isVisible(),false);assert.deepEqual(tvErrors,[]);await tv.close();
  }
  console.log('PASS wishes: admin permission, user submission, admin reply, mobile layout, revocation, LG/Xbox bearer submission and remote back');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
