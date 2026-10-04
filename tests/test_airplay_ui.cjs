const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const movie = {id:'a'.repeat(32),title:'AirPlay test',duration:120,position:0,width:1280,height:720,
  video:'h264',audio:'aac',format:'mp4',pix_fmt:'yuv420p',bitrate:1000000,
  tracks:{version:1,audio:[{index:1,codec:'aac',language:'eng',default:true},{index:2,codec:'aac',language:'dan'}],
    subtitles:[{index:3,codec:'subrip',language:'dan',delivery:'text'}]}};
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function until(check) { for(let i=0;i<100;i++){if(check())return;await tick();} throw Error('UI did not settle'); }
function setup(safari, transcode = false) {
  const html=fs.readFileSync('app/static/index.html','utf8');
  const dom=new JSDOM(html,{url:'http://fjord.test/',runScripts:'outside-only'}), w=dom.window, calls=[];
  w.matchMedia=()=>({matches:false,addEventListener(){}});
  w.scrollTo=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))};
  w.HTMLMediaElement.prototype.canPlayType=type=>type.includes('mpegurl')?(safari?'probably':''):'probably';
  w.HTMLMediaElement.prototype.load=function(){};
  w.HTMLMediaElement.prototype.pause=function(){};
  w.HTMLMediaElement.prototype.play=async function(){};
  Object.defineProperty(w.HTMLMediaElement.prototype,'currentSrc',{get(){return this.src}});
  const textTracks = [];
  const trackEvents = new w.EventTarget();
  textTracks.addEventListener = trackEvents.addEventListener.bind(trackEvents);
  textTracks.removeEventListener = trackEvents.removeEventListener.bind(trackEvents);
  Object.defineProperty(w.HTMLMediaElement.prototype,'textTracks',{get(){return textTracks}});
  w.addNativeTrack = track => {textTracks.push(track);trackEvents.dispatchEvent(new w.Event('addtrack'));};
  if(safari)w.HTMLMediaElement.prototype.webkitShowPlaybackTargetPicker=function(){w.pickerCalls=(w.pickerCalls||0)+1};
  w.fetch=async(path,options={})=>{
    const data=options.body?JSON.parse(options.body):undefined;
    calls.push({path,method:options.method||'GET',data});
    let result={};
    if(path==='/api/state')result={user:{id:'owner',name:'Tester',admin:false},managed:false};
    else if(path==='/api/movies')result=[movie];
    else if(path.endsWith('/tracks'))result=movie.tracks;
    else if(path.endsWith('/plan'))result={mode:'Direct Stream',height:720,mbps:1,reason:'Test'};
    else if(path.endsWith('/play'))result={mode:transcode?'Transcoding':'Direct Stream',height:720,mbps:1,encoder:'AAC',session:'s1',offset:data.start,
      url:'http://fjord.test/media/test/streams/s1/index.m3u8',media_ticket:'t'.repeat(43),airplay:data.airplay,
      subtitle_delivery:data.subtitle_track===null?null:data.burn_subtitles?'burn':'hls',subtitle_track:data.subtitle_track};
    return {ok:true,json:async()=>result};
  };
  const scripts=[...html.matchAll(/<script defer src="\/static\/([^"?]+)(?:\?[^\"]*)?"/g)].map(m=>fs.readFileSync('app/static/'+m[1],'utf8'));
  w.eval(scripts.join('\n')+'\nwindow.testApi={openDetail,playFromDetail,capabilities,closePlayer,get playback(){return playback},get switching(){return switching},get hls(){return hls},get tracks(){return FjordTracks}};');
  return {dom,w,calls,api:w.testApi};
}
test('AirPlay uses native HLS and carries selected tracks through changes and background lifecycle',async()=>{
  const {dom,w,calls,api}=setup(true);
  try {
    await tick();await tick();
    await api.openDetail(movie);
    api.tracks.audio=2;api.tracks.subtitle=3;api.tracks.sync();
    api.playFromDetail(0);
    await until(()=>api.playback&&!api.switching);
    const v=w.document.getElementById('video'),button=w.document.getElementById('player-airplay');
    v.dispatchEvent(new w.Event('loadedmetadata'));
    assert.equal(button.hidden,false);assert.equal(button.disabled,false);
    assert.equal(api.hls,undefined);assert.match(v.src,/\/media\/test\//);
    assert.equal(w.document.querySelector('script[src="/static/vendor/hls.min.js"]'),null);
    let play=calls.filter(c=>c.path.endsWith('/play')).at(-1).data;
    assert.equal(play.audio_track,2);assert.equal(play.subtitle_track,3);assert.equal(play.airplay,true);
    assert.equal(play.burn_subtitles,false);
    const native={label:'FjordFlix',mode:'disabled'};
    w.addNativeTrack(native);
    assert.equal(native.mode,'showing');
    assert.equal(v.querySelector('track'),null); // HLS rendition, no browser-only blob.
    const fallback=w.document.getElementById('player-burn-subtitles');
    assert.equal(fallback.parentElement.hidden,false);
    fallback.checked=true;await fallback.onchange();
    assert.equal(calls.filter(c=>c.path.endsWith('/play')).at(-1).data.burn_subtitles,true);
    assert.equal(native.mode,'disabled');
    fallback.checked=false;await fallback.onchange();
    assert.equal(calls.filter(c=>c.path.endsWith('/play')).at(-1).data.burn_subtitles,false);
    v.dispatchEvent(new w.Event('loadedmetadata'));
    assert.equal(native.mode,'showing');
    button.click();assert.equal(w.pickerCalls,1);
    v.webkitCurrentPlaybackTargetIsWireless=true;
    v.dispatchEvent(new w.Event('webkitcurrentplaybacktargetiswirelesschanged'));
    assert.equal(button.getAttribute('aria-pressed'),'true');
    const deletes=calls.filter(c=>c.method==='DELETE').length;
    w.dispatchEvent(new w.Event('pagehide'));await tick();
    assert.equal(calls.filter(c=>c.method==='DELETE').length,deletes);
    v.currentTime=25;
    const subtitles=w.document.getElementById('player-subtitle');subtitles.value='';await subtitles.onchange();
    play=calls.filter(c=>c.path.endsWith('/play')).at(-1).data;
    assert.equal(play.subtitle_track,null);assert.equal(play.audio_track,2);assert.equal(play.start,25);
    await api.closePlayer();
    assert.equal(api.playback,null);
    assert.ok(calls.some(c=>c.path==='/api/media/revoke'));
    assert.ok(calls.some(c=>c.method==='DELETE'));
  }finally{dom.window.close()}
});

test('decoder recovery keeps the current transcode and fails visibly on a second error',async()=>{
  const {dom,w,calls,api}=setup(false,true);
  try {
    // Modern Chrome advertises native HLS without exposing AirPlay.
    w.HTMLMediaElement.prototype.canPlayType=()=> 'maybe';
    class Hls {
      static Events={ERROR:'error',FRAG_LOADED:'frag'};
      static ErrorTypes={MEDIA_ERROR:'media'};
      static isSupported(){return true}
      handlers={}; recoveries=0;
      on(event,callback){this.handlers[event]=callback}
      loadSource(){} attachMedia(){} destroy(){}
      recoverMediaError(){this.recoveries++}
    }
    w.Hls=Hls;
    await tick();await tick();await api.openDetail(movie);
    api.playFromDetail(30);await until(()=>api.playback&&!api.switching);
    const v=w.document.getElementById('video'), hls=api.hls;
    assert.ok(hls,'Chrome uses HLS.js even when native HLS is advertised');
    assert.match(api.playback.infoText,/HLS.js/);
    v.currentTime=5;
    Object.defineProperty(v,'error',{value:{code:3},writable:true,configurable:true});
    v.dispatchEvent(new w.Event('error'));
    hls.handlers.error('error',{fatal:true,type:'media',details:'bufferAppendError'});
    assert.equal(hls.recoveries,1);
    assert.equal(calls.filter(c=>c.path.endsWith('/play')).length,1);
    assert.equal(v.currentTime,5);
    assert.equal(w.document.getElementById('player-error').textContent,'');
    v.error=null;v.dispatchEvent(new w.Event('playing'));
    v.error={code:3};v.dispatchEvent(new w.Event('error'));
    assert.equal(hls.recoveries,1);
    assert.match(w.document.getElementById('player-error').textContent,/kode 3/);
  }finally{dom.window.close()}
});
test('browsers without AirPlay keep their existing playback choices',async()=>{
  const {dom,w,api}=setup(false);
  try {
    await tick();await tick();
    assert.equal(w.document.getElementById('player-airplay').hidden,true);
    assert.equal((await api.capabilities(movie,'original')).airplay,false);
  }finally{dom.window.close()}
});
