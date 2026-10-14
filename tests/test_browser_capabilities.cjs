const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create, codecs, frameRate} = require('../app/static/browser-capabilities.js');
const movie = {id:'test',format:'mp4',video:'h264',audio:'aac',pix_fmt:'yuv420p',
  width:1920,height:1080,bitrate:15000000,quality:{video_profile:'High',video_level:41,frame_rate:'60000/1001'}};
const hevc = {...movie,format:'matroska',video:'hevc',pix_fmt:'yuv420p10le',width:3840,height:2160,
  quality:{video_profile:'Main 10',video_level:153,frame_rate:'24000/1001',dynamic_range:'HDR10'},hdr:true};
function setup(overrides = {}) {
  const calls = [];
  const env = {MediaSource:{isTypeSupported:()=>true},matchMedia:()=>({matches:true}),
    navigator:{mediaCapabilities:{decodingInfo:async c=>{calls.push(c);return {supported:true,smooth:true};}}},...overrides};
  return {api:create(env),calls,video:{canPlayType:()=> 'probably'}};
}
test('source H.264 profile, level and fractional frame rate are used',async()=>{
  const {api,calls,video}=setup();
  const result=await api.detect(movie,{video});
  assert.equal(result.direct,true);assert.equal(result.bandwidth,0);
  for(const c of calls.filter(c=>c.video)){
    assert.match(c.video.contentType,/avc1\.640029/);
    assert.equal(c.video.framerate,60000/1001);assert.equal(c.video.bitrate,movie.bitrate);
  }
  assert.deepEqual(codecs({...movie,quality:{video_profile:'Constrained Baseline',video_level:31}}),['avc1.42e01f']);
  for(const value of ['0/0','30/0','garbage','-20']) assert.equal(frameRate({...movie,quality:{frame_rate:value}}),24);
});
test('HEVC can negotiate hev1 when only that fMP4 entry is supported',async()=>{
  const {api,video}=setup({MediaSource:{isTypeSupported:t=>!t.includes('hvc1.')}});
  const result=await api.detect(hevc,{video});
  assert.equal(result.direct,false);assert.equal(result.video_copy,true);
  assert.equal(result.browser_fmp4,true);assert.equal(result.browser_hevc_tag,'hev1');
});
test('known HEVC file tag is tested independently of remux alternatives',async()=>{
  const {api}=setup();const video={canPlayType:t=>t.includes('hev1.')?'':'probably'};
  const result=await api.detect({...hevc,format:'mp4',quality:{...hevc.quality,video_codec_tag:'hev1'}},{video});
  assert.equal(result.direct,false);assert.equal(result.video_copy,true);
});
test('missing MediaCapabilities is unknown, not rejection, for SDR only',async()=>{
  const {api,video}=setup({navigator:{}});
  assert.equal((await api.detect({...hevc,hdr:false,quality:{dynamic_range:'SDR'}},{video})).video_copy,true);
  assert.equal((await api.detect(hevc,{video})).video_copy,false);
});
test('API errors and timeouts cannot hang playback or discard basic SDR support',async()=>{
  for(const decodingInfo of [async()=>{throw new TypeError('API unavailable');},()=>new Promise(()=>{})]){
    const {api,video}=setup({navigator:{mediaCapabilities:{decodingInfo}}});
    assert.equal((await api.detect(movie,{video})).direct,true);
  }
});
test('explicit rejection is respected even with Original selected',async()=>{
  const {api,video}=setup({navigator:{mediaCapabilities:{decodingInfo:async()=>({supported:false})}}});
  for(const quality of ['auto','original']){
    const result=await api.detect(movie,{video,quality});
    assert.equal(result.direct,false);assert.equal(result.video_copy,false);assert.equal(result.h264,false);
  }
});
test('Original may override a performance warning but Auto may not',async()=>{
  const {api,video}=setup({navigator:{mediaCapabilities:{decodingInfo:async()=>({supported:true,smooth:false})}}});
  assert.equal((await api.detect(movie,{video})).video_copy,false);
  assert.equal((await api.detect(movie,{video,quality:'original'})).video_copy,true);
});
test('H.264 High10 and unsupported chroma never enter the legacy copy path',async()=>{
  const {api,video}=setup();
  for(const pix_fmt of ['yuv420p10le','yuv422p','yuv444p']){
    const result=await api.detect({...movie,pix_fmt},{video});
    assert.equal(result.direct,false);assert.equal(result.video_copy,false);assert.equal(result.h264,false);
  }
});
test('selected surround audio is tested instead of the first track',async()=>{
  const {api,video,calls}=setup();
  const result=await api.detect({...hevc,tracks:{audio:[{index:1,codec:'truehd',channels:8},{index:2,codec:'eac3',channels:6}]}},
    {video,tracks:{audio_track:2}});
  assert.equal(result.audio_copy,true);assert.equal(result.audio_track,2);
  assert.ok(calls.some(c=>c.audio?.channels==='6'&&c.audio.contentType.includes('ec-3')));
});
test('unknown surround capability converts audio without discarding video',async()=>{
  const {api,video}=setup({navigator:{}});
  const result=await api.detect({...movie,tracks:{audio:[{index:2,codec:'aac',channels:6}]}},{video,tracks:{audio_track:2}});
  assert.equal(result.direct,false);assert.equal(result.video_copy,true);assert.equal(result.audio_copy,false);
});
test('native AirPlay retains its H.264 remux path, including MKV',async()=>{
  const {api,video}=setup();
  const result=await api.detect({...movie,format:'matroska'},{video,airplay:true});
  assert.equal(result.airplay,true);assert.equal(result.h264,true);
  assert.equal(result.browser_fmp4,false);assert.equal(result.audio_copy,false);
});
test('HDR Direct Play and remux require a confirmed display and decoder',async()=>{
  const yes=setup();
  assert.equal((await yes.api.detect({...hevc,format:'mp4'},{video:yes.video})).direct,true);
  const no=setup({matchMedia:()=>({matches:false})});
  const result=await no.api.detect(hevc,{video:no.video});
  assert.equal(result.direct,false);assert.equal(result.video_copy,false);
});

test('HDR video output can be confirmed independently of page output',async()=>{
  const {api,video}=setup({matchMedia:query=>({matches:query==='(video-dynamic-range: high)'})});
  const result=await api.detect(hevc,{video});
  assert.equal(result.video_copy,true);
  assert.match(api.describe(hevc),/video bekræftet · side ikke bekræftet/);
  const sdr=setup({matchMedia:()=>({matches:false})});
  const blocked=await sdr.api.detect(hevc,{video:sdr.video});
  assert.equal(blocked.video_copy,false);
  assert.equal(sdr.calls.filter(c=>c.video).length,0);
  assert.match(sdr.api.describe(hevc),/ikke testet: HDR-kontrollen blokerer/);
  assert.match(blocked.capability_reason,/HDR konverteres til SDR/);
});
test('Dolby Vision is never confused with a verified HDR10 base layer',async()=>{
  const {api,video}=setup();
  const base={...hevc,format:'mp4',quality:{...hevc.quality,dynamic_range:'Dolby Vision',dv_profile:7}};
  const ok=await api.detect(base,{video});
  assert.equal(ok.direct,false);assert.equal(ok.video_copy,true);assert.equal(ok.hdr10_base,true);
  for(const patch of [{dv_profile:5},{dv_profile:8},{dv_profile:7,dv_bl:false}]){
    const result=await api.detect({...base,quality:{...base.quality,...patch}},{video});
    assert.equal(result.direct,false);assert.equal(result.video_copy,false);
  }
});
test('AV1 and VP9 have independent fMP4 and bit depth checks',async()=>{
  const {api,video}=setup();
  for(const [codec,expected] of [['av1','av01.0.13M.10'],['vp9','vp09.02.51.10']]){
    const source={...movie,format:'matroska',video:codec,pix_fmt:'yuv420p10le',quality:{video_level:codec==='av1'?13:51}};
    assert.deepEqual(codecs(source),[expected]);assert.equal((await api.detect(source,{video})).video_copy,true);
  }
});
test('format fallback is bounded and never triggered by a network error',async()=>{
  const {api,video}=setup();
  assert.equal(api.noteFailure(movie,'Direct Play',2),false);
  assert.equal((await api.detect(movie,{video})).direct,true);
  assert.equal(api.noteFailure(movie,'Direct Play',4),true);
  let result=await api.detect(movie,{video});
  assert.equal(result.direct,false);assert.equal(result.video_copy,true);assert.equal(result.audio_copy,false);
  assert.equal(api.noteFailure(movie,'Direct Play',4),false);
  assert.equal(api.noteFailure(movie,'Direct Stream',3),true);
  result=await api.detect(movie,{video});
  assert.equal(result.direct,false);assert.equal(result.video_copy,false);assert.equal(result.h264,false);
  assert.equal(api.noteFailure(movie,'Direct Stream',3),false);
  assert.equal(api.noteFailure(movie,'Transcoding',3),false);assert.match(api.describe(movie),/hastighedstest/);
  assert.equal((await api.detect({...movie,id:'other'},{video})).direct,true);
});
test('cached answers are reused without mixing different film properties',async()=>{
  const {api,video,calls}=setup();
  await api.detect(movie,{video});const count=calls.length;
  await api.detect(movie,{video});assert.equal(calls.length,count);
  await api.detect({...movie,bitrate:50000000},{video});assert.ok(calls.length>count);
});
test('native HLS errors disable the legacy copy route too',async()=>{
  const {api,video}=setup();
  assert.equal(api.noteFailure(movie,'Direct Stream',3),true);
  const result=await api.detect(movie,{video,airplay:true});
  assert.equal(result.h264,false);assert.equal(result.video_copy,false);
});
test('no MSE support cannot authorize a browser remux',async()=>{
  const {api,video}=setup({MediaSource:undefined});
  assert.equal((await api.detect(movie,{video})).video_copy,false);
});
