const {chromium}=require('playwright'),assert=require('node:assert/strict');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const target=path.resolve(process.argv[2]||path.join(__dirname,'../dist/app'));
(async()=>{
 const browser=await chromium.launch();
 try {
  const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[],plays=[],saved=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   localStorage.setItem('fjordflix.connection',JSON.stringify({server:'https://episodes.test',token:'t'.repeat(43)}));
   HTMLMediaElement.prototype.canPlayType=()=> 'probably';
   HTMLMediaElement.prototype.load=function(){this.currentTime=0;if(this.dataset.source)setTimeout(()=>this.dispatchEvent(new Event('loadedmetadata')),0);};
   HTMLMediaElement.prototype.pause=function(){this.dataset.paused='yes';};
   HTMLMediaElement.prototype.play=function(){this.dataset.paused='no';this.dispatchEvent(new Event('playing'));return Promise.resolve();};
   Object.defineProperty(HTMLMediaElement.prototype,'paused',{get(){return this.dataset.paused!=='no';}});
   Object.defineProperty(HTMLMediaElement.prototype,'src',{get(){return this.dataset.source||'';},set(value){this.dataset.source=value;}});
  });
  const episode=(id,season,number)=>({id,title:'Afsnit '+number,duration:100,position:0,series_key:'series',
   catalog:{season,episode:number},width:1920,height:1080,video:'h264',audio:'aac',format:'mp4',pix_fmt:'yuv420p',quality:{},tracks:{audio:[],subtitles:[]}});
  const movies=[episode('first',1,2),episode('second',2,1),episode('last',2,2)];
  await page.route('https://episodes.test/**',route=>{
   const request=route.request(),url=new URL(request.url()),p=url.pathname;
   const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,DELETE,OPTIONS'};
   const reply=data=>route.fulfill({headers,json:data});
   if(request.method()==='OPTIONS')return reply({});
   if(p.endsWith('/state'))return reply({user:{name:'Test'}});
   if(p.endsWith('/info'))return reply({features:[]});
   if(p==='/tv-api/movies')return reply(movies);
   if(p.endsWith('/tracks'))return reply({audio:[],subtitles:[]});
   if(p.endsWith('/plan'))return reply({mode:'Direct Play',height:1080});
   if(p.endsWith('/play')){const id=p.split('/')[3];plays.push(id);return reply({mode:'Direct Play',url:'https://episodes.test/'+id+'.mp4',height:1080,offset:0,media_ticket:id});}
   if(p.endsWith('/progress'))saved.push({id:p.split('/')[3],...request.postDataJSON()});
   if(p.endsWith('/poster')||p.endsWith('/backdrop'))return route.fulfill({status:404,headers});
   return reply({ok:true});
  });
  await page.goto(pathToFileURL(path.join(target,'index.html')).href);
  await page.locator('.card').first().click();await page.locator('#play').click();
  await page.waitForFunction(()=>document.querySelector('#video').dataset.source?.includes('/first.mp4'));
  const time=async(value,ended=false)=>page.evaluate(({value,ended})=>{const v=document.querySelector('#video');v.currentTime=value;v.dispatchEvent(new Event(ended?'ended':'timeupdate'));},{value,ended});
  await time(89);assert.equal(await page.locator('#next-episode').isVisible(),false);
  await time(90);await page.waitForFunction(()=>!document.querySelector('#next-episode').hidden);
  assert.match(await page.locator('#next-episode').textContent(),/10 sek/);
  await page.evaluate(()=>document.querySelector('#video').pause());
  await page.waitForTimeout(1100);assert.match(await page.locator('#next-episode').textContent(),/10 sek/);
  await time(40);assert.equal(await page.locator('#next-episode').isVisible(),false);
  await page.evaluate(()=>document.querySelector('#video').play());await time(94);
  require('node:fs').mkdirSync(path.resolve(target,'../../test-results'),{recursive:true});
  await page.screenshot({path:path.resolve(target,'../../test-results/next-episode.png')});
  await page.locator('#next-episode').click();
  await page.waitForFunction(()=>document.querySelector('#video').dataset.source?.includes('/second.mp4'));
  await time(99);assert.match(await page.locator('#next-episode').textContent(),/1 sek/);
  await time(100,true);await time(100,true);
  await page.waitForFunction(()=>document.querySelector('#video').dataset.source?.includes('/last.mp4'));
  await time(95);assert.equal(await page.locator('#next-episode').isVisible(),false);
  await time(100,true);await page.waitForTimeout(200);
  assert.deepEqual(plays,['first','second','last']);
  assert(saved.some(row=>row.id==='first'&&row.position===94));
  assert(saved.some(row=>row.id==='second'&&row.position===100));
  assert.deepEqual(errors,[]);
  console.log('PASS '+target+': countdown, pause, seek back, click, automatic season transition, exactly once and last episode');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
