const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createDiagnostics} = require('../playback-diagnostics.cjs');
const create = () => createDiagnostics({version:'test', title:'Film', start:45, now:()=>'test-time'});

test('a rejected load command is surfaced even without an end-file event', () => {
  const d = create();
  assert.match(d.receive({request_id:100,error:'invalid parameter'}), /afviste/);
  assert.equal(d.snapshot().events[0].kind, 'loadfile-error');
  assert.equal(d.receive({request_id:20,error:'property unavailable'}), null);
  assert.equal(d.receive({request_id:100,error:'success'}), null);
});

test('decoder and network errors preserve mpv reason without media credentials', () => {
  const d = create(), token='a'.repeat(43);
  const error = d.receive({event:'end-file',reason:'error',file_error:'Failed to open https://host/media/'+token+'/movies/movie/file'});
  assert.match(error, /Failed to open/);
  assert.ok(!error.includes(token));
  assert.ok(!JSON.stringify(d.snapshot()).includes('https://host'));
});

test('diagnostics distinguish loaded, seeking and buffering states', () => {
  const d = create();
  d.receive({event:'file-loaded'});
  for (const [name,data] of [['time-pos',45],['cache-speed',0],['paused-for-cache',true],['seeking',true]])
    d.receive({event:'property-change',name,data});
  d.receive({event:'property-change',name:'path',data:'secret'});
  const state = d.snapshot().status;
  assert.equal(state.stage,'file-loaded');
  assert.equal(state['paused-for-cache'],true);
  assert.equal(state.seeking,true);
  assert.equal(state.path,undefined);
});

test('logs are bounded and strip standalone tickets', () => {
  const d = create();
  for (let i=0;i<100;i++) d.receive({event:'log-message',prefix:'ffmpeg',text:'/media/'+'b'.repeat(43)+'/file '+ 'x'.repeat(4000)});
  const events=d.snapshot().events;
  assert.equal(events.length,60);
  assert.ok(events.every(e=>e.detail.length<=2000));
  assert.ok(!JSON.stringify(events).includes('b'.repeat(43)));
});

test('normal EOF is not reported as a playback error', () => {
  assert.equal(create().receive({event:'end-file',reason:'eof'}),null);
});

const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const {spawn} = require('node:child_process');
const mpv = path.join(__dirname,'../vendor/mpv/mpv.exe');
test('bundled mpv rejects an invalid load without end-file: desktop surfaces the reply',
  {skip:process.platform !== 'win32' || !fs.existsSync(mpv), timeout:15000}, async () => {
    const pipe = '\\\\.\\pipe\\fjordflix-diagnostics-test-' + require('node:crypto').randomUUID();
    const child = spawn(mpv,['--no-config','--load-scripts=no','--idle=yes','--vo=null','--ao=null','--input-ipc-server='+pipe],
      {windowsHide:true,stdio:'ignore'});
    let socket;
    const deadline = Date.now()+5000;
    try {
      while (!socket && Date.now()<deadline) {
        socket = await new Promise(resolve => {
          const s=net.connect(pipe);
          s.once('connect',()=>resolve(s));
          s.once('error',()=>{s.destroy();resolve(null);});
        });
        if (!socket) await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.ok(socket, 'mpv IPC must start');
      const reply = await new Promise((resolve,reject)=>{
        let buffer='';
        const timer=setTimeout(()=>reject(Error('mpv did not reply')),5000);
        socket.on('data',chunk=>{
          buffer+=chunk;
          let end;
          while ((end=buffer.indexOf('\n'))>=0) {
            const message=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
            if (message.request_id===100) {clearTimeout(timer);resolve(message);}
          }
        });
        socket.write(JSON.stringify({command:['loadfile'],request_id:100})+'\n');
      });
      assert.notEqual(reply.error,'success');
      assert.match(create().receive(reply),/afviste/);
    } finally {socket?.destroy();child.kill();}
  });
