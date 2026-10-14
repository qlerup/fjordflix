const {test} = require('node:test');
const assert = require('node:assert/strict');
const buffer = require('../app/static/browser-buffer.js');
const profiles = require('../app/static/browser-profiles.js');
const chrome = profiles.detect({navigator:{userAgent:'Chrome/130.0.0.0'}});
const config = (seconds, mbps, desktop = false) => buffer.config(seconds, mbps, desktop, chrome);

test('4K remux stays within a byte budget even with a long user preference', () => {
  for (const requested of [30, 60, 120]) {
    const c = config(requested, 68.1);
    assert.equal(c.maxBufferLength, 7);
    assert.equal(c.maxMaxBufferLength, 7); // HLS must not grow past this by size.
    assert.equal(c.backBufferLength, 3);
    assert.ok((c.maxBufferLength + c.backBufferLength) * 68.1e6 / 8 < 96 * 1024 ** 2);
  }
});

test('lower bitrate respects the requested buffer until the memory budget binds', () => {
  assert.equal(config(30, 8).maxBufferLength, 30);
  assert.equal(config(60, 8).maxBufferLength, 60);
  assert.equal(config(120, 8).maxBufferLength, 67);
  assert.equal(config(120, 3).maxBufferLength, 120);
});

test('missing bitrate and extreme values produce valid bounded HLS options', () => {
  for (const mbps of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(config(60, mbps).maxBufferLength, 60);
  }
  assert.equal(config(5, 8).maxBufferLength, 60);
  const c = config(120, 1000);
  assert.equal(c.maxBufferLength, 1);
  assert.equal(c.backBufferLength, 0);
});

test('desktop keeps its existing configuration', () => {
  assert.deepEqual(config(120, 68.1, true), {
    startPosition:0, maxBufferLength:120, backBufferLength:30
  });
});

test('changing the preference while playing cannot remove the bitrate cap', () => {
  const active = {...config(30, 68.1), unrelated:true};
  Object.assign(active, config(120, 68.1));
  assert.equal(active.maxBufferLength, 7);
  assert.equal(active.maxMaxBufferLength, 7);
  assert.equal(active.unrelated, true);
});
