const {test} = require('node:test');
const assert = require('node:assert/strict');
const buffer = require('../app/static/browser-buffer.js');

test('4K remux stays within a byte budget even with a long user preference', () => {
  for (const requested of [30, 60, 120]) {
    const c = buffer.config(requested, 68.1);
    assert.equal(c.maxBufferLength, 7);
    assert.equal(c.maxMaxBufferLength, 7); // HLS must not grow past this by size.
    assert.equal(c.backBufferLength, 3);
    assert.ok((c.maxBufferLength + c.backBufferLength) * 68.1e6 / 8 < 96 * 1024 ** 2);
  }
});

test('lower bitrate respects the requested buffer until the memory budget binds', () => {
  assert.equal(buffer.config(30, 8).maxBufferLength, 30);
  assert.equal(buffer.config(60, 8).maxBufferLength, 60);
  assert.equal(buffer.config(120, 8).maxBufferLength, 67);
  assert.equal(buffer.config(120, 3).maxBufferLength, 120);
});

test('missing bitrate and extreme values produce valid bounded HLS options', () => {
  for (const mbps of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(buffer.config(60, mbps).maxBufferLength, 60);
  }
  assert.equal(buffer.config(5, 8).maxBufferLength, 60);
  const c = buffer.config(120, 1000);
  assert.equal(c.maxBufferLength, 1);
  assert.equal(c.backBufferLength, 0);
});

test('desktop keeps its existing configuration', () => {
  assert.deepEqual(buffer.config(120, 68.1, true), {
    startPosition:0, maxBufferLength:120, backBufferLength:30
  });
});

test('changing the preference while playing cannot remove the bitrate cap', () => {
  const config = {...buffer.config(30, 68.1), unrelated:true};
  Object.assign(config, buffer.config(120, 68.1));
  assert.equal(config.maxBufferLength, 7);
  assert.equal(config.maxMaxBufferLength, 7);
  assert.equal(config.unrelated, true);
});
