/* Playback orchestration checks with a deterministic simulated LG media element.
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
    video:'h264',audio:'aac',format:options.container||'mp4',pix_fmt:'yuv420p',bitrate:25000000,
    quality:{dynamic_range:'SDR',frame_rate:'24/1'},tracks:{audio:[],subtitles:[]},catalog:{overview:'Testfilm fra eget bibliotek.'}};
  if (options.hdAudio) {
    movie.audio='truehd'; movie.format='matroska';
    movie.tracks.audio=[{index:1,codec:'truehd',channels:8,default:true,language:'en'}];
  }
  const mode=request=>request.direct?'Direct Play':!request.video_copy||['1080','720','480'].includes(request.quality)?'Transcoding':'Direct Stream';
  await page.route(origin+'/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname;
    const reply=data=>route.fulfill({headers,contentType:'application/json',body:JSON.stringify(data)});
    if(req.method()==='OPTIONS') return reply({});
    calls.push({path:p,method:req.method()});
    if(p==='/tv-api/state') return reply({user:{name:'LG QA'}});
    if(p==='/tv-api/info') return reply({features:options.oldServer?[]:options.legacy?['xbox-hevc-fmp4']:['xbox-hevc-fmp4','xbox-hdr10-base','xbox-hevc-transcode','xbox-matroska-audio','trailer-stream-v1']});
    if(p==='/tv-api/movies') return reply([movie]);
    if(p.endsWith('/trailer')) return reply({trailer:{url:'https://www.youtube.com/watch?v=abcdefghijk'}});
    if(p.endsWith('/trailer/prepare')) return reply({status:options.pendingTrailer?'preparing':'ready'});
    if(p.endsWith('/trailer/play')) return reply({trailer:true,mode:'Trailer',session:null,media_ticket:'trailer-ticket',url:origin+'/trailer.mp4',height:720,offset:0});
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
        transport:request.audio_passthrough?'matroska':undefined,
        audio_output:request.audio_passthrough?{codec:'truehd',channels:8,copied:true}:undefined,
        media_ticket:'ticket-'+plays.length,url:origin+'/media-'+plays.length+'.mp4',height:delivery==='Transcoding'&&!request.hevc_output?1080:2160,video_codec:request.hevc_output&&!options.transcodeResult?'hevc':'h264',offset:delivery==='Direct Play'?0:request.start});
    }
    if(p.endsWith('/heartbeat') && p.includes('/streams/')) return reply({ok:true,transcoding:{speed:0.75,encoded_seconds:12,finished:false}});
    return reply({ok:true});
  });
  await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
  if (options.hdAudio) await page.evaluate(()=>{
    window.Windows={};
    HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'':'probably';};
  });
  await page.locator('.card').first().click();
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

(async()=>{const browser=await chromium.launch();try{
    const trailer=await fixture(browser);
    await trailer.page.locator('#trailer').click();
    await trailer.page.waitForFunction(()=>document.getElementById('video').dataset.testSource?.endsWith('/trailer.mp4'));
    await trailer.page.locator('#video').evaluate(video=>{
      Object.defineProperty(video,'duration',{configurable:true,value:150});
      video.currentTime=50;video.dispatchEvent(new Event('timeupdate'));
    });
    assert.equal(await trailer.page.locator('#timeline').innerText(),'0:50 / 2:30');
    await trailer.page.locator('#forward').click();
    assert.equal(await trailer.page.locator('#video').evaluate(video=>video.currentTime),80);
    await trailer.page.locator('#stop').click();
    assert.equal(trailer.calls.filter(call=>call.path.endsWith('/progress')).length,0,'trailer does not save movie progress');
    assert.equal(trailer.plays.length,0,'trailer does not start the movie');
    assert.ok(trailer.calls.some(call=>call.path==='/tv-api/media/revoke'));
    await trailer.start('original');await trailer.loaded(1);
    assert.equal(trailer.plays[0].start,120,'movie still resumes at its original saved position');
    await trailer.close();
    const preparing=await fixture(browser,{pendingTrailer:true});
    await preparing.page.locator('#trailer').click();
    await preparing.page.waitForFunction(()=>document.getElementById('play-status').textContent.includes('klar'));
    await preparing.page.locator('#stop').click();await preparing.page.waitForTimeout(1700);
    assert.ok(!preparing.calls.some(call=>call.path.endsWith('/trailer/play')),'closing stops preparation polling before playback');
    await preparing.close();
    console.log('PASS trailer stream: own timeline/seeking, revoke, cancellation and unchanged movie resume');

}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
