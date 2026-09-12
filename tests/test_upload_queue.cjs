const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createUploadQueue} = require('../app/static/uploads.js');
const file = name => ({name, size:123, lastModified:1});
test('multiple files run sequentially, survive failure and do not repeat successes', async () => {
  const calls = []; let active = 0;
  const queue = createUploadQueue(async (file, progress) => {
    assert.equal(active++, 0); calls.push(file.name);
    progress(50, false); await Promise.resolve(); progress(100, true); active--;
    if (file.name === 'bad.mp4') throw new Error('Failed');
    return {metadata_message:'Matched'};
  });
  queue.add([file('one.mp4'), file('bad.mp4'), file('two.mkv')]);
  await queue.run();
  assert.deepEqual(calls, ['one.mp4','bad.mp4','two.mkv']);
  assert.deepEqual(queue.items.map(item => item.status), ['done','error','done']);
  await queue.run(); assert.equal(calls.length, 3);
  assert.equal(queue.running, false);
});
test('invalid files and duplicates are filtered before upload', async () => {
  const sent = [];
  const queue = createUploadQueue(async file => {sent.push(file.name);return {}});
  queue.add([file('one.mp4'),file('one.mp4'),file('bad.txt'),{...file('huge.mp4'),size:101*1024**3},{...file('empty.mp4'),size:0}]);
  await queue.run();
  assert.deepEqual(sent,['one.mp4']);
  assert.equal(queue.items.length,4);
});
test('double submission and changing files while uploading cannot start extra requests', async () => {
  let release, calls=0;
  const queue=createUploadQueue(()=>{calls++;return new Promise(resolve=>release=resolve)});
  queue.add([file('one.mp4')]);
  const running=queue.run();
  queue.add([file('two.mp4')]);await queue.run();
  assert.equal(calls,1); assert.equal(queue.items.length,1);
  release({});await running;
  assert.equal(queue.running,false);
});
