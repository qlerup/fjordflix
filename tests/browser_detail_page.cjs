const {chromium}=require('playwright');
const path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const movie={id:'a'.repeat(32),title:'En rejse gennem natten',width:3840,height:2160,format:'matroska',video:'hevc',audio:'aac',duration:7200,size:123456789,bitrate:25000000,position:90,catalog:{status:'matched',overview:'En uventet rejse bringer gamle venner sammen igen. En fortælling om de valg, der former os, og de mennesker, vi møder undervejs.',genres:['Drama','Eventyr'],release_date:'2026-01-01',rating:7.8,votes:100,tmdb_id:42}};
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({path:path.resolve('app/static/index.html'),contentType:'text/html'});
  if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.resolve('app',url.pathname.slice(1))});
  if(/poster|backdrop/.test(url.pathname))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#27333f"/><circle cx="240" cy="180" r="115" fill="#c18c63"/><path d="M0 600L130 230L400 600" fill="#131923"/></svg>'});
  let data={};
  if(url.pathname==='/api/state')data={user:{id:'user',name:'Mikkel',admin:false}};
  if(url.pathname==='/api/movies')data=[movie];
  if(url.pathname.endsWith('/credits'))data={cast:Array.from({length:10},(_,i)=>({name:'Skuespiller '+i,character:'Rolle '+i}))};
  if(url.pathname.endsWith('/tracks'))data={audio:[],subtitles:[],defaults:{audio_track:null,subtitle_track:null}};
  if(url.pathname.endsWith('/plan'))data={mode:'Direct Play',height:2160,mbps:25,reason:'Original kvalitet'};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 try {
  await page.goto('http://fjordflix.test');
  await page.locator('#movie-grid .movie-card').first().waitFor();
  // Reproduce an older cached categories script's DOM structure.
  await page.evaluate(()=>document.querySelector('.library').prepend(document.getElementById('library-categories')));
  await page.locator('#movie-grid .movie-card').first().click();
  await page.locator('.cast-person').first().waitFor();await page.waitForFunction(()=>document.getElementById('plan-badge').textContent==='Direct Play');
  assert.equal(await page.locator('#detail').evaluate(e=>e.tagName),'SECTION');
  assert.ok(await page.locator('#shell > main').isHidden());
  assert.ok(page.url().includes('#title/'));assert.equal(await page.locator('.cast-person').count(),10);
  await page.screenshot({path:'test-results/detail-page-desktop.png',fullPage:true});
  await page.goBack();assert.ok(await page.locator('#detail').isHidden());
  await page.goForward();await page.locator('#detail').waitFor();
  await page.reload();await page.locator('#detail').waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/detail-page-mobile.png',fullPage:true});
  for(const width of [390,700,1440]){
    await page.setViewportSize({width,height:844});
    const detail=await page.locator('#detail').boundingBox();
    if(width<=800){
      assert.ok(await page.locator('header > nav').isVisible(),'mobile bottom navigation stays available');
      assert.ok(await page.locator('#library-categories').isHidden(),'desktop sidebar does not squeeze mobile detail');
      assert.equal(detail.x,0,'mobile detail uses full screen width');
    }else{
      const sidebar=await page.locator('#library-categories').boundingBox();
      assert.equal(sidebar.x,0,'desktop sidebar remains anchored to the left');
      assert.ok(detail.x>=sidebar.width,'desktop detail leaves room for sidebar');
    }
  }
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no mobile overflow');
  await page.locator('#detail-back').click();assert.ok(await page.locator('#detail').isHidden());
  await page.evaluate(() => {
    const base = library[0];
    library = [1,2].map(n=>({...base,id:String(n).repeat(32),series_key:'test',catalog:{...base.catalog,media_type:'tv',series_title:'En ny serie',season:1,episode:n,episode_title:'Afsnit '+n}}));
    render();openDetail(FjordLibrary.cards(library)[0]);
  });
  await page.locator('#series-episodes .episode-card').nth(1).click();
  assert.ok((await page.locator('#detail-episode').textContent()).includes('S01E02'));
  assert.equal(await page.locator('#detail-title').textContent(),'En ny serie');
  assert.ok(await page.locator('#detail-extras #episode-picker').isVisible());
  assert.ok(await page.locator('#toast').isHidden(),'no playback-plan errors');
  assert.deepEqual(errors,[]);console.log('PASS detail page, cast, back/forward, reload, mobile');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
