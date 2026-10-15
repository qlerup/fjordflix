const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('../test-results/dropdown-deps/node_modules/jsdom');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const dom=new JSDOM(fs.readFileSync('app/static/index.html','utf8'),{runScripts:'outside-only',url:'http://localhost'});
 const w=dom.window,requests=[],images=[];
 Object.assign(w,{$:id=>w.document.getElementById(id),selected:{id:'movie',duration:1000,title:'Test'},
  playback:{mode:'Transcoding',offset:0},switching:false,playGeneration:0,lastSaved:0,hls:null,
  airplaySupported:true,airplayActive:()=>false,matchMedia:()=>({matches:false}),clock:n=>String(Math.floor(n)),
  toast:()=>{},badge:()=>{},capabilities:async()=>({}),
  FjordLibrary:{artwork:()=>'/poster.jpg'},FjordTracks:{clear:()=>{},attach:async()=>{}},
  FjordPlaybackHealth:{create:()=>({})},
  Image:class{constructor(){images.push(this);}},
  api:async(url)=>url.endsWith('/play')?new Promise((resolve,reject)=>requests.push({resolve,reject})):{}
 });
 w.video=w.$('video');w.video.currentTime=80;
 Object.defineProperties(w.video,{readyState:{value:2,configurable:true},videoWidth:{value:960},videoHeight:{value:540}});
 w.video.pause=()=>{};
 w.video.load=()=>{w.video.currentTime=0;w.video.dispatchEvent(new w.Event('timeupdate'));};
 w.video.play=async()=>{};w.video.canPlayType=()=> 'maybe';
 w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:()=>{}});
 w.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,ZnJhbWU=';
 w.position=()=>w.video.currentTime+(w.playback?.offset||0);
 w.showPlayerError=message=>{w.$('player-error').textContent=message;};
 w.$('player-dialog').open=true;
 const source=fs.readFileSync('app/static/app.js','utf8');
 w.eval(source.slice(source.indexOf('async function release()'),source.indexOf('video.onplaying =')));
 w.eval(fs.readFileSync('app/static/player.js','utf8'));
 w.video.addEventListener('timeupdate',()=>w.updatePlayerTimeline());
 return {w,requests,images,close:()=>dom.window.close(),ready(offset){
  requests.shift().resolve({mode:'Transcoding',offset,session:'new',url:'/hls.m3u8'});
 }};
}
test('seek pins timeline through video reset and shows target preview until playback resumes',async()=>{
 const s=setup(),{w}=s;
 try{
  w.seekPlayer(300);await settle();
  assert.equal(w.$('timeline').value,'300');
  assert.equal(w.$('player-seek-preview').hidden,false);
  assert.match(w.$('player-seek-preview').src,/^data:image/);
  assert.match(s.images[0].src,/position=300$/);
  s.images[0].onload();assert.match(w.$('player-seek-preview').src,/position=300$/);
  s.ready(300);await settle();
  w.updatePlayerTimeline();assert.equal(w.$('timeline').value,'300');
  w.video.currentTime=1;w.video.dispatchEvent(new w.Event('playing'));
  assert.equal(w.$('player-seek-preview').hidden,true);
  assert.equal(w.$('timeline').value,'301');
  s.images[0].onload();assert.equal(w.$('player-seek-preview').hidden,true);
 }finally{s.close();}
});
test('native HLS timeline drift cannot leave a static preview over live video',async()=>{
 const s=setup(),{w}=s;
 try{
  w.seekPlayer(300);await settle();
  assert.equal(w.$('player-seek-preview').hidden,false);
  s.ready(300);await settle();
  // Native Safari HLS can begin at a nonzero PTS (or report a timestamp
  // different from the source movie timeline) despite decoding the new frame.
  w.video.currentTime=4;
  w.video.dispatchEvent(new w.Event('loadeddata'));
  assert.equal(w.$('player-seek-preview').hidden,true);
  assert.equal(w.$('timeline').value,'304');
  s.images[0].onload();
  assert.equal(w.$('player-seek-preview').hidden,true,'late image must not re-cover playback');
 }finally{s.close();}
});
test('repeated seeks retain newest target and ignore late preview responses',async()=>{
 const s=setup(),{w}=s;
 try{
  w.seekPlayer(300);await settle();w.seekPlayer(700);
  s.images[0].onload();assert.doesNotMatch(w.$('player-seek-preview').src,/position=300/);
  assert.equal(w.$('timeline').value,'700');
  s.ready(300);await settle();await settle();
  assert.equal(s.requests.length,1);assert.equal(w.$('timeline').value,'700');
  s.ready(700);await settle();
  w.video.currentTime=0;w.video.dispatchEvent(new w.Event('playing'));
  assert.equal(w.$('timeline').value,'700');assert.equal(w.$('player-seek-preview').hidden,true);
 }finally{s.close();}
});
test('direct seek and close clear preview; a failed restart can be retried',async()=>{
 const s=setup(),{w}=s;
 try{
  w.playback.mode='Direct Play';w.seekPlayer(150);
  assert.equal(w.video.currentTime,150);assert.equal(w.$('timeline').value,'150');
  w.video.dispatchEvent(new w.Event('seeked'));assert.equal(w.$('player-seek-preview').hidden,true);
  w.playback.mode='Transcoding';w.seekPlayer(300);await settle();
  s.requests.shift().reject(new Error('Offline'));await settle();
  assert.equal(w.$('timeline').value,'300');assert.match(w.$('player-error').textContent,/Offline/);
  w.seekPlayer(400);await settle();assert.equal(s.requests.length,1);
  s.ready(400);await settle();
  w.$('player-dialog').open=false;w.$('player-dialog').dispatchEvent(new w.Event('close'));
  s.images.at(-1).onload();assert.equal(w.$('player-seek-preview').hidden,true);
 }finally{s.close();}
});
