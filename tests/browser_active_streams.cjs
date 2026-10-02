const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));let empty=false,fail=false,calls=0;
 const base={id:'one',movie_id:'a'.repeat(32),title:'En aften i biografen',user:'Mikkel',client:'Browser',poster:'/api/movies/a/poster',duration:7200,position:1830,state:'playing',mode:'Transcoding',height:1080,mbps:8,video:{source:'hevc',output:'h264',transcoded:true},audio:{codec:'truehd',language:'eng',title:'Surround 7.1'},audio_transcoded:true,subtitle:{codec:'hdmv_pgs_subtitle',language:'dan'},subtitle_delivery:'burn',encoder:'NVIDIA NVDEC + NVENC · HDR på GPU',touch:Date.now()/1000};
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({path:path.resolve('app/static/index.html'),contentType:'text/html'});
  if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.resolve('app',url.pathname.slice(1))});
  if(url.pathname.endsWith('/poster'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#304052"/><circle cx="100" cy="100" r="60" fill="#d6aa72"/><path d="M0 300L70 150L200 300" fill="#131b24"/></svg>'});
  let data={};
  if(url.pathname==='/api/state')data={user:{id:'admin',name:'Admin',admin:true}};
  else if(url.pathname==='/api/movies')data=[];
  else if(url.pathname==='/api/admin')data={gpu:true,free_gb:100,streams:2,max_streams:3,users:[]};
  else if(url.pathname==='/api/admin/library')data={sources:[],scan:{running:false,added:0,updated:0,errors:[]}};
  else if(url.pathname==='/api/admin/active-streams'){
   calls++;if(fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Test connection error'})});
   data={streams:empty?[]:[base,{...base,id:'two',user:'Sara <script>bad()</script>',title:'En meget lang titel som stadig skal kunne læses i kortet uden at bryde layoutet',mode:'Direct Play',client:'Windows-app',position:430,state:'paused',height:2160,mbps:45,video:{source:'hevc',output:'hevc',transcoded:false},audio_transcoded:false,subtitle_delivery:'local',encoder:'Original · afspilles lokalt'}]};
  }
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 try{
  await page.goto('http://fjordflix.test');await page.locator('#admin-open').click();await page.locator('[data-settings-tab="active-streams"]').click();
  await page.locator('.stream-card').first().waitFor();assert.equal(await page.locator('.stream-card').count(),2);
  assert.ok((await page.locator('.stream-card').first().innerText()).includes('brændes ind i videoen'));
  assert.ok((await page.locator('.stream-card').last().innerText()).includes('vises lokalt'));
  assert.equal(await page.locator('.stream-card script').count(),0);
  fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/active-streams-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/active-streams-mobile.png'});
  assert.ok(await page.locator('.settings-content').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'no horizontal overflow');
  empty=true;await page.evaluate(()=>window.loadActiveStreams());assert.equal(await page.locator('.stream-card').count(),0);
  assert.ok(await page.locator('.stream-empty').isVisible());
  fail=true;await page.evaluate(()=>window.loadActiveStreams());assert.ok((await page.locator('#active-streams-status').textContent()).includes('Test connection error'));
  await page.locator('[data-settings-tab="server"]').click();const before=calls;await page.waitForTimeout(5200);assert.equal(calls,before,'polling stops on other tab');
  assert.deepEqual(errors,[]);console.log('PASS: stream cards, burn/local labels, escaping, empty/error states, mobile layout, polling lifecycle');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
