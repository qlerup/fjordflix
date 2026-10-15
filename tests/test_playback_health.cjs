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

test('recent frame losses exclude old startup losses and reset around waiting or seek', () => {
  const v=video();v.readyState=4;v.playbackRate=1;
  let time=0,total=1000,dropped=200;
  v.getVideoPlaybackQuality=()=>({totalVideoFrames:total,droppedVideoFrames:dropped});
  const monitor=health.create(v,()=>time);
  monitor.label();
  time=2000;v.currentTime+=2;total+=48;
  assert.match(monitor.label(),/Seneste 2\.0 s: 0\/48 tabte \(0\.0 %\)/);
  time=4000;v.currentTime+=2;total+=48;dropped+=12;
  assert.match(monitor.label(),/12\/48 tabte \(25\.0 %\)/);
  monitor.waiting();
  assert.equal(monitor.snapshot().recentFrames,null);
  monitor.label();
  time=6000;v.currentTime+=60;total+=48;dropped+=48;
  assert.doesNotMatch(monitor.label(),/Seneste/);
  v.paused=true;
  monitor.label();
  assert.equal(monitor.snapshot().recentFrames,null);
});

test('counter resets and suspended timers do not report ongoing frame loss', () => {
  const v=video();v.readyState=4;
  let time=0,total=200,dropped=50;
  v.getVideoPlaybackQuality=()=>({totalVideoFrames:total,droppedVideoFrames:dropped});
  const monitor=health.create(v,()=>time);
  monitor.label();time=2000;v.currentTime+=2;total=48;dropped=0;
  assert.doesNotMatch(monitor.label(),/Seneste/);
  time=22000;v.currentTime+=2;total+=48;dropped+=1;
  assert.doesNotMatch(monitor.label(),/Seneste/);
  delete v.getVideoPlaybackQuality;
  monitor.label();
  assert.equal(monitor.snapshot().recentFrames,null);
});

test('iPhone reports frozen pictures only when the audio clock advances without presented frames', () => {
  let time = 0, frames = 5;
  const v = video(); v.readyState = 4; v.videoWidth = 1920; v.videoHeight = 1080;
  v.getVideoPlaybackQuality = () => ({totalVideoFrames:frames,droppedVideoFrames:0});
  const monitor = health.create(v, () => time, true);
  assert.equal(monitor.frozenFrame(), false);
  for (let i=0;i<2;i++) {
    time+=2000;v.currentTime+=2;
    assert.equal(monitor.frozenFrame(),false);
  }
  time+=2000;v.currentTime+=2;
  assert.equal(monitor.frozenFrame(),true,'audio advanced six seconds while the picture froze');
  frames+=48;time+=2000;v.currentTime+=2;
  assert.equal(monitor.frozenFrame(),false,'new pictures reset the freeze window');
  v.paused=true;time+=2000;v.currentTime+=2;
  assert.equal(monitor.frozenFrame(),false,'pause clears the watchdog');
  v.paused=false;time+=2000;v.currentTime+=2;
  assert.equal(monitor.frozenFrame(),false,'resumed playback gets a new baseline');
  v.seeking=true;assert.equal(monitor.frozenFrame(),false);
  v.seeking=false;
  assert.equal(monitor.frozenFrame(false),false,'AirPlay and inactive playback never trigger');
  monitor.close();
});

test('iPhone tracks presented frames where Safari exposes frame callbacks', () => {
  let time=0, request=0, callback, cancelled=null;
  const v = video();v.readyState=4;v.videoWidth=1920;v.videoHeight=1080;
  v.requestVideoFrameCallback = cb => { callback=cb; return ++request; };
  v.cancelVideoFrameCallback = id => {cancelled=id;};
  const monitor = health.create(v,()=>time,true);
  assert.equal(request,1);
  assert.equal(monitor.frozenFrame(),false);
  time=2000;v.currentTime+=2;callback();
  assert.equal(monitor.frozenFrame(),false);
  time=4000;v.currentTime+=2;assert.equal(monitor.frozenFrame(),false);
  time=6000;v.currentTime+=2;assert.equal(monitor.frozenFrame(),false);
  time=8000;v.currentTime+=2;assert.equal(monitor.frozenFrame(),true,'six seconds without a presented frame');
  time=10000;v.currentTime+=2;assert.equal(monitor.frozenFrame(),true);
  monitor.close();assert.equal(cancelled,request);
});
