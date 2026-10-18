/* Full shared UI + synthetic 2018 AVPlay. Never contacts a real TV/server. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {pathToFileURL} = require('node:url');
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  const errors=[],requests=[],plays=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    localStorage.setItem('fjordflix.connection',JSON.stringify({server:'https://samsung.test',token:'t'.repeat(43)}));
    let state='NONE',time=0,listener;
    window.nativeCalls=[];
    window.nativeTick=ms=>{time=ms;listener.oncurrentplaytime(ms);};
    window.tizen={tvinputdevice:{registerKey:key=>nativeCalls.push(['key',key])},application:{getCurrentApplication:()=>({exit:()=>nativeCalls.push(['exit'])})}};
    window.webapis={
      productinfo:{isUdPanelSupported:()=>true,getModel:()=>'2018 UHD fixture'},avinfo:{isHdrTvSupport:()=>true},
      appcommon:{AppCommonScreenSaverState:{SCREEN_SAVER_ON:1,SCREEN_SAVER_OFF:0},setScreenSaver:value=>nativeCalls.push(['screensaver',value])},
      avplay:{
        getState:()=>state,open:url=>{state='IDLE';time=0;nativeCalls.push(['open',url]);},close:()=>{state='NONE';nativeCalls.push(['close']);},
        stop:()=>{state='IDLE';nativeCalls.push(['stop']);},setDisplayRect:()=>{},setDisplayMethod:()=>{},setSilentSubtitle:()=>{},
        setListener:value=>{listener=value;},prepareAsync:ready=>setTimeout(()=>{state='READY';ready();},5),
        getDuration:()=>3600000,getCurrentTime:()=>time,
        getCurrentStreamInfo:()=>[{type:'VIDEO',extra_info:'{"Width":"3840","Height":"2160"}'}],
        play:()=>{state='PLAYING';nativeCalls.push(['play']);},pause:()=>{state='PAUSED';nativeCalls.push(['pause']);},
        seekTo:(at,done)=>{time=at;nativeCalls.push(['seek',at]);setTimeout(done,1);}
      }
    };
  });
  const movie={id:'native',title:'Samsung 4K-test',width:3840,height:2160,duration:3600,position:120,video:'hevc',audio:'dts',format:'matroska',pix_fmt:'yuv420p10le',bitrate:25e6,
    quality:{dynamic_range:'HDR10',frame_rate:'24/1',video_level:153},tracks:{audio:[{index:1,codec:'dts',default:true}],subtitles:[{index:2,language:'Dansk',codec:'subrip',delivery:'text'}]}};
  const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type'};
  await page.route('https://samsung.test/**',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;requests.push([req.method(),p]);
    const json=value=>route.fulfill({headers,contentType:'application/json',body:JSON.stringify(value)});
    if(req.method()==='OPTIONS')return json({});
    if(p==='/tv-api/info')return json({features:[]});
    if(p.startsWith('/tv-media/'))return route.fulfill({status:404,headers});
    assert.equal(req.headers().authorization,'Bearer '+'t'.repeat(43),p);
    if(p==='/tv-api/state')return json({user:{name:'Samsung test',role:'admin'}});
    if(p==='/tv-api/movies')return json([movie]);
    if(p.endsWith('/tracks'))return json(movie.tracks);
    if(p.endsWith('/plan'))return json({mode:'Direct Stream',width:3840,height:2160,reason:'Video bevares; lyd tilpasses',dynamic_range:'HDR10'});
    if(p.endsWith('/play')){plays.push(req.postDataJSON());return json({mode:'Direct Stream',height:2160,width:3840,url:'https://samsung.test/tv-media/ticket/streams/stream/index.m3u8',session:'stream',offset:120,media_ticket:'ticket',subtitle_delivery:'text',dynamic_range:'HDR10'});}
    if(p.endsWith('.vtt'))return route.fulfill({headers,contentType:'text/vtt',body:'WEBVTT\n\n00:02:02.000 --> 00:02:05.000\n<b>Hej fra Samsung</b>\n'});
    if(p.endsWith('/poster')||p.endsWith('/backdrop'))return route.fulfill({headers,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'});
    return json({ok:true});
  });
  try {
    await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
    // Chromium does not read Tizen config.xml; enforce its policy for the blob VTT path.
    const policy=fs.readFileSync(path.resolve(__dirname,'../app/config.xml'),'utf8').match(/<tizen:content-security-policy>([^<]+)</)[1];
    await page.evaluate(value=>{const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=value;document.head.appendChild(meta);},policy);
    await page.locator('#recent-grid .card').first().click();
    await page.click('#subtitle-toggle');
    await page.locator('[data-subtitle="2"]').click();
    await page.click('#play');
    await page.waitForFunction(()=>nativeCalls.some(c=>c[0]==='play'));
    await page.waitForFunction(()=>document.getElementById('samsung-subtitles'));
    await page.waitForTimeout(100);
    await page.evaluate(()=>nativeTick(3000));
    await page.waitForFunction(()=>document.getElementById('samsung-subtitles').textContent==='Hej fra Samsung');
    assert.equal(plays[0].video_copy,true);assert.equal(plays[0].audio_copy,false);assert.equal(plays[0].start,120);
    assert.ok((await page.locator('#play-status').textContent()).includes('4K'));
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:10252,bubbles:true})));
    assert.ok(await page.evaluate(()=>nativeCalls.some(c=>c[0]==='pause')));
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:10252,bubbles:true})));
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:10009,bubbles:true})));
    await page.waitForFunction(()=>document.getElementById('player').hidden);
    await page.waitForFunction(()=>!document.getElementById('detail').hidden);
    assert.ok(requests.some(([method,p])=>method==='DELETE'&&p==='/tv-api/streams/stream'));
    assert.ok(requests.some(([,p])=>p==='/tv-api/media/revoke'));
    assert.equal(await page.locator('#samsung-subtitles').textContent(),'');
    await page.click('#subtitle-toggle');
    await page.locator('[data-subtitle="off"]').focus();
    await page.evaluate(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{keyCode:10009,bubbles:true})));
    assert.equal(await page.locator('#subtitle-options').isVisible(),false);
    assert.equal(await page.locator('#detail').isVisible(),true);
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:10009,bubbles:true})));
    await page.waitForFunction(()=>document.getElementById('detail').hidden);
    fs.mkdirSync(path.resolve(__dirname,'../test-results'),{recursive:true});
    await page.screenshot({path:path.resolve(__dirname,'../test-results/samsung-home-1080p.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS Samsung native UI: 4K/HDR10 video preservation, DTS conversion, offset VTT, media keys, Return, close/revoke.');
  } catch(e) {console.error({requests,plays,native:await page.evaluate(()=>window.nativeCalls),message:await page.locator('#message').textContent(),status:await page.locator('#play-status').textContent(),subtitles:await page.locator('#samsung-subtitles').textContent(),errors});throw e;} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
