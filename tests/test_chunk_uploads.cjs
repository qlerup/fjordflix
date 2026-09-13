const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createChunkUploader, UPLOAD_CHUNK_SIZE: size} = require('../app/static/uploads.js');

test('2 MB requests reconstruct the file and replay only an interrupted chunk', async () => {
  const original = Buffer.alloc(size * 2 + 37, 12);
  const file = new Blob([original]); file.name = 'Show.mp4';
  const bodies = [], offsets = [], progress = [];
  let lostResponse = true, offset = 0, polls = 0;
  const send = createChunkUploader(async (method, url, body, onProgress) => {
    if (url === '/api/uploads') return {id: 'upload', offset: 0};
    if (method === 'PUT') {
      const at = Number(new URL(url, 'https://test').searchParams.get('offset'));
      assert.ok(body.size <= size);
      const bytes = Buffer.from(await body.arrayBuffer());
      offsets.push(at);
      if (at === offset) { bodies.push(bytes); offset += bytes.length; }
      onProgress(body.size);
      if (lostResponse && at === size) { lostResponse = false; throw new Error('Disconnected'); }
      return {id:'upload', offset};
    }
    if (method === 'POST') return {status:'processing'};
    polls++;
    return {status:'done', offset, metadata_message:'Ready'};
  }, async () => {});
  assert.equal((await send(file, (...args) => progress.push(args))).metadata_message, 'Ready');
  assert.deepEqual(offsets, [0, size, size, 2 * size]);
  assert.deepEqual(Buffer.concat(bodies), original);
  assert.deepEqual(progress.at(-1), [100, true]);
  assert.equal(polls, 1);
});

test('manual retry resumes at server offset and does not create another upload', async () => {
  const file = new Blob([Buffer.alloc(size + 1)]); file.name = 'Show.mp4';
  let offline = true, offset = 0, creates = 0;
  const sent = [];
  const send = createChunkUploader(async (method, url, body) => {
    if (url === '/api/uploads') { creates++; return {id:'one', offset}; }
    if (method === 'GET') return {id:'one', offset, status:'uploading'};
    if (method === 'PUT') {
      const at = Number(new URL(url, 'https://test').searchParams.get('offset'));
      if (at === size && offline) throw new Error('Offline');
      sent.push(at); offset += body.size;
      return {offset};
    }
    return {status:'done'};
  }, async () => {});
  await assert.rejects(send(file, () => {}), /Offline/);
  offline = false;
  assert.equal((await send(file, () => {})).status, 'done');
  assert.equal(creates, 1);
  assert.deepEqual(sent, [0, size]);
});

test('permanent errors do not trigger network retries', async () => {
  const file = new Blob(['x']); file.name = 'Show.mp4';
  let calls = 0;
  const send = createChunkUploader(async () => { calls++; throw Object.assign(new Error('Denied'), {status:403}); }, async () => {});
  await assert.rejects(send(file, () => {}), /Denied/);
  assert.equal(calls, 1);
});
