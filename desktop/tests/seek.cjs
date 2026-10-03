const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'../..'),mpv=path.join(root,'desktop/vendor/mpv/mpv.exe');
test('native timeline holds requested position and rejects stale preview/restart events', {skip:!fs.existsSync(mpv)},()=>{
  const result=spawnSync(mpv,['--no-config','--load-scripts=no','--idle=yes','--vo=null','--script=desktop/test-seek.lua','--msg-level=all=warn,test_seek=info'],{cwd:root,windowsHide:true,encoding:'utf8',timeout:10000});
  assert.match(result.stdout+result.stderr,/PASS: optimistic timeline/,result.error?.message);
});
