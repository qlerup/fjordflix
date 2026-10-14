const {test} = require('node:test');
const assert = require('node:assert/strict');
const prefetch = require('../app/static/browser-prefetch.js');
const profiles = require('../app/static/browser-profiles.js');
function setup() {
  const requests = [], events = {};
  class Base {
    constructor(settings) { this.settings=settings; this.stats={loading:{start:0},aborted:false}; }
    load(context,config,callbacks) { this.context=context; this.callbacks=callbacks; this.stats.loading.start=1; requests.push(this); }
    destroy() { this.destroyed=true; this.callbacks=null; }
    abort() { this.stats.aborted=true; this.callbacks?.onAbort?.(this.stats,this.context,null); }
    success(bytes=10) {
      this.stats.loading.end=500; this.stats.loaded=bytes;
      this.callbacks?.onSuccess({data:new ArrayBuffer(bytes),url:this.context.url},this.stats,this.context,{});
    }
    error() { this.callbacks?.onError({code:503},this.context,{},this.stats); }
  }
  const Hls={DefaultConfig:{loader:Base},Events:{DESTROYING:'destroy'}};
  const profile=profiles.detect({navigator:{userAgent:'Firefox/158.0'}});
  const fragments=Array.from({length:4},(_,sn)=>({sn,url:`https://example.test/${sn}`,level:0,type:'main'}));
  const helper=prefetch.create(Hls,profile);
  helper.attach({levels:[{details:{fragments}}],on:(name,cb)=>events[name]=cb});
  const demand=(sn,callbacks={})=>{
    const loader=new helper.Loader({});
    loader.load({url:fragments[sn].url,frag:fragments[sn],part:null,rangeEnd:0},{timeout:10000},{onSuccess:()=>{},...callbacks});
    return loader;
  };
  return {requests,events,demand,Hls,fragments};
}
test('only the desktop Firefox profile enables segment prefetch',()=>{
  const {Hls}=setup();
  for (const agent of ['Chrome/155.0','Chrome/155.0 Edg/155.0','Version/18.0 Safari/605.1','Firefox/158.0 Android Mobile','FxiOS/158.0 iPhone','Xbox Firefox/158.0'])
    assert.equal(prefetch.create(Hls,profiles.detect({navigator:{userAgent:agent}})),null);
  assert.equal(prefetch.create(Hls,{id:'firefox-desktop',external:true,prefetchMiB:32}),null);
});
test('reuses an in-flight next segment, keeps real timings and correct demand context',()=>{
  const {requests,demand,fragments}=setup(); let success;
  const first=demand(0); assert.equal(requests.length,2);
  first.success(); first.destroy();
  const second=demand(1,{onSuccess:(response,stats,context)=>success={stats,context}});
  assert.equal(requests.filter(r=>r.context.url===fragments[1].url).length,1);
  assert.equal(requests.length,3); // One new next segment; no unbounded chain.
  requests.find(r=>r.context.url===fragments[1].url).success();
  assert.equal(success.context.frag,fragments[1]);
  assert.equal(success.stats,second.stats); assert.equal(second.stats.loading.end,500);
});
test('completed prefetch is reused once without duplicating a network request',async()=>{
  const {requests,demand}=setup(); let completed=0;
  const first=demand(0); requests[0].success(); first.success();
  demand(1,{onSuccess:()=>completed++}); await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(completed,1); assert.equal(requests.length,3);
});
test('seek abandons the queued URL and starts only the requested segment and its next',()=>{
  const {requests,demand}=setup(); demand(0);
  const queued=requests[0]; demand(3);
  assert.equal(queued.destroyed,true); assert.equal(requests.length,3);
  assert.equal(requests[2].context.frag.sn,3);
});
test('failed prefetch becomes an ordinary demand request with visible HLS errors',async()=>{
  const {requests,demand}=setup(); let error;
  demand(0); requests[0].error();
  demand(1,{onError:e=>error=e});
  await new Promise(resolve=>queueMicrotask(resolve));
  const fallback=requests.at(-1); assert.equal(fallback.context.frag.sn,1);
  fallback.error(); assert.equal(error.code,503);
});
test('aborting a claimed prefetch rejects it once and cancels the next request',()=>{
  const {requests,demand}=setup(); let aborts=0;
  const first=demand(0); first.success();
  const consumer=demand(1,{onAbort:()=>aborts++}); consumer.abort();
  assert.equal(aborts,1); assert.equal(consumer.stats.aborted,true);
  assert.equal(requests[0].destroyed,true); assert.equal(requests[2].destroyed,true);
  requests[0].success(); assert.equal(aborts,1);
});
test('closing HLS cancels claimed and queued requests without late callbacks',()=>{
  const {requests,demand,events}=setup(); let completed=0;
  const first=demand(0); first.success(); demand(1,{onSuccess:()=>completed++});
  events.destroy(); requests[0].success();
  assert.equal(completed,0); assert.equal(requests[0].destroyed,true); assert.equal(requests[2].destroyed,true);
});
test('known oversized responses stop before retaining more than the profile budget',async()=>{
  const {requests,demand}=setup(); demand(0);
  let progress; const queued=requests[0];
  await queued.settings.xhrSetup({addEventListener:(name,cb)=>{if(name==='progress')progress=cb;}},queued.context.url);
  progress({loaded:65536,lengthComputable:true,total:33*1024**2});
  assert.equal(queued.stats.aborted,true);
  demand(1); await new Promise(resolve=>queueMicrotask(resolve)); assert.equal(requests.at(-1).context.frag.sn,1);
});
test('oversized Content-Length aborts at headers and cannot trigger multiple fallbacks',async()=>{
  const {requests,demand}=setup(); demand(0); const callbacks={}; const queued=requests[0];
  await queued.settings.xhrSetup({readyState:2,getResponseHeader:()=>String(33*1024**2),
    addEventListener:(name,cb)=>callbacks[name]=cb},queued.context.url);
  callbacks.readystatechange(); callbacks.progress({loaded:34*1024**2});
  demand(1); await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(requests.filter(r=>r.context.frag.sn===1).length,2); // Failed prefetch plus one normal demand.
});
test('encrypted and range segments do not start speculative downloads',()=>{
  for (const value of [{decryptdata:{method:'AES-128'}},{byteRangeEndOffset:500},{gap:true}]) {
    const {requests,demand,fragments}=setup(); Object.assign(fragments[1],value); demand(0);
    assert.equal(requests.length,1);
  }
});
