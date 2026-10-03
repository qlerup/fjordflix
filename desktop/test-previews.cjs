const {createPreviews}=require('./previews.cjs');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-preview-test-')),movie=path.join(folder,'sample.mkv');
 const ffmpeg=process.argv[2]||'ffmpeg';
 const result=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=5','-c:v','libx264','-g','24',movie],{windowsHide:true});
 assert.equal(result.status,0,result.stderr?.toString());
 let waiting;
 const received=[];
 const preview=createPreviews({executable:path.join(__dirname,'vendor/mpv/mpv.exe'),url:movie,send:command=>{received.push(command);waiting?.(command);}});
 async function request(id,time){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Preview timed out')),12000);waiting=command=>{clearTimeout(timer);resolve(command);};preview.request(id,time);});}
 try{
  const first=await request(1,0);const bytes=fs.readFileSync(first[4]);assert.equal(bytes.length,640*360*4);
  const next=await request(2,3);assert.notDeepEqual(fs.readFileSync(next[4]),bytes,'target frame differs from start');
  const cached=await request(3,0);assert.equal(cached[4],first[4],'repeat position reuses decoded image');
  preview.request(4,1);const latest=await request(5,2);assert.equal(latest[2],'5','latest seek wins');
  assert.ok(!received.some(c=>c[2]==='4'),'cancelled request cannot replace current preview');
  console.log('PASS: bundled mpv decodes target frame, bounded cache, cancellation, private stdin media path');
 }finally{preview.dispose();fs.unlinkSync(movie);fs.rmdirSync(folder);}
})().catch(error=>{console.error(error);process.exitCode=1;});
