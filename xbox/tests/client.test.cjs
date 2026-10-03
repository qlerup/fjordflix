const test = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../tv/capabilities.js');
const {actionForKey} = require('../tv/xbox-platform.js');
const normalize = require('../app/server-url.js');
const movie = {width:1920,height:1080,video:'h264',audio:'aac',format:'mp4',pix_fmt:'yuv420p',quality:{frame_rate:'30/1',dynamic_range:'SDR',video_level:41}};
const supported = {canPlayType:()=> 'probably'};
function nativeDetect(result, fail) {
  const vm = require('node:vm'), fs = require('node:fs');
  const queries = [], warnings = [];
  const context = {console:{warn:message=>warnings.push(message)},Windows:{Media:{Protection:{
    ProtectionCapabilityResult:{probably:2,maybe:1,notSupported:0},
    ProtectionCapabilities:function () { this.isTypeSupported=(type,system)=>{
      queries.push({type,system});
      if (fail) throw new Error('Native query unavailable');
      return result;
    }; }
  }}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../tv/capabilities.js'),'utf8'),context);
  return {detect:context.TVCapabilities,queries,warnings};
}
test('Xbox manifest enables the native 4K playback entitlement', () => {
  const manifest=require('node:fs').readFileSync(require('node:path').join(__dirname,'../app/AppxManifest.xml'),'utf8');
  assert.match(manifest,/xmlns:rescap="http:\/\/schemas.microsoft.com\/appx\/manifest\/foundation\/windows10\/restrictedcapabilities"/);
  assert.match(manifest,/<rescap:Capability Name="hevcPlayback"\s*\/>/);
});
test('common Xbox 1080p H.264/AAC can play directly', () => {
  const result = detect(movie,supported,'auto',false);
  assert.equal(result.direct,true); assert.equal(result.video_copy,true);
});
test('unsupported formats are converted without overriding explicit quality', () => {
  for (const changes of [{width:3840,height:2160},{pix_fmt:'yuv420p10le'},
    {hdr:true,quality:{}},{quality:{dynamic_range:'HDR10'}},{quality:{video_level:51}},{quality:{frame_rate:'120/1'}}]) {
    const result=detect({...movie,...changes},supported,'original',false);
    assert.equal(result.direct,false); assert.equal(result.video_copy,false); assert.equal(result.quality,'original');
  }
  assert.equal(detect(movie,supported,'2160',false).quality,'2160');
});
const uhd = {...movie,width:3840,height:2160,video:'hevc',pix_fmt:'yuv420p10le',hdr:true,
  quality:{frame_rate:'24/1',dynamic_range:'HDR10',video_level:153}};
const features = {features:['xbox-hdr10-base','xbox-hevc-transcode']};
test('Dolby Vision HDR10 base layers remux in 4K without copying unsupported Dolby metadata',()=>{
  for(const quality of [{dynamic_range:'Dolby Vision',dv_profile:7},{dynamic_range:'Dolby Vision',dv_profile:8,dv_bl_signal_compatibility_id:1}]) {
    const result=nativeDetect(2).detect({...uhd,quality,format:'matroska',audio:'truehd'},supported,'original',false,features);
    assert.equal(result.video_copy,true);assert.equal(result.hdr10_base,true);assert.equal(result.direct,false);assert.equal(result.audio_copy,false);
  }
  for(const profile of [5,8,null]) {
    const result=detect({...uhd,quality:{dynamic_range:'Dolby Vision',dv_profile:profile}},supported,'original',false,features);
    assert.equal(result.hdr10_base,false);assert.equal(result.video_copy,false);
  }
});

test('native Xbox requests the complete selected HD audio bitstream with the MKV server feature', () => {
  const native=nativeDetect(2), server={features:['xbox-matroska-audio','xbox-hdr10-base']};
  for (const codec of ['truehd','dts']) {
    const source={...movie,format:'matroska',tracks:{audio:[{index:1,codec:'aac',default:true},{index:3,codec,channels:8}]}};
    const result=native.detect(source,supported,'original',false,server,3);
    assert.equal(result.audio_passthrough,true); assert.equal(result.audio_copy,true);
    assert.equal(result.audio_track,3); assert.equal(result.video_copy,true);
    assert.match(native.detect.diagnostics().audioTransport,/Original via MKV/);
    assert.equal(detect(source,supported,'original',false,server,3).audio_passthrough,false,'ordinary browser does not claim native HDMI support');
    assert.equal(native.detect(source,supported,'original',false,{features:[]},3).audio_passthrough,false);
    assert.equal(native.detect.diagnostics().requiresOriginalAudio,true,'old server must produce an update error before playback');
  }
});
test('4K conversion probes the output decoder and keeps Auto quality on a retry',()=>{
  const yes=nativeDetect(2).detect(uhd,supported,'auto',true,features);
  assert.equal(yes.hevc_output,true);assert.equal(yes.quality,'auto');assert.equal(yes.video_copy,false);
  const no=nativeDetect(0).detect(uhd,supported,'2160',true,features);
  assert.equal(no.hevc_output,false);assert.equal(no.quality,'2160');
});
test('4K HEVC HDR10 plays directly and original resolution is preserved', () => {
  for (const quality of ['auto','original','2160']) {
    const result=detect(uhd,supported,quality,false);
    assert.equal(result.direct,true); assert.equal(result.video_copy,true); assert.equal(result.quality,quality);
  }
});
test('native HEVC support preserves 4K when HTML HEVC codec queries are empty', () => {
  const native=nativeDetect(2);
  const player={canPlayType:type=>type.indexOf('audio/')===0?'probably':''};
  for(const quality of ['auto','original','2160']) {
    const result=native.detect({...uhd,bitrate:55000000},player,quality,false);
    assert.equal(result.direct,true);assert.equal(result.video_copy,true);assert.equal(result.quality,quality);
  }
  assert.match(native.queries[0].type,/decode-res-x=3840,decode-res-y=2160,decode-bitrate=55000,decode-fps=30,decode-bpc=10/);
  assert.equal(native.queries[0].system,'com.microsoft.playready.hardware');
  const remux=native.detect({...uhd,format:'matroska',audio:'truehd'},player,'original',false);
  assert.equal(remux.direct,false);assert.equal(remux.video_copy,true);assert.equal(remux.audio_copy,false);
});
test('negative or uncertain native decoder results never force 4K direct playback', () => {
  for(const answer of [0,1]) {
    const result=nativeDetect(answer).detect(uhd,supported,'original',false);
    assert.equal(result.video_copy,false);assert.equal(result.direct,false);
    assert.match(result.capability_reason,/hardwareafspilning/);
  }
});
test('native probe errors use HTML detection and emit a diagnostic', () => {
  const native=nativeDetect(0,true);
  assert.equal(native.detect(uhd,supported,'auto',false).direct,true);
  assert.equal(native.warnings.length,1);
  assert.equal(native.detect(uhd,{canPlayType:()=>''},'auto',false).video_copy,false);
});
test('native HEVC support does not override format limits or retry policy', () => {
  const native=nativeDetect(2);
  for(const changes of [{width:7680},{pix_fmt:'yuv444p10le'},{quality:{dynamic_range:'Dolby Vision'}},{quality:{frame_rate:'120/1'}}]) {
    assert.equal(native.detect({...uhd,...changes},supported,'original',false).video_copy,false);
  }
  assert.equal(native.queries.length,0);
  const retry=native.detect(uhd,supported,'original',true);
  assert.equal(retry.video_copy,false);assert.equal(retry.quality,'original');
});
test('4K MKV with unsupported sound preserves HEVC video during remux', () => {
  const result=detect({...uhd,format:'matroska',audio:'truehd'},supported,'auto',false);
  assert.equal(result.direct,false); assert.equal(result.video_copy,true); assert.equal(result.audio_copy,false);
});

test('a rejected original retries its container and audio while preserving HEVC video', () => {
  for (const quality of ['auto','original','2160']) {
    const native = nativeDetect(2);
    const result = native.detect(uhd, supported, quality, 'remux');
    assert.equal(result.client_profile, 'xbox');
    assert.equal(result.quality, quality);
    assert.equal(result.direct, false);
    assert.equal(result.audio_copy, false);
    assert.equal(result.video_copy, true);
    assert.equal(native.queries.length, 1);
    assert.equal(native.detect.diagnostics().native, 'Probably');
    assert.match(native.detect.diagnostics().source, /3840x2160.*hevc.*HDR10/);
  }
  assert.equal(nativeDetect(0).detect(uhd, supported, 'original', 'remux').video_copy, false);
});
test('4K player rejection does not falsely claim support or lower manual quality', () => {
  const rejected=detect(uhd,{canPlayType:()=>''},'original',false);
  assert.equal(rejected.direct,false); assert.equal(rejected.video_copy,false); assert.equal(rejected.quality,'original');
  for(const quality of ['original','2160']) {
    const result=detect(uhd,supported,quality,true);
    assert.equal(result.quality,quality); assert.equal(result.video_copy,false);
  }
});
test('MKV and unsupported selected audio preserve eligible video only', () => {
  assert.equal(detect({...movie,format:'matroska'},supported,'auto',false).direct,false);
  assert.equal(detect({...movie,format:'matroska'},supported,'auto',false).video_copy,true);
  const result=detect({...movie,tracks:{audio:[{index:1,codec:'aac',default:true},{index:2,codec:'dts'}]}},supported,'auto',false,null,2);
  assert.equal(result.direct,false); assert.equal(result.audio_copy,false); assert.equal(result.video_copy,true); assert.equal(result.audio_track,2);
});
test('fallback disables copying and browser rejection forces transcoding', () => {
  const result=detect(movie,supported,'auto',true);
  assert.equal(result.quality,'1080'); assert.equal(result.direct,false); assert.equal(result.audio_copy,false); assert.equal(result.video_copy,false);
  assert.equal(detect(movie,{canPlayType:()=>''},'auto',false).direct,false);
});
test('controller mapping matches Xbox VirtualKey values', () => {
  assert.equal(actionForKey(195),'select'); assert.equal(actionForKey(196),'back');
  assert.equal(actionForKey(197),'toggle'); assert.equal(actionForKey(199),'forward'); assert.equal(actionForKey(200),'rewind');
  assert.equal(actionForKey(203),'up'); assert.equal(actionForKey(214),'left'); assert.equal(actionForKey(213),'right'); assert.equal(actionForKey(65),undefined);
});
test('server address validation rejects executable schemes and credentials', () => {
  assert.equal(normalize('film.example.com',true),'https://film.example.com');
  assert.equal(normalize('192.168.1.20:8096',false),'http://192.168.1.20:8096');
  for(const address of ['javascript:alert(1)','https://user:pass@example.com','example.com/path']) assert.throws(()=>normalize(address));
});
