const {test} = require('node:test');
const assert = require('node:assert/strict');
const health = require('../app/static/playback-health.js');
function video(ranges = [[0,10],[15,30]]) {
  return {currentTime:8,paused:false,seeking:false,ended:false,
    buffered:{length:ranges.length,start:i=>ranges[i][0],end:i=>ranges[i][1]},
    getVideoPlaybackQuality:()=>({droppedVideoFrames:3,totalVideoFrames:200})};
}
test('buffer excludes unbuffered gaps and unavailable metrics are omitted', () => {
  const v = video(), monitor = health.create(v);
  assert.equal(monitor.snapshot().buffer,2);
  v.currentTime=12;
  assert.equal(monitor.snapshot().buffer,0);
  v.currentTime=20;
  assert.equal(monitor.snapshot().buffer,10);
  assert.match(monitor.label(), /Tabte billeder: 3\/200/);
  delete v.getVideoPlaybackQuality;
  assert.doesNotMatch(monitor.label(), /Tabte billeder/);
});
test('waiting excludes pauses, seeks, start and end', () => {
  const v = video(), monitor = health.create(v);
  for (const flag of ['paused','seeking','ended']) {v[flag]=true;monitor.waiting();v[flag]=false;}
  v.currentTime=0;monitor.waiting();v.currentTime=8;monitor.waiting();
  assert.equal(monitor.snapshot().waits,1);
});
test('download duration uses entire request and diagnostics exclude addresses', () => {
  const monitor = health.create(video());
  monitor.fragment({frag:{duration:2,stats:{loading:{start:100,first:400,end:800}}}});
  assert.deepEqual(monitor.snapshot().segment,{seconds:0.7,duration:2});
  monitor.fragment({frag:{duration:NaN}});
  monitor.error({details:'https://secret.test/media/private'});
  for (let i=0;i<15;i++) monitor.error({details:'fragLoadError',url:'private',fatal:false});
  assert.equal(monitor.snapshot().errors.length,10);
  assert.doesNotMatch(JSON.stringify(monitor.snapshot()),/private|secret/);
});
test('only decoder errors recover, at most once per playback', () => {
  const v=video(), monitor=health.create(v); let attempts=0;
  const hls={recoverMediaError:()=>attempts++};
  for(const code of [1,2,4]) {v.error={code};assert.equal(monitor.recoverDecode(hls),false);}
  v.error={code:3};
  assert.equal(monitor.recoverDecode(null),false);
  assert.equal(monitor.recoverDecode(hls),true);
  assert.equal(monitor.recoverDecode(hls),true); // DOM and HLS may report the same error.
  monitor.playing();
  v.error={code:3};
  assert.equal(monitor.recoverDecode(hls),false);
  assert.equal(attempts,1);
  assert.equal(v.currentTime,8);
  assert.match(health.mediaError(v.error),/afkode.*kode 3/);
  assert.equal(health.create(v).recoverDecode(hls),true);
});
