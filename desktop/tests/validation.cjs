const {test} = require('node:test');
const assert = require('node:assert/strict');
const {serverUrl, selection, mediaUrl} = require('../validation.cjs');
test('only explicit HTTP origins can become trusted servers', () => {
  assert.equal(serverUrl('http://192.168.1.10:8090/'),'http://192.168.1.10:8090');
  for (const url of ['file:///C:/test','https://user:pass@host','https://host/path','https://host/?x=1']) assert.throws(()=>serverUrl(url));
});
test('renderer cannot inject player options or arbitrary paths', () => {
  assert.throws(()=>selection({id:'--script=bad',start:0}));
  assert.throws(()=>selection({id:'a'.repeat(32),start:NaN}));
  assert.throws(()=>selection({id:'a'.repeat(32),start:0,audio_track:'--help'}));
  assert.equal(selection({id:'a'.repeat(32),start:12}).start,12);
});
test('player only accepts scoped HTTP media addresses', () => {
  const route='/media/'+'a'.repeat(43)+'/movies/'+'b'.repeat(32)+'/file';
  assert.equal(mediaUrl(route,'https://server'),'https://server'+route);
  for (const url of ['file:///movie.mkv','https://host/playlist.m3u8','av://x','https://u:p@host'+route]) assert.throws(()=>mediaUrl(url,'https://server'));
});
