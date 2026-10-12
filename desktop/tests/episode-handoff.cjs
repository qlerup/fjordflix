const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('native handoff saves and releases the old episode once before starting the next',async()=>{
 const calls=[],starts=[];
 const electron={app:{isPackaged:false,on(){},whenReady(){return {then(){}};}},
  dialog:{showMessageBox(){throw Error('unexpected handoff error');}}};
 const window={isDestroyed:()=>false,show(){calls.push('show');},focus(){},webContents:{send(){},session:{
  async fetch(url,options){calls.push(new URL(url).pathname);return {ok:true,json:async()=>({})};}}}};
 const context={__dirname:path.resolve(__dirname,'..'),process,console,Buffer,URL,AbortSignal,setInterval,clearInterval,setTimeout,clearTimeout,
  require(name){return name==='electron'?electron:require(name.startsWith('.')?path.resolve(__dirname,'..',name):name);},
  testWindow:window,starts};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../main.cjs'),'utf8')+
  '\nwin=testWindow;origin="https://server.test";play=async data=>starts.push(data);globalThis.finishRun=finish;',context);
 const run={id:'old',position:94,ticket:'old-ticket',playbackId:'old-playback',next:{id:'next'},nextRequested:true};
 await Promise.all([context.finishRun(run),context.finishRun(run)]);
 assert.deepEqual(calls,['/api/playbacks/old-playback/stop','/api/movies/old/progress','/api/media/revoke']);
 assert.equal(starts.length,1);assert.equal(starts[0].id,'next');assert.equal(starts[0].start,0);
 calls.length=0;
 await context.finishRun({id:'manual',position:15,ticket:'t',next:{id:'next'}});
 assert.equal(starts.length,1);assert(calls.includes('show'));
});
