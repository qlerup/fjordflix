// A bounded, disposable preview decoder. Media tickets are passed over stdin,
// never exposed in process arguments. It cannot change the playing mpv instance.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function createPreviews({executable,url,send}) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-preview-'));
  const cache=new Map(),jobs=new Set();let current=null,disposed=false;
  const remove=file=>{try{fs.unlinkSync(file);}catch{}};
  function cleanup(){if(disposed&&!jobs.size){for(const file of cache.values())remove(file);cache.clear();try{fs.rmdirSync(folder);}catch{}}}
  function request(serial,seconds) {
    const target=Math.max(0,Math.round(Number(seconds)));
    if(disposed||!Number.isFinite(target)||target>1e8||!/^\d+$/.test(String(serial)))return;
    if(current?.target===target){current.serial=String(serial);return;}
    if(current){current.stale=true;current.child.kill();current=null;}
    const ready=cache.get(target);
    if(ready){send(['script-message','fjord-preview-ready',String(serial),String(target),ready]);return;}
    const file=path.join(folder,`${serial}.bgra`);
    const child=spawn(executable,['--no-config','--load-scripts=no','--ytdl=no','--terminal=no','--msg-level=all=no',
      '--no-audio','--sid=no','--hwdec=auto-copy','--vd-lavc-threads=2','--frames=1','--hr-seek=yes',`--start=${target}`,
      '--vf=lavfi=[scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=bgra]',
      '--ovc=rawvideo','--of=rawvideo',`--o=${file}`,'--playlist=-'],{windowsHide:true,stdio:['pipe','ignore','ignore']});
    const job={child,target,serial:String(serial),stale:false};current=job;jobs.add(job);
    child.stdin.on('error',()=>{});child.stdin.end(url+'\n');
    const timeout=setTimeout(()=>{job.stale=true;child.kill();},10000);
    child.once('error',()=>{job.stale=true;});
    child.once('close',code=>{
      clearTimeout(timeout);jobs.delete(job);if(current===job)current=null;
      let valid=false;try{valid=fs.statSync(file).size===640*360*4;}catch{}
      if(!disposed&&!job.stale&&code===0&&valid){
        cache.set(target,file);
        while(cache.size>6){const [key,old]=cache.entries().next().value;cache.delete(key);remove(old);}
        send(['script-message','fjord-preview-ready',job.serial,String(target),file]);
      }else remove(file);
      cleanup();
    });
  }
  return {request,dispose(){disposed=true;for(const job of jobs){job.stale=true;job.child.kill();}cleanup();}};
}
module.exports={createPreviews};
