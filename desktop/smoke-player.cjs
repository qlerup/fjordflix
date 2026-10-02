// Native UI integration test. Uses synthetic video; no server or private media.
const {spawn}=require('node:child_process');
const net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-player-'));
 const pipe='\\\\.\\pipe\\fjordflix-test-'+process.pid;
 const child=spawn(path.join(__dirname,'vendor/mpv/mpv.exe'),['--no-config','--load-scripts=no','--osc=no','--idle=yes','--force-window=yes','--vo=gpu-next','--gpu-api=d3d11','--geometry=1280x720','--script='+path.join(__dirname,'player.lua'),'--input-ipc-server='+pipe,'--log-file='+path.join(temp,'mpv.log')],{windowsHide:true,stdio:'ignore'});
 let socket;const pending=new Map();let id=0,buffer='';
 try{
  for(let n=0;n<100;n++){
   socket=await new Promise(resolve=>{const s=net.connect(pipe);s.once('connect',()=>resolve(s));s.once('error',()=>{s.destroy();resolve(null);});});
   if(socket)break;await delay(100);
  }
  assert.ok(socket,'mpv IPC startup');
  socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(pending.has(m.request_id)){pending.get(m.request_id)(m);pending.delete(m.request_id);}}});
  async function cmd(...command){const request_id=++id;const result=await Promise.race([new Promise(r=>{pending.set(request_id,r);socket.write(JSON.stringify({command,request_id})+'\n');}),delay(5000).then(()=>{throw Error('IPC timed out: '+command[0]);})]);assert.equal(result.error,'success',JSON.stringify(result));if(command[0]==='keypress')await delay(80);return result.data;}
  await cmd('loadfile','av://lavfi:testsrc=size=1280x720:rate=24');await delay(1500);
  await cmd('script-message','fjord-title','FjordFlix \u00b7 En aften i biografen');
  await cmd('set_property','pause',true);
  const sub=path.join(temp,'sample.srt');fs.writeFileSync(sub,'1\n00:00:00,000 --> 00:10:00,000\nDanske undertekster\n');
  for(let n=0;n<12;n++)await cmd('sub-add',sub,'auto','Undertekstspor '+(n+1),'dan');
  await delay(500);
  await cmd('screenshot-to-file',path.join(temp,'controls.png'),'window');
  await cmd('keypress','s');await delay(300);
  await cmd('screenshot-to-file',path.join(temp,'subtitles.png'),'window');
  // Tab focuses the close button, then the explicit Off row, then track 1.
  await cmd('keypress','TAB');await cmd('keypress','TAB');await cmd('keypress','TAB');await cmd('keypress','ENTER');
  assert.equal(await cmd('get_property','sid'),1,'keyboard selects subtitle track');
  await cmd('keypress','s');await cmd('keypress','TAB');await cmd('keypress','TAB');await cmd('keypress','ENTER');
  assert.equal(await cmd('get_property','sid'),false,'subtitles can be disabled');
  await cmd('keypress','s');await cmd('keypress','WHEEL_DOWN');await delay(300);
  await cmd('screenshot-to-file',path.join(temp,'scrolled.png'),'window');
  await cmd('keypress','ESC');await cmd('keypress','a');await delay(300);
  await cmd('screenshot-to-file',path.join(temp,'audio-empty.png'),'window');
  await cmd('keypress','ESC');await cmd('keypress','SPACE');
  assert.equal(await cmd('get_property','pause'),false,'pause shortcut preserved');
  await delay(3300);
  await cmd('screenshot-to-file',path.join(temp,'hidden.png'),'window');
  // A finite audio fixture makes timeline seeking deterministic.
  const wav=Buffer.alloc(44+8000*2*60);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const audio=path.join(temp,'sample.wav');fs.writeFileSync(audio,wav);
  await cmd('loadfile',audio);await delay(500);await cmd('set_property','pause',true);
  await cmd('keypress','RIGHT');await delay(200);
  assert.ok((await cmd('get_property','time-pos'))>=10,'seek forward');
  await cmd('keypress','LEFT');await delay(200);
  assert.ok((await cmd('get_property','time-pos'))<2,'seek backward');
  await cmd('set_property','volume',50);await cmd('keypress','WHEEL_UP');
  assert.equal(await cmd('get_property','volume'),55,'volume control');
  await cmd('keypress','a');await delay(200);
  await cmd('screenshot-to-file',path.join(temp,'audio.png'),'window');
  await cmd('keypress','TAB');await cmd('keypress','TAB');await cmd('keypress','ENTER');
  assert.equal(await cmd('get_property','aid'),1,'audio track selection');
  const dims=await cmd('get_property','osd-dimensions');
  await cmd('mouse',Math.round(66*dims.h/720),Math.round(656*dims.h/720),0,'single');await delay(200);
  assert.equal(await cmd('get_property','pause'),false,'mouse play button');
  await cmd('set_property','pause',true);
  await cmd('set_property','geometry','640x480');await delay(400);
  await cmd('keypress','s');await delay(200);
  await cmd('screenshot-to-file',path.join(temp,'small.png'),'window');
  const log=fs.readFileSync(path.join(temp,'mpv.log'),'utf8');
  assert.ok(!/Lua error|stack traceback|Error loading.*player/i.test(log),log);
  console.log('PASS: native rendering, subtitle selection/off, scrolling, empty audio, pause, auto-hide. Screenshots: '+temp);
 }finally{socket?.destroy();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

