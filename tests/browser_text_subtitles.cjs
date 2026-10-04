// Real Chrome/WebVTT rendering through the production subtitle attachment code.
const {chromium}=require('playwright');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), assert=require('node:assert/strict');
(async()=>{
  const folder=path.resolve('test-results/text-subtitles');fs.mkdirSync(folder,{recursive:true});
  const ffmpeg=process.env.FFMPEG || 'ffmpeg';
  const run=args=>{const r=spawnSync(ffmpeg,['-v','error','-y',...args],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
  fs.writeFileSync(path.join(folder,'text.srt'),'1\n00:00:01,000 --> 00:00:06,000\nHej med dig! Æ, ø og å.\n');
  run(['-f','lavfi','-i','color=c=blue:s=640x360:r=24:d=8','-i',path.join(folder,'text.srt'),'-map','0:v','-map','1:s','-c:v','libx264','-preset','ultrafast','-g','48','-c:s','srt',path.join(folder,'source.mkv')]);
  run(['-i',path.join(folder,'source.mkv'),'-map','0:1','-c:s','webvtt','-f','webvtt',path.join(folder,'text.vtt')]);
  run(['-i',path.join(folder,'source.mkv'),'-map','0:v','-c:v','copy','-f','hls','-hls_time','2','-hls_list_size','0',path.join(folder,'index.m3u8')]);
  run(['-ss','3','-i',path.join(folder,'source.mkv'),'-map','0:v','-c:v','libx264','-g','48','-f','hls','-hls_time','2','-hls_list_size','0',path.join(folder,'resume.m3u8')]);
  const hls=process.env.HLS_JS;
  assert.ok(hls,'Set HLS_JS to the deployed hls.min.js');
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname;
    if(name==='/'){res.setHeader('Content-Type','text/html');return res.end('<video id="video" muted controls width="640"></video><script>var video=document.getElementById("video");var toast=message=>window.failure=message;</script>');}
    const file=name==='/hls.js'?hls:name.endsWith('.vtt')?path.join(folder,'text.vtt'):path.join(folder,path.basename(name));
    if(!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.vtt')?'text/vtt':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for (const offset of [0, 3]) {
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    let subtitleRequests = 0;
    await page.route('**/subtitles/*.vtt*', route => {
      subtitleRequests++;
      const complete = subtitleRequests >= 3;
      route.fulfill({status:200,contentType:'text/vtt',headers:{'X-Subtitle-Complete':complete?'1':'0'},
        body:fs.readFileSync(path.join(folder,'text.vtt'),'utf8') + (complete ? '\n00:00:07.000 --> 00:00:08.000\nLater cue\n\n' : '')});
    });
    await page.addScriptTag({url:'/hls.js'});
    await page.addScriptTag({path:path.resolve('app/static/tracks.js')});
    await page.evaluate(async(offset)=>{
      FjordTracks.movie={id:'test',tracks:{subtitles:[{index:1,codec:'subrip',language:'dan'}]}};
      FjordTracks.subtitle=1;
      window.hls=new Hls({startPosition:0});
      hls.loadSource(offset ? '/resume.m3u8' : '/index.m3u8');hls.attachMedia(video);
      video.onloadedmetadata=()=>video.play();
      await FjordTracks.attach({subtitle_delivery:'text',subtitle_track:1,offset});
    }, offset);
    await page.waitForFunction(()=>video.currentTime>2,{},{timeout:15000});
    const state=await page.evaluate(()=>({error:window.failure,tracks:Array.from(video.textTracks,t=>({mode:t.mode,cues:t.cues?.length,active:Array.from(t.activeCues||[],c=>c.text)}))}));
    console.log(JSON.stringify(state));
    assert.equal(state.error,undefined);
    assert.ok(state.tracks.some(t=>t.mode==='showing'&&t.active.includes('Hej med dig! Æ, ø og å.')));
    assert.match(await page.evaluate(()=>FjordTracks.statusLabel()), /1 tekstlinjer · 1 aktive · showing/);
    await page.screenshot({path:path.join(folder,`visible-${offset}.png`)});
    await page.waitForFunction(()=>FjordTracks.subtitleStatus.complete && FjordTracks.element.track.cues.length===2);
    assert.equal(subtitleRequests,3,'Progressive extraction stops polling when complete');
    assert.equal(await page.evaluate(()=>video.querySelectorAll('track').length),1);
    await page.route('**/subtitles/*.vtt*', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Extraction timed out'})}));
    const failed = await page.evaluate(async()=>{
      try { await FjordTracks.attach({subtitle_delivery:'text',subtitle_track:1,offset:0}); }
      catch (error) { return {message:error.message, status:FjordTracks.statusLabel()}; }
    });
    assert.equal(failed.message,'Extraction timed out');
    assert.match(failed.status,/HTTP 503/);
    assert.equal(await page.evaluate(()=>{FjordTracks.clear();return FjordTracks.statusLabel();}),'');
    await page.close();
    console.log(`PASS real Chrome displays embedded SUBRIP over HLS, resume offset ${offset}`);
    }
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
