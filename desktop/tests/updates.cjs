const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createUpdates}=require('../updates.cjs');
function fixture({available=true,playing=false,answers=[0,0],failure=false}={}) {
  const updater=new EventEmitter(), calls=[];
  updater.checkForUpdates=async()=>{calls.push('check');if(failure)throw Error('offline');if(available)updater.emit('update-available',{version:'0.2.0'});};
  updater.downloadUpdate=async()=>{calls.push('download');};
  updater.quitAndInstall=()=>calls.push('install');
  const messages=[];
  const controller=createUpdates({app:{isPackaged:true,getVersion:()=> '0.1.1'},updater,
    dialog:{showMessageBox:async(_w,message)=>{messages.push(message);return {response:answers.shift()??1};}},
    window:{isDestroyed:()=>false,setProgressBar(){}},playing:()=>playing});
  return {controller,calls,messages,updater};
}
test('confirmed update downloads then installs; no implicit updates',async()=>{
  const f=fixture();await f.controller.check();assert.deepEqual(f.calls,['check','download','install']);
  assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);
});
test('declining download changes nothing',async()=>{
  const f=fixture({answers:[1]});await f.controller.check();assert.deepEqual(f.calls,['check']);
});
test('playback prevents installation',async()=>{
  const f=fixture({playing:true});await f.controller.check();assert.deepEqual(f.calls,['check','download']);
});
test('offline check reports error and can be retried',async()=>{
  const f=fixture({failure:true});await f.controller.check();await f.controller.check();
  assert.deepEqual(f.calls,['check','check']);assert.equal(f.messages[0].type,'error');
});
test('latest version does not download',async()=>{
  const f=fixture({available:false});await f.controller.check();assert.deepEqual(f.calls,['check']);
});
test('concurrent clicks cannot launch two downloads',async()=>{
  const f=fixture();await Promise.all([f.controller.check(),f.controller.check()]);assert.deepEqual(f.calls,['check','download','install']);
});
