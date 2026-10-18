const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname,'..');
function fixture() {
  let state='NONE', time=0;
  const calls=[], preparations=[], requests=[];
  const overlay={textContent:'',hidden:true};
  const api={
    getState:()=>state,
    open:url=>{assert.equal(state,'NONE');calls.push(['open',url]);state='IDLE';},
    close:()=>{calls.push(['close']);state='NONE';},
    stop:()=>{calls.push(['stop']);state='IDLE';},
    setDisplayRect:(...args)=>calls.push(['rect',...args]),
    setDisplayMethod:()=>{},setSilentSubtitle:()=>{},
    setListener:listener=>{api.listener=listener;},
    prepareAsync:(success,failure)=>preparations.push({success:()=>{state='READY';success();},failure}),
    play:()=>{assert.ok(['READY','PLAYING','PAUSED'].includes(state));calls.push(['play']);state='PLAYING';},
    pause:()=>{assert.equal(state,'PLAYING');state='PAUSED';},
    getDuration:()=>180000,
    getCurrentStreamInfo:()=>{assert.equal(state,'PLAYING');return [{type:'VIDEO',extra_info:'{"Width":"3840","Height":"2160"}'}];},
    seekTo:(milliseconds,success)=>{assert.ok(['PLAYING','PAUSED'].includes(state));calls.push(['seek',milliseconds]);time=milliseconds;api.seekSuccess=success;},
    getCurrentTime:()=>time
  };
  const window={webapis:{avplay:api},SamsungPlatform:{screenSaver:value=>calls.push(['screensaver',value])}};
  class XHR {
    constructor(){requests.push(this);}
    open(method,url){this.url=url;}
    send(){}
    abort(){this.aborted=true;}
  }
  vm.runInNewContext(fs.readFileSync(path.join(root,'tv/samsung-player.js'),'utf8'),{window,document:{getElementById:()=>overlay},XMLHttpRequest:XHR,Promise});
  const host={style:{},canPlayType:()=>'',removeAttribute:()=>{}};
  return {player:window.SamsungVideo(host),api,calls,preparations,requests,overlay};
}
test('2018 AVPlay prepares, starts before resume-seek, reports decoder size, pauses and releases',async()=>{
  const f=fixture(), p=f.player;
  p.src='https://example.test/media';p.load();
  p.onloadedmetadata=()=>{p.currentTime=30;p.play();};
  f.preparations[0].success();
  assert.deepEqual(f.calls.filter(c=>['play','seek'].includes(c[0])),[['play'],['seek',30000]]);
  assert.equal(p.seeking,true);f.api.seekSuccess();assert.equal(p.currentTime,30);assert.equal(p.seeking,false);
  assert.equal(p.videoWidth,3840);assert.equal(p.videoHeight,2160);
  assert.equal(p.canPlayType('application/vnd.apple.mpegurl'),'probably');
  p.pause();assert.equal(p.paused,true);await p.play();assert.equal(p.paused,false);
  p.removeAttribute('src');p.load();assert.equal(p.readyState,0);assert.equal(p.paused,true);
  assert.ok(f.calls.some(c=>c[0]==='stop'));assert.ok(f.calls.some(c=>c[0]==='close'));
});
test('late native prepare/time/error callbacks cannot replace a newer playback',()=>{
  const f=fixture(),p=f.player;let loaded=0,errors=0;
  p.onloadedmetadata=()=>loaded++;p.onerror=()=>errors++;
  p.src='first';p.load();const old=f.api.listener;
  p.src='second';p.load();f.preparations[0].success();old.oncurrentplaytime(90000);old.onerror('STALE');
  assert.equal(loaded,0);assert.equal(p.currentTime,0);assert.equal(errors,0);
  f.preparations[1].success();assert.equal(loaded,1);
  f.api.listener.onerror('PLAYER_ERROR_CONNECTION_FAILED');assert.equal(errors,1);assert.equal(p.error.code,4);
});
test('native VTT cues honor offset, show plain text, clear on seek and discard removed tracks',()=>{
  const f=fixture(),p=f.player;p.src='media';p.load();f.preparations[0].success();
  const track=p.createSubtitleTrack();track.src='blob:subtitle';
  track.onload=()=>{for(const cue of track.track.cues){cue.startTime-=100;cue.endTime-=100;}track.track.mode='showing';};
  p.appendChild(track);
  const xhr=f.requests[0];xhr.status=200;xhr.responseText='WEBVTT\n\n00:02:00.000 --> 00:02:10.000\n<b>Hej &amp; farvel</b>\n';xhr.onload();
  f.api.listener.oncurrentplaytime(22000);assert.equal(f.overlay.textContent,'Hej & farvel');assert.equal(f.overlay.hidden,false);
  f.api.listener.oncurrentplaytime(40000);assert.equal(f.overlay.hidden,true);
  p.removeChild(track);assert.equal(xhr.aborted,true);xhr.onload();assert.equal(p.querySelectorAll('track').length,0);
});
test('platform uses numeric screensaver enums and tolerates missing media keys',()=>{
  const registered=[],screen=[];
  const window={confirm:()=>false,tizen:{tvinputdevice:{registerKey:key=>{registered.push(key);if(key==='MediaPlayPause')throw {name:'NotSupportedError'};}}},webapis:{avplay:{},productinfo:{isUdPanelSupported:()=>true,getModel:()=>'2018 test'},avinfo:{isHdrTvSupport:()=>true},appcommon:{AppCommonScreenSaverState:{SCREEN_SAVER_ON:1,SCREEN_SAVER_OFF:0},setScreenSaver:value=>screen.push(value)}}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'tv/samsung-platform.js'),'utf8'),{window});
  window.SamsungPlatform.screenSaver(false);window.SamsungPlatform.screenSaver(true);
  assert.deepEqual(screen,[0,1]);assert.ok(registered.includes('MediaPlay'));
  assert.equal(window.SamsungPlatform.device.uhd,true);assert.ok(window.SamsungPlatform.diagnostics().includes('MediaPlayPause'));
});
