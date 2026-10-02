const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
const code = source.slice(source.indexOf('async function capabilities('), source.indexOf('async function openDetail('));

test('browser network estimate must not force compatible video into transcoding', async () => {
  const context = vm.createContext({
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
