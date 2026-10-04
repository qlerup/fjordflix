const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(fetch) {
  let deadline, cleared = false;
  const context = {module:{exports:{}}, AbortController, fetch,
    document:{createElement:()=>({})},
    setTimeout(fn, ms) { assert.equal(ms, 90000); deadline = fn; return 1; },
    clearTimeout() { cleared = true; }};
  vm.runInNewContext(fs.readFileSync('app/static/tracks.js', 'utf8'), context);
  const tracks = context.module.exports;
  tracks.movie = {id:'sample',tracks:{subtitles:[]}};
  return {tracks, expire:()=>deadline(), cleared:()=>cleared};
}
const selection = {subtitle_track:1,subtitle_delivery:'text',offset:0};
function untilAborted(signal) {
  return new Promise((_, reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
}
for (const phase of ['headers','body']) test(`a stalled subtitle ${phase} request stops with a visible error`, async()=>{
  const s = setup((url,{signal})=>phase === 'headers' ? untilAborted(signal) :
    Promise.resolve({ok:true,blob:()=>untilAborted(signal)}));
  const pending = s.tracks.attach(selection);
  await new Promise(setImmediate);
  if (phase === 'body') assert.match(s.tracks.statusLabel(),/modtager tekst/);
  s.expire();
  await assert.rejects(pending,/90 sekunder/);
  assert.match(s.tracks.statusLabel(),/intet fuldt svar/);
  assert.equal(s.cleared(),true);
});
test('leaving playback cancels extraction without reporting a timeout',async()=>{
  const s = setup((url,{signal})=>untilAborted(signal));
  const pending = s.tracks.attach(selection);
  s.tracks.clear();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(s.tracks.statusLabel(),'');
  assert.equal(s.cleared(),true);
});
test('a preparation exception after a successful fetch cannot leave fetching status',async()=>{
  const s = setup(async()=>({ok:true,blob:async()=>({})}));
  await assert.rejects(s.tracks.attach(selection));
  assert.match(s.tracks.statusLabel(),/blev hentet, men kunne ikke klargøres/);
  assert.equal(s.cleared(),true);
});
