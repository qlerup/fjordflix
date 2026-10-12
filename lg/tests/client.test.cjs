const {test} = require('node:test');
const assert = require('node:assert/strict');
const normalize = require('../app/server-url.js');
const detect = require('../tv/capabilities.js');
const movie = {format:'mov,mp4,m4a,3gp,3g2,mj2',video:'h264',audio:'aac',pix_fmt:'yuv420p',hdr:false};
const supported = {canPlayType: () => 'probably'};
test('server address defaults to HTTPS except private IPs and rejects embedded credentials and paths', () => {
  assert.equal(normalize('192.168.1.20:8096'), 'http://192.168.1.20:8096');
  assert.equal(normalize('film.example.org'), 'https://film.example.org');
  assert.equal(normalize('http://[::1]:8096/'), 'http://[::1]:8096');
  for (const value of ['javascript:alert(1)','https://user:password@host','https://host/api','https://host?x=1','https://host:99999','https://host\\evil','']) assert.throws(() => normalize(value));
});
test('supported MP4 uses direct play, mismatched audio/container/pixels/HDR do not', () => {
  assert.equal(detect(movie,supported,'auto',false).direct,true);
  for (const patch of [{format:'matroska'},{hdr:true},{pix_fmt:'yuv420p10le'},{audio:'dts'},{video:'unknown'}]) assert.equal(detect({...movie,...patch},supported,'auto',false).direct,false);
  assert.equal(detect(movie,{canPlayType:()=>''},'auto',false).direct,false);
  assert.equal(detect(movie,{canPlayType:m=>m.startsWith('audio')?'':'probably'},'auto',false).direct,false);
});
test('HTTPS toggle selects protocol for domains, ports, IPs and pasted URLs', () => {
  assert.equal(normalize('film.gleruphub.dk',true),'https://film.gleruphub.dk');
  assert.equal(normalize('film.gleruphub.dk',false),'http://film.gleruphub.dk');
  assert.equal(normalize('10.10.0.100:8097',true),'https://10.10.0.100:8097');
  assert.equal(normalize('10.10.0.100:8097',false),'http://10.10.0.100:8097');
  assert.equal(normalize('http://film.gleruphub.dk/',true),'https://film.gleruphub.dk');
  assert.equal(normalize('https://film.gleruphub.dk/',false),'http://film.gleruphub.dk');
  assert.throws(()=>normalize('javascript:alert(1)',false));
});
test('failed direct play forces server transcoding, avoiding a remux retry loop', () => {
  assert.equal(detect(movie,supported,'2160',true).quality, '2160');
  assert.equal(detect(movie,supported,'auto',true).quality, '1080');
  const result = detect(movie,supported,'original',true);
  assert.equal(result.quality,'original'); assert.equal(result.direct,false); assert.equal(result.h264,false);
});
test('all TV JavaScript parses on ES5 engines', () => {
  const fs = require('node:fs'), path = require('node:path'), acorn = require('acorn');
  for (const folder of ['app','tv']) for (const file of fs.readdirSync(path.join(__dirname,'..',folder)).filter(x=>x.endsWith('.js'))) acorn.parse(fs.readFileSync(path.join(__dirname,'..',folder,file),'utf8'),{ecmaVersion:5});
});
const tv = {sdkVersion:'6.5.3', uhd:true, screenWidth:3840, screenHeight:2160, hdr10:true, dolbyVision:true};
const hdr = {...movie, width:3840, height:2160, video:'hevc', pix_fmt:'yuv420p10le', hdr:true, format:'matroska', bitrate:40000000, quality:{dynamic_range:'HDR10', frame_rate:'24/1'}};
test('actual TV flags allow HDR direct play and preserve video when only TrueHD is unsupported', () => {
  assert.equal(detect(hdr,supported,'original',false,tv).direct,true);
  const truehd=detect({...hdr,audio:'truehd'},supported,'original',false,tv);
  assert.equal(truehd.direct,false);assert.equal(truehd.video_copy,true);
  assert.equal(detect(hdr,supported,'original',false,{...tv,hdr10:false}).video_copy,false);
  assert.equal(detect({...hdr,bitrate:120000000},supported,'original',false,tv).video_copy,false);
});
test('LG remux retry keeps supported HEVC HDR video, full transcode remains explicit',()=>{
 const remux=detect(hdr,supported,'auto','remux',tv);
 assert.equal(remux.video_copy,true);assert.equal(remux.direct,false);assert.equal(remux.audio_copy,false);
 assert.equal(remux.quality,'auto');
 assert.equal(detect(hdr,supported,'auto',true,tv).video_copy,false);
});
test('Dolby Vision requires TV support, supported profile and container', () => {
  const dv={...hdr,format:'mp4',quality:{dynamic_range:'Dolby Vision',dv_profile:5,dv_el:false}};
  assert.equal(detect(dv,supported,'original',false,tv).direct,true);
  assert.equal(detect(dv,supported,'original',false,{...tv,dolbyVision:false}).direct,false);
  assert.equal(detect({...dv,quality:{...dv.quality,dv_profile:7,dv_el:true}},supported,'original',false,tv).direct,false);
});
test('audio selection changes compatibility without sacrificing supported HEVC video', () => {
  const film={...hdr,tracks:{audio:[{index:1,codec:'truehd',default:true},{index:2,codec:'ac3'}]}};
  const plan=detect(film,supported,'original',false,tv,2);
  assert.equal(plan.direct,true);assert.equal(plan.audio_copy,true);assert.equal(plan.audio_track,2);
  const fallback=detect(film,supported,'original',true,tv,2);
  assert.equal(fallback.direct,false);assert.equal(fallback.video_copy,false);
});
