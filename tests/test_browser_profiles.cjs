const {test} = require('node:test');
const assert = require('node:assert/strict');
const {detect} = require('../app/static/browser-profiles.js');
const buffer = require('../app/static/browser-buffer.js');
const capabilities = require('../app/static/browser-capabilities.js');
const ua = userAgent => ({navigator:{userAgent}});

for (const [agent, id, engine] of [
  ['Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36', 'chrome-desktop', 'chromium'],
  ['Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 Edg/130.0', 'edge-desktop', 'chromium'],
  ['Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 OPR/115.0', 'opera-desktop', 'chromium'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'firefox-desktop', 'gecko'],
  ['Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'safari-desktop', 'webkit'],
  ['Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1', 'chrome-ios', 'webkit'],
  ['Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/130.0 Mobile/15E148 Safari/604.1', 'firefox-ios', 'webkit'],
  ['Mozilla/5.0 (iPad) AppleWebKit/605.1.15 EdgiOS/130.0 Mobile/15E148 Safari/604.1', 'edge-ios', 'webkit'],
  ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36 EdgA/130.0', 'edge-android', 'chromium'],
  ['Mozilla/5.0 (Linux; Android 14) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36', 'samsung-android', 'chromium'],
  ['Mozilla/5.0 Chrome/70.0 Safari/537.36 Edge/18.0', 'edge-desktop', 'edgehtml'],
  ['', 'unknown-desktop', 'unknown']
]) {
  test(`detects ${id} / ${engine} without confusing embedded browser tokens`, () => {
    const p = detect(ua(agent));
    assert.equal(p.id, id); assert.equal(p.engine, engine);
  });
}

test('Client Hints identify Edge before the Chrome compatibility token', () => {
  const p = detect({navigator:{userAgent:'Chrome/130.0 Safari/537.36', userAgentData:{brands:[
    {brand:'Not A Brand',version:'99'}, {brand:'Chromium',version:'130'}, {brand:'Microsoft Edge',version:'131'}
  ]}}});
  assert.equal(p.id,'edge-desktop'); assert.equal(p.major,131);
});

test('a generic Chromium brand does not claim the verified Google Chrome profile', () => {
  const p=detect({navigator:{userAgent:'Chrome/130.0 Safari/537.36',userAgentData:{brands:[
    {brand:'Not A Brand',version:'99'}, {brand:'Chromium',version:'130'}
  ]}}});
  assert.equal(p.id,'chromium-desktop'); assert.equal(p.hdrToSdr,false);
});

test('iPad desktop UA and mobile Chrome never inherit desktop tone mapping', () => {
  const p = detect({navigator:{userAgent:'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15',maxTouchPoints:5}});
  assert.equal(p.id,'safari-ios'); assert.equal(p.hdrToSdr,false);
  for (const agent of ['Chrome/130.0 Mobile Android', 'CriOS/130.0 iPhone', 'FxiOS/130.0 iPad', 'Chrome/130.0 Edg/120.0'])
    assert.equal(detect(ua(agent)).hdrToSdr,false);
  assert.equal(detect(ua('CriOS/130.0 iPhone')).buffer.forwardMiB,48);
  for (const agent of ['Chrome/130.0', 'Chrome/130.0 Edg/121.0'])
    assert.equal(detect(ua(agent)).hdrToSdr,true);
});

test('profiles select independent buffer policies; Chrome keeps the verified limits', () => {
  const chrome=detect(ua('Chrome/130.0')), safari=detect(ua('Version/18.0 Safari/605.1.15'));
  const c=buffer.config(60,68.1,false,chrome), s=buffer.config(60,68.1,false,safari);
  assert.equal(c.maxBufferLength,7); assert.equal(c.backBufferLength,3);
  assert.equal(s.maxBufferLength,5); assert.equal(s.backBufferLength,1);
  safari.buffer.forwardMiB=1;
  assert.equal(detect(ua('Chrome/130.0')).buffer.forwardMiB,64);
  assert.equal(detect(ua('Version/18.0 Safari/605.1.15')).buffer.forwardMiB,48);
});

test('desktop and TV clients do not receive browser buffer settings', () => {
  for (const env of [{...ua('Chrome/130.0'),fjordDesktop:{}}, ua('Chrome/130.0 Xbox'),ua('Web0S Chrome/90.0'),ua('Tizen Chrome/90.0')]) {
    const p=detect(env); assert.equal(p.external,true);
    assert.deepEqual(buffer.config(120,68.1,false,p),{startPosition:0,maxBufferLength:120,backBufferLength:30});
  }
});

test('a named profile cannot override a rejected codec and appears in diagnostics', async () => {
  const movie={id:'profile-test',format:'mp4',video:'h264',audio:'aac',pix_fmt:'yuv420p',width:3840,height:2160,bitrate:68000000};
  for (const agent of ['Chrome/130.0', 'Chrome/130.0 Edg/130.0', 'Firefox/130.0', 'Version/18.0 Safari/605.1.15']) {
    const env={...ua(agent),MediaSource:{isTypeSupported:()=>true},matchMedia:()=>({matches:true})};
    env.navigator.mediaCapabilities={decodingInfo:async()=>({supported:false,smooth:false})};
    const api=capabilities.create(env);
    const result=await api.detect(movie,{video:{canPlayType:()=> 'probably'}});
    assert.equal(result.direct,false); assert.equal(result.video_copy,false);
    assert.ok(api.describe(movie).includes(detect(env).id));
  }
});

test('desktop app retains its existing HDR prediction independently of browser profiles', async () => {
  const env={...ua('Chrome/130.0'),fjordDesktop:{},MediaSource:{isTypeSupported:()=>true},matchMedia:()=>({matches:false})};
  env.navigator.mediaCapabilities={decodingInfo:async()=>({supported:true,smooth:true})};
  const api=capabilities.create(env);
  const result=await api.detect({id:'desktop',format:'matroska',video:'hevc',pix_fmt:'yuv420p10le',hdr:true,
    width:3840,height:2160,quality:{dynamic_range:'HDR10'}},{video:{canPlayType:()=> 'probably'}});
  assert.equal(result.video_copy,true);
});
