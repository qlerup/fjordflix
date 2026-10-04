// Integration regression: embedded subtitles selected halfway through a cue.
// node desktop/test-subtitle-switch.cjs <ffmpeg.exe> [supsample.mkv]
// Optional PGS input: https://samples.ffmpeg.org/sub/PGS/supsample.mkv
// Re-mux its subtitle over generated video with frequent keyframes. The original
// sample's long GOP hides the bug by always seeking before the display set.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-sub-switch-'));
 for(const [name,text] of [['one','FIRST TRACK'],['two','SECOND TRACK']])fs.writeFileSync(path.join(temp,name+'.srt'),'1\n00:00:01,000 --> 00:00:25,000\n'+text+'\n\n2\n00:00:27,000 --> 00:00:29,000\nNEXT '+text+'\n');
 const media=path.join(temp,'sample.mkv');
 const ff=spawnSync(process.argv[2],['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x180:r=10:d=30','-i',path.join(temp,'one.srt'),'-i',path.join(temp,'two.srt'),'-map','0:v','-map','1:s','-map','2:s','-c:v','libx264','-g','10','-c:s','srt',media],{windowsHide:true,encoding:'utf8'});
 assert.equal(ff.status,0,ff.stderr||String(ff.error));
 const pipe='\\\\.\\pipe\\fjord-sub-'+process.pid;
 const display=['--force-window=yes','--vo=gpu-next','--gpu-api=d3d11', ...(process.env.MPV_MINIMIZED ? ['--window-minimized=yes'] : [])];
 const child=spawn(path.join(__dirname,'vendor/mpv/mpv.exe'),['--no-config','--load-scripts=no','--osc=no','--idle=yes',...display,'--cache=yes',...require('./subtitle-options.cjs'),'--sid=no','--pause','--start=20','--script='+path.join(__dirname,'player.lua'),'--input-ipc-server='+pipe,media],{windowsHide:true,stdio:'ignore'});
 let socket,buffer='',id=0;const pending=new Map();
 try{
  for(let i=0;i<100;i++){socket=await new Promise(resolve=>{const s=net.connect(pipe);s.once('connect',()=>resolve(s));s.once('error',()=>{s.destroy();resolve(null);});});if(socket)break;await delay(100);}
  assert.ok(socket);
  socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(pending.has(m.request_id)){pending.get(m.request_id)(m);pending.delete(m.request_id);}}});
  async function cmd(...command){const request_id=++id;let timer;try{const m=await Promise.race([new Promise(r=>{pending.set(request_id,r);socket.write(JSON.stringify({command,request_id})+'\n');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('IPC timeout')),5000);})]);if(command[1]==='sub-text' && m.error==='property unavailable')return '';assert.equal(m.error,'success');if(command[0]==='keypress')await delay(80);return m.data;}finally{clearTimeout(timer);}}
  await delay(800);
  async function select(row){await cmd('keypress','s');for(let n=0;n<row;n++)await cmd('keypress','TAB');await cmd('keypress','ENTER');}
  async function expectText(text){let current='';for(let n=0;n<25;n++){current=await cmd('get_property','sub-text');if(current===text)return;await delay(80);}assert.equal(current,text,'selected cue must appear without manual seeking');}
  await select(3);await expectText('FIRST TRACK');
  assert.equal(await cmd('get_property','pause'),true);
  assert.ok(Math.abs((await cmd('get_property','time-pos'))-20)<0.15,'position preserved');
  await select(4);await expectText('SECOND TRACK');
  await select(2);await expectText('');
  await cmd('set_property','pause',false);
  await select(3);await expectText('FIRST TRACK');
  await cmd('keypress','j');await expectText('SECOND TRACK');
  if(process.argv[3]){
   const pgs=path.join(temp,'pgs.mkv');
   const mux=spawnSync(process.argv[2],['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=720x480:r=24:d=10','-i',path.resolve(process.argv[3]),'-map','0:v','-map','1:s:0','-map','1:s:0','-c:v','libx264','-g','24','-c:s','copy',pgs],{windowsHide:true,encoding:'utf8'});
   assert.equal(mux.status,0,mux.stderr);
   await cmd('loadfile',pgs,'replace',-1,{start:'3',sid:'no',pause:'yes'});await delay(600);
   await cmd('screenshot-to-file',path.join(temp,'off.png'),'subtitles');
   await select(3);await delay(400);
   await cmd('screenshot-to-file',path.join(temp,'selected.png'),'subtitles');
   await cmd('seek',3,'absolute+exact');await delay(400);
   await cmd('screenshot-to-file',path.join(temp,'seek.png'),'subtitles');
   console.log('PGS screenshots: '+temp);
   assert.ok(!fs.readFileSync(path.join(temp,'seek.png')).equals(fs.readFileSync(path.join(temp,'off.png'))),'PGS fixture must render a subtitle after seek');
   assert.ok(fs.readFileSync(path.join(temp,'selected.png')).equals(fs.readFileSync(path.join(temp,'seek.png'))),'PGS must render immediately after selection without a manual seek');
   await select(4);await delay(400);
   await cmd('screenshot-to-file',path.join(temp,'second.png'),'subtitles');
   assert.ok(fs.readFileSync(path.join(temp,'second.png')).equals(fs.readFileSync(path.join(temp,'selected.png'))),'switching PGS tracks preserves the current cue');
   assert.equal(await cmd('get_property','pause'),true,'PGS switch preserves pause');
   assert.ok(Math.abs((await cmd('get_property','time-pos'))-3)<0.15,'PGS switch preserves position');
  }
  console.log('PASS: embedded subtitle switching while paused/playing, Off, keyboard cycling and unchanged position');
 }finally{socket?.destroy();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
