const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let downloaded=false,configured=false,searches=0;
 const movie={id:'a'.repeat(32),title:'Scary Movie',width:3840,height:2160,video:'hevc',audio:'aac',duration:61,size:500000000,bitrate:60000000,position:0,catalog:{media_type:'movie'},tracks:{version:1,audio:[],subtitles:[]}};
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/')return route.fulfill({path:path.resolve('app/static/index.html'),contentType:'text/html'});
  if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.resolve('app',url.pathname.slice(1))});
  let data={ok:true};
  if(url.pathname==='/api/state')data={user:{id:'owner',name:'Tester',admin:true},managed:false};
  else if(url.pathname==='/api/movies')data=[movie];
  else if(url.pathname.endsWith('/plan'))data={mode:'Direct Play',height:2160,mbps:60,reason:'Test'};
  else if(url.pathname==='/api/admin')data={gpu:false,free_gb:100,streams:0,max_streams:3,users:[]};
  else if(url.pathname==='/api/admin/opensubtitles'){
   if(req.method()==='PUT'){assert.equal(req.postDataJSON().api_key,'test-key');configured=true;}
   data={configured,username:configured?'tester':''};
  } else if(url.pathname.endsWith('/subtitle-search')){
   searches++;assert.equal(url.searchParams.get('language'),'da');
   data={results:[{choice:'choice',release:'BluRay test <script>bad()</script>',hash_match:true}],message:'Check timing'};
  } else if(url.pathname.endsWith('/subtitle-download')){
   assert.equal(req.postDataJSON().choice,'choice');downloaded=true;
   movie.tracks.subtitles=[{index:1000000123,codec:'subrip',language:'da',title:'OpenSubtitles',delivery:'text',external:true}];
   data={index:1000000123,remaining:9};
  } else if(url.pathname.endsWith('/tracks'))data=movie.tracks;
  else if(url.pathname.endsWith('/poster')||url.pathname.endsWith('/backdrop'))return route.fulfill({status:404});
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 try {
  await page.goto('http://fjordflix.test/');
  await page.locator('#admin-open').click();
  await page.getByRole('button',{name:'Undertekster · OpenSubtitles',exact:true}).click();
  await page.locator('#os-key').fill('test-key');await page.locator('#os-username').fill('tester');await page.locator('#os-password').fill('test-password');
  await page.locator('#os-save').click();await page.waitForFunction(()=>document.getElementById('os-status').textContent.includes('Tilsluttet som'));
  assert.equal(await page.locator('#os-password').inputValue(),'');
  await page.screenshot({path:'test-results/subtitle-settings.png'});
  await page.locator('#os-close').click();await page.locator('#movie-grid .movie-card').first().click();
  await page.locator('#subtitle-find').click();assert.equal(searches,0);
  await page.locator('#subtitle-search-submit').click();await page.getByRole('button',{name:'Hent SRT',exact:true}).waitFor();
  await page.screenshot({path:'test-results/subtitle-search-desktop.png'});
  assert.equal(await page.locator('#subtitle-results script').count(),0);
  await page.getByRole('button',{name:'Hent SRT',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('subtitle-search-status').textContent.includes('gemt og valgt'));
  assert.ok(downloaded);assert.equal(await page.locator('#detail-subtitle').inputValue(),'1000000123');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/subtitle-search-mobile.png'});
  assert.ok(await page.locator('#subtitle-search-dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS: settings, explicit Danish search, safe results, download, selection, desktop/mobile');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
