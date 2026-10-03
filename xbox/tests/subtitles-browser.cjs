const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1920,height:1080}});
  const errors=[], plans=[], plays=[]; let subtitleRequests=0;
  page.on('pageerror', e=>errors.push(e.message));
  // Silent local PCM audio supplies a real media timeline without FFmpeg.
  const wav=Buffer.alloc(44+16000*4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
  const movie={id:'subtest',title:'Underteksttest',height:1080,width:1920,duration:60,position:0,video:'h264',audio:'aac',format:'mp4',pix_fmt:'yuv420p',hdr:false,
    tracks:{audio:[],subtitles:[{index:2,language:'Dansk',codec:'subrip',delivery:'text'}, {index:3,language:'Engelsk',codec:'hdmv_pgs_subtitle',delivery:'burn'}]}};
  for (let i=4;i<37;i++) movie.tracks.subtitles.push({index:i,language:'Spor '+i,delivery:'burn'});
  const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type'};
  await page.addInitScript(()=>{
    localStorage.setItem('fjordflix.connection',JSON.stringify({server:'https://subtitle.test',token:'t'.repeat(43)}));
    const original=HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'probably':original.call(this,type);};
  });
  await page.route('https://subtitle.test/**',async route=>{
    const req=route.request(), url=new URL(req.url());
    const json=value=>route.fulfill({headers,contentType:'application/json',body:JSON.stringify(value)});
    if(req.method()==='OPTIONS') return json({});
    if(url.pathname==='/media.wav') return route.fulfill({headers,contentType:'audio/wav',body:wav});
    if(url.pathname.endsWith('.vtt')) {
      subtitleRequests++;
      assert.equal(req.headers().authorization,'Bearer '+'t'.repeat(43));
      return route.fulfill({headers,contentType:'text/vtt',body:'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEarlier\n\n00:00:11.000 --> 00:00:13.000\nHej fra FjordFlix\n'});
    }
    if(url.pathname.endsWith('/state')) return json({user:{name:'Tester'}});
    if(url.pathname.endsWith('/movies')) return json([movie]);
    if(url.pathname.endsWith('/plan')) { const data=req.postDataJSON();plans.push(data);return json({mode:data.subtitle_track===3?'Transcoding':'Direct Play',height:1080}); }
    if(url.pathname.endsWith('/play')) { const data=req.postDataJSON();plays.push(data);return json({mode:'Direct Stream',session:'fixture',offset:10,height:1080,url:'https://subtitle.test/media.wav',subtitle_track:data.subtitle_track,subtitle_delivery:data.subtitle_track===2?'text':null}); }
    if(url.pathname.endsWith('/poster')||url.pathname.endsWith('/backdrop')) return route.fulfill({status:404,headers});
    return json({ok:true});
  });
  try {
    await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
    await page.locator('.card').click();
    const controller=code=>page.evaluate(code=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{keyCode:code,bubbles:true,cancelable:true})),code);
    // Navigate from the actual playback buttons, without mouse/focus shortcuts.
    for(const width of [1920,1280,900]) {
      await page.setViewportSize({width,height:1080});
      await page.locator('#play').focus();
      await controller(204);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'subtitle-toggle','Down must reach the wide subtitle control');
      await controller(204);
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-quality')),'auto');
      await controller(203);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'subtitle-toggle');
      await controller(195);
      await controller(204);
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-subtitle')),'2');
      await controller(196);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'subtitle-toggle');
      await controller(203);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'play');
    }
    await page.setViewportSize({width:1920,height:1080});
    await page.locator('#play').focus();
    await controller(213);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'favorite','Stick right must move right');
    await controller(214);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'play','Stick left must move left');
    assert.equal(await page.locator('[data-subtitle="off"]').getAttribute('aria-pressed'),'true');
    await page.locator('#subtitle-toggle').focus();
    assert.equal(await page.locator('#subtitle-options').isVisible(),false);
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('#subtitle-options').evaluate(el=>el.scrollHeight>el.clientHeight && el.clientHeight<=330));
    await page.keyboard.press('End');
    assert.equal(await page.locator('[data-subtitle="36"]').evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{keyCode:461,bubbles:true})));
    assert.equal(await page.locator('#subtitle-options').isVisible(),false);
    assert.equal(await page.locator('#detail').isVisible(),true);
    assert.equal(await page.locator('[data-subtitle="off"]').getAttribute('aria-selected'),'true');

    await page.locator('#subtitle-toggle').click();
    await page.locator('[data-subtitle="3"]').click();
    await page.waitForFunction(()=>document.getElementById('quality-plan').textContent.includes('Transcoding'));
    assert.equal(plans.at(-1).subtitle_track,3);
    assert.equal(await page.locator('#subtitle-options').isVisible(),false);
    assert.equal(await page.locator('#subtitle-toggle').evaluate(el=>el===document.activeElement),true);
    await page.locator('#subtitle-toggle').press('Enter');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('[data-subtitle="2"]').evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#detail').isVisible(),true);
    assert.equal(await page.locator('#subtitle-options').isVisible(),false);

    await page.locator('#subtitle-toggle').click();
    await page.locator('[data-subtitle="2"]').click();
    await page.waitForFunction(()=>document.getElementById('quality-plan').textContent.includes('Direct Play'));
    await page.locator('#play').click();
    await page.waitForFunction(()=>{
      const track=document.querySelector('video track');
      return track && track.track.mode==='showing' && track.track.cues.length===1;
    });
    assert.equal(plays[0].subtitle_track,2);
    assert.equal(subtitleRequests,1);
    assert.deepEqual(await page.locator('video track').evaluate(el=>[el.track.cues[0].startTime,el.track.cues[0].endTime,el.track.cues[0].text]),[1,3,'Hej fra FjordFlix']);
    await page.locator('#stop').click();
    assert.equal(await page.locator('video track').count(),0);
    assert.equal(await page.locator('[data-subtitle="2"]').getAttribute('aria-pressed'),'true');
    await page.locator('#subtitle-toggle').click();
    await page.locator('[data-subtitle="off"]').click();
    await page.locator('#play').click();
    await page.waitForFunction(()=>document.getElementById('video').readyState>=1);
    assert.equal(plays.at(-1).subtitle_track,null);
    assert.equal(subtitleRequests,1);
    assert.equal(await page.locator('video track').count(),0);
    assert.deepEqual(errors,[]);
    console.log('Subtitle browser flow passed: tracks, plan, authenticated VTT, offset, cleanup, remembered selection and off.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
