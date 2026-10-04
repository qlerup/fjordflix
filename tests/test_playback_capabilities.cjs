const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const FjordLibrary = require('../app/static/library-ui.js');
const source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
const code = source.slice(source.indexOf('async function capabilities('), source.indexOf('async function openDetail('));

test('browser network estimate must not force compatible video into transcoding', async () => {
  const context = vm.createContext({
    FjordLibrary,
    video: {canPlayType: () => 'probably'}, airplaySupported: false,
    navigator: {connection: {downlink: 5}, mediaCapabilities: {decodingInfo: async () => ({supported: true})}},
    FjordTracks: {request: () => ({audio_track: null, subtitle_track: null})},
  });
  vm.runInContext(code, context);
  const movie = {format:'mp4', video:'h264', audio:'aac', width:1920, height:1080,
    bitrate:20000000, pix_fmt:'yuv420p', hdr:false};
  const auto = await context.capabilities(movie, 'auto');
  assert.equal(auto.direct, true);
  assert.equal(auto.bandwidth, 0);
  assert.equal(auto.quality, 'auto');
  const manual = await context.capabilities(movie, '720');
  assert.equal(manual.quality, '720');
  const unsupported = await context.capabilities({...movie, pix_fmt:'yuv420p10le'}, 'auto');
  assert.equal(unsupported.direct, false);
});

test('HEVC Main10 HDR uses remux only with confirmed display and smooth MSE decoding', async () => {
  const probes = [];
  const context = vm.createContext({
    FjordLibrary,
    video:{canPlayType:() => 'maybe'}, airplaySupported:false,
    MediaSource:{isTypeSupported:() => true}, matchMedia:() => ({matches:true}),
    navigator:{mediaCapabilities:{decodingInfo:async config => {probes.push(config); return {supported:true,smooth:true};}}},
    FjordTracks:{request:() => ({})},
  });
  vm.runInContext(code, context);
  const movie = {format:'mkv',video:'hevc',audio:'truehd',width:3840,height:2160,bitrate:40000000,
    pix_fmt:'yuv420p10le',hdr:true,quality:{dynamic_range:'HDR10',frame_rate:'24000/1001',video_level:153}};
  const result = await context.capabilities(movie, 'original');
  assert.equal(result.direct,false);
  assert.equal(result.video_copy,true);
  assert.equal(probes.at(-1).video.transferFunction,'pq');
  assert.match(probes.at(-1).video.contentType,/hvc1\.2\.4/);
  context.matchMedia = () => ({matches:false});
  assert.equal((await context.capabilities(movie,'original')).video_copy,false);
  context.matchMedia = () => ({matches:true});
  for (const base of [{dv_profile:7}, {dv_profile:8,dv_bl_signal_compatibility_id:1}]) {
    const compatible = {...movie,quality:{...movie.quality,dynamic_range:'Dolby Vision',...base}};
    const remux = await context.capabilities(compatible,'original');
    assert.equal(remux.video_copy,true);
    assert.equal(remux.hdr10_base,true);
    assert.equal(probes.at(-1).video.transferFunction,'pq');
    context.matchMedia = () => ({matches:false});
    assert.equal((await context.capabilities(compatible,'original')).hdr10_base,false);
    context.matchMedia = () => ({matches:true});
  }
  for (const base of [{dv_profile:5},{dv_profile:8},{dv_profile:7,dv_bl:false}]) {
    const unsupported = await context.capabilities({...movie,quality:{dynamic_range:'Dolby Vision',...base}},'original');
    assert.equal(unsupported.hdr10_base,false);
    assert.equal(unsupported.video_copy,false);
  }
  assert.equal((await context.capabilities({...movie,quality:{dynamic_range:'Dolby Vision'}},'original')).video_copy,false);
  context.MediaSource.isTypeSupported = () => false;
  assert.equal((await context.capabilities(movie,'original')).video_copy,false);
});
