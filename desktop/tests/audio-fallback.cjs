const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAudioFallback} = require('../audio-fallback.cjs');
const rejected = {event:'log-message', prefix:'ao', text:"Failed to initialize audio driver 'wasapi'\n"};

test('failed WASAPI switches just the selected audio track to PCM once', () => {
  const sent=[], recorded=[];
  const recovery=createAudioFallback({send:(...args)=>sent.push(args),record:(...args)=>recorded.push(args),audio:1});
  recovery.receive({event:'property-change',name:'aid',data:3});
  recovery.receive({event:'property-change',name:'aid',data:false});
  recovery.receive({event:'log-message',prefix:'ffmpeg/video',text:'decoder warning'});
  assert.equal(sent.length,0);
  assert.equal(recovery.receive(rejected),null);
  assert.deepEqual(sent.map(x=>x[0]),[
    ['set_property','audio-spdif',''],['set_property','aid','no'],['set_property','aid',3]
  ]);
  assert.equal(recorded.length,1);
  assert.match(recovery.receive(rejected),/heller ikke med PCM/);
  assert.equal(sent.length,3);
});

test('a failed PCM recovery command is surfaced rather than leaving playback stuck', () => {
  const recovery=createAudioFallback({send:()=>{},record:()=>{},audio:1});
  recovery.receive(rejected);
  assert.equal(recovery.receive({request_id:110,error:'success'}),null);
  assert.match(recovery.receive({request_id:112,error:'error running command'}),/kunne ikke skifte til PCM/);
});

const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const mpv=path.resolve(__dirname,'../vendor/mpv/mpv.exe');
test('real WASAPI rejection recovers PCM and advances video without reloading',
  {skip:process.env.FJORDFLIX_TEST_WASAPI !== '1',timeout:20000}, async () => {
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-wasapi-'));
    const source=path.join(folder,'silent.mkv');
    let child,socket;
    try {
      const made=spawnSync(process.env.FFMPEG || 'ffmpeg',['-v','error',
        '-f','lavfi','-i','color=size=64x64:rate=10',
        '-f','lavfi','-i','anullsrc=r=48000:cl=5.1','-t','6',
        '-c:v','mpeg4','-c:a','truehd','-strict','-2',source],
        {windowsHide:true,encoding:'utf8',timeout:10000});
      assert.equal(made.status,0,made.stderr);
      const pipe='\\\\.\\pipe\\fjordflix-audio-test-'+require('node:crypto').randomUUID();
      child=spawn(mpv,['--no-config','--idle=yes','--vo=null','--audio-display=no',
        ...require('../audio-options.cjs'),'--input-ipc-server='+pipe],{windowsHide:true,stdio:'ignore'});
      const deadline=Date.now()+5000;
      while (!socket && Date.now()<deadline) {
        socket=await new Promise(resolve=>{
          const s=net.connect(pipe);
          s.once('connect',()=>resolve(s));
          s.once('error',()=>{s.destroy();resolve(null);});
        });
        if (!socket) await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.ok(socket,'mpv IPC started');
      const send=(command,request_id)=>socket.write(JSON.stringify({command,request_id})+'\n');
      const events=[],status={}; let starts=0,retries=0;
      const recovery=createAudioFallback({send,record:()=>retries++,audio:1});
      await new Promise((resolve,reject)=>{
        let buffer='';
        const timer=setTimeout(()=>reject(Error(JSON.stringify({status,events,retries,starts}))),10000);
        const fail=error=>{clearTimeout(timer);reject(error);};
        socket.on('error',fail);
        socket.on('data',chunk=>{
          buffer+=chunk;
          let end;
          while ((end=buffer.indexOf('\n'))>=0) {
            const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
            if (message.event==='start-file') starts++;
            if (message.event==='property-change') status[message.name]=message.data;
            if (message.event==='log-message') events.push(message.text);
            const failure=recovery.receive(message);
            if (failure) {fail(Error(failure));return;}
            if (message.request_id>=110 && message.error!=='success') {fail(Error(JSON.stringify(message)));return;}
            if (status['time-pos']>2 && status['audio-out-params']?.format &&
                !status['audio-out-params'].format.startsWith('spdif-')) {
              clearTimeout(timer);resolve();
            }
          }
        });
        send(['request_log_messages','warn']);
        ['time-pos','audio-out-params','aid','seeking'].forEach((name,i)=>send(['observe_property',i+1,name]));
        send(['loadfile',source,'replace',-1,{start:'1',aid:'1'}],100);
      });
      assert.equal(retries,1,'fixture must reproduce the rejected bitstream');
      assert.equal(starts,1,'video was not reloaded');
      assert.equal(status.aid,1);
      assert.equal(status.seeking,false);
    } finally {
      socket?.destroy();
      if (child && child.exitCode===null) {
        await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
      }
      if (fs.existsSync(source)) fs.unlinkSync(source);
      fs.rmdirSync(folder);
    }
  });
