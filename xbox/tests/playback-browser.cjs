/* Playback orchestration checks with a deterministic simulated Xbox media element.
 * Codec decoding remains a physical Xbox check; these tests validate actual UI/API flow.
 */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const origin = 'https://playback.test';
const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,DELETE,OPTIONS'};
async function fixture(browser, options={}) {
  const context = await browser.newContext({viewport:{width:1920,height:1080}}), page = await context.newPage();
  const calls=[], plays=[], plans=[], errors=[];
  let pendingPlan, releasePlan, markPlanStarted;
  const planGate = new Promise(resolve=>releasePlan=resolve);
  const planStarted = new Promise(resolve=>markPlanStarted=resolve);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('fjordflix.connection',JSON.stringify({server:'https://playback.test',token:'t'.repeat(43)}));
    HTMLMediaElement.prototype.canPlayType=function(){return 'probably';};
    HTMLMediaElement.prototype.load=function(){this.currentTime=0;};
    HTMLMediaElement.prototype.pause=function(){};
    HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
    Object.defineProperty(HTMLMediaElement.prototype,'src',{configurable:true,
      get(){return this.dataset.testSource||'';},set(value){this.dataset.testSource=value;}});
  });
  const movie={id:'hevc4k',title:'Nordlys',height:2160,width:3840,duration:7200,position:120,
    video:'hevc',audio:'aac',format:options.container||'mp4',pix_fmt:'yuv420p10le',bitrate:25000000,
    quality:{dynamic_range:'HDR10',frame_rate:'24/1'},tracks:{audio:[],subtitles:[]},catalog:{overview:'Testfilm fra eget bibliotek.'}};
  const mode=request=>!request.video_copy||['1080','720','480'].includes(request.quality)?'Transcoding':request.direct?'Direct Play':'Direct Stream';
  await page.route(origin+'/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname;
    const reply=data=>route.fulfill({headers,contentType:'application/json',body:JSON.stringify(data)});
    if(req.method()==='OPTIONS') return reply({});
    calls.push({path:p,method:req.method()});
    if(p==='/tv-api/state') return reply({user:{name:'Xbox QA'}});
    if(p==='/tv-api/info') return reply({features:options.oldServer?[]:options.legacy?['xbox-hevc-fmp4']:['xbox-hevc-fmp4','xbox-hdr10-base','xbox-hevc-transcode']});
    if(p==='/tv-api/movies') return reply([movie]);
    if(p.endsWith('/tracks')) return reply(movie.tracks);
    if(p.endsWith('/poster')||p.endsWith('/backdrop')) return route.fulfill({status:404,headers});
    if(p.endsWith('/plan')) {
      const request=req.postDataJSON();plans.push(request);
      if(options.holdPlan && Object.hasOwn(request,'start')) {pendingPlan=true; markPlanStarted(); await planGate;}
      return reply({mode:options.transcodePlan?'Transcoding':mode(request),height:options.transcodePlan?1080:request.hevc_output||request.video_copy?2160:1080,video_codec:request.hevc_output&&!options.transcodePlan?'hevc':'h264',reason:options.transcodePlan?'Billedbaserede undertekster kræver videokonvertering.':'Testplan'});
    }
    if(p.endsWith('/play')) {
      const request=req.postDataJSON();plays.push(request);
      const delivery=options.transcodeResult?'Transcoding':mode(request);
      return reply({mode:delivery,session:delivery==='Direct Play'?null:'stream-'+plays.length,
        media_ticket:'ticket-'+plays.length,url:origin+'/media-'+plays.length+'.mp4',height:delivery==='Transcoding'&&!request.hevc_output?1080:2160,video_codec:request.hevc_output&&!options.transcodeResult?'hevc':'h264',offset:delivery==='Direct Play'?0:request.start});
    }
    if(p.endsWith('/heartbeat') && p.includes('/streams/')) return reply({ok:true,transcoding:{speed:0.75,encoded_seconds:12,finished:false}});
    return reply({ok:true});
  });
  await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
  await page.locator('.card').click();
  await page.waitForFunction(()=>document.getElementById('quality-plan').textContent.includes('p'));
  const start = async quality=>{
    await page.locator(`[data-quality="${quality}"]`).click();
    await page.locator('#play').click();
  };
  const loaded = async number=>{
    await page.waitForFunction(number=>document.getElementById('video').dataset.testSource?.endsWith('/media-'+number+'.mp4'),number);
    // The source is assigned before the promise chain resets its busy flag.
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    await page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('loadedmetadata')));
  };
  const fail = ()=>page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('error')));
  const close=async()=>{assert.deepEqual(errors,[]);await context.close();};
  return {page,calls,plays,plans,start,loaded,fail,close,releasePlan,planStarted,get pendingPlan(){return pendingPlan;}};
}
function assertStages(plays,quality) {
  assert.ok(plays.every(request=>request.client_profile==='xbox'));
  assert.equal(plays[0].quality,quality);assert.equal(plays[0].video_copy,true);
  assert.equal(plays[1].quality,quality);assert.equal(plays[1].direct,false);
  assert.equal(plays[1].video_copy,true);assert.equal(plays[1].audio_copy,false);
  assert.equal(plays[1].start,plays[0].start,'retry preserves playback position');
}
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const quality of ['original','2160']) {
      const test=await fixture(browser,{legacy:true});
      await test.start(quality);await test.loaded(1);
      await test.fail();await test.loaded(2);
      assertStages(test.plays,quality);assert.equal(test.plays[0].direct,true);
      await test.fail();
      await test.page.waitForFunction(()=>/Original video kunne ikke|4K kunne ikke leveres/.test(document.getElementById('message').textContent));
      assert.equal(test.plays.length,2,'strict quality never retries with video transcoding');
      await test.page.locator('#stop').click();await test.page.locator('#diagnostics-toggle').click();
      const diagnostics=await test.page.locator('#playback-diagnostics').innerText();
      assert.match(diagnostics,/3840x2160.*hevc.*yuv420p10le.*HDR10/);
      assert.match(diagnostics,/25 Mbps/);assert.match(diagnostics,/Seneste afspilningsfejl/);
      assert.ok(!diagnostics.includes(origin)&&!diagnostics.includes('ticket-'),'diagnostics omit media URLs and tickets');
      if(quality==='original') {const out=path.resolve(__dirname,'../test-results');fs.mkdirSync(out,{recursive:true});await test.page.screenshot({path:path.join(out,'06-playback-diagnostics.png'),fullPage:true});}
      await test.close();
      const blocked=await fixture(browser,{transcodePlan:true});await blocked.start(quality);
      await blocked.page.waitForFunction(()=>/Original video kunne ikke bevares|4K kunne ikke leveres/.test(document.getElementById('message').textContent));
      assert.equal(blocked.plays.length,0,'strict quality rejects a transcoding preflight before creating a session');
      await blocked.close();
    }
    console.log('PASS Original/4K: video-preserving retry, failed remux stops, preflight blocks transcoding, useful private diagnostics');
    const unexpected=await fixture(browser,{transcodeResult:true});await unexpected.start('original');
    await unexpected.page.waitForFunction(()=>document.getElementById('message').textContent.includes('Serveren forsøgte videokonvertering'));
    assert.ok(unexpected.calls.some(call=>call.path==='/tv-api/streams/stream-1'&&call.method==='DELETE'));
    assert.ok(unexpected.calls.some(call=>call.path==='/tv-api/media/revoke'),'unexpected transcoding revokes the media ticket');
    assert.equal(await unexpected.page.locator('#video').getAttribute('data-test-source'),null,'unexpected transcoded result is not assigned to player');
    await unexpected.close();
    const old=await fixture(browser,{oldServer:true,container:'matroska'});await old.start('original');
    await old.page.waitForFunction(()=>document.getElementById('message').textContent.includes('serveren skal opdateres'));
    assert.equal(old.plays.length,0,'old server cannot create incompatible HEVC Direct Stream');await old.close();
    console.log('PASS incompatible server: HEVC/fMP4 feature guard and disposal of an unexpected transcoded result');
    for(const container of ['mp4','matroska']) {
      const test=await fixture(browser,{container});await test.start('auto');await test.loaded(1);
      await test.fail();await test.loaded(2);assertStages(test.plays,'auto');
      await test.fail();await test.loaded(3);
      assert.equal(test.plays.length,3);assert.equal(test.plays[2].quality,'auto');assert.equal(test.plays[2].hevc_output,true);
      assert.equal(test.plays[2].direct,false);assert.equal(test.plays[2].video_copy,false);assert.equal(test.plays[2].audio_copy,false);
      assert.deepEqual(test.calls.filter(call=>/\/(plan|play)$/.test(call.path)).slice(-6).map(call=>call.path.split('/').at(-1)),['plan','play','plan','play','plan','play'],'each recovery stage has preflight before playback');
      await test.fail();await test.page.waitForFunction(()=>document.getElementById('message').textContent.includes('Den konverterede video kunne ikke afspilles'));
      assert.equal(test.plays.length,3,'failed transcoding does not create an endless recovery loop');await test.close();
    }
    console.log('PASS Auto: Direct Play/copied-audio Direct Stream → AAC remux preserving video → 4K HEVC transcode; bounded retries');
    const pending=await fixture(browser,{holdPlan:true});await pending.start('original');
    await pending.planStarted;
    assert.equal(pending.pendingPlan,true);await pending.page.locator('#stop').click();
    const response=pending.page.waitForResponse(res=>res.url().endsWith('/plan'));
    pending.releasePlan();await response;await pending.page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal(pending.plays.length,0,'closing during preflight prevents playback session creation');
    assert.equal(await pending.page.locator('#player').isHidden(),true);await pending.close();
    console.log('PASS cancellation: closing a pending playback plan creates no /play request or session');
    const buffering=await fixture(browser);await buffering.start('1080');await buffering.loaded(1);
    await buffering.page.locator('#video').evaluate(video=>{
      Object.defineProperty(video,'buffered',{configurable:true,value:{length:1,start:()=>0,end:()=>8}});
      video.currentTime=6;
      video.getVideoPlaybackQuality=()=>({droppedVideoFrames:4,totalVideoFrames:120});
      video.dispatchEvent(new Event('waiting'));video.dispatchEvent(new Event('stalled'));
    });
    await buffering.page.waitForFunction(()=>document.getElementById('playback-diagnostics').textContent.includes('0.75x'));
    await buffering.page.locator('#stop').click();await buffering.page.locator('#diagnostics-toggle').click();
    const measured=await buffering.page.locator('#playback-diagnostics').innerText();
    assert.match(measured,/Buffer: 2.0 s/);assert.match(measured,/Vent på data: 1/);
    assert.match(measured,/Tabte billeder: 4\/120/);assert.match(measured,/0.75x/);
    assert.match(measured,/langsommere end afspilningen/);
    assert.equal(buffering.plays.length,1,'buffer stalls never restart or switch the stream');
    await buffering.close();
    console.log('PASS buffering diagnostics: server speed, client buffer, dropped frames, no stream restart, retained after Stop');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
