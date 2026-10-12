const {test}=require('node:test'),assert=require('node:assert/strict');
const episodes=require('../next-episode.js');
const movie=(id,season,episode,key='series')=>({id,series_key:key,catalog:{season,episode}});
test('next episode uses series identity and numeric order, including season boundaries and duplicate editions',()=>{
 const current=movie('one',1,2),next=movie('next',2,1);
 assert.equal(episodes.next([movie('duplicate',1,2),movie('earlier',1,1),movie('wrong',1,3,'other'),next,movie('last',10,1)],current),next);
 assert.equal(episodes.next([current],current),null);
 assert.equal(episodes.next([next],{id:'film'}),null);
 assert.equal(episodes.next([next],movie('bad',null,1)),null);
});
test('countdown follows media time; pausing and seeking do not run an independent timer',()=>{
 assert.equal(episodes.countdown(100,89.9),null);
 assert.equal(episodes.countdown(100,90),10);
 assert.equal(episodes.countdown(100,94.1),6);
 assert.equal(episodes.countdown(100,100),0);
 assert.equal(episodes.countdown(0,0),null);
 assert.equal(episodes.countdown(Infinity,90),null);
});
test('all clients ship the same episode ordering rules',()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'../..');
 const source=fs.readFileSync(path.join(root,'app/static/next-episode.js'),'utf8');
 for(const file of ['desktop/next-episode.js','xbox/tv/next-episode.js','lg/tv/next-episode.js'])
  assert.equal(fs.readFileSync(path.join(root,file),'utf8'),source);
});
test('real bundled mpv loads the native countdown and click controls',()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'../..');
 const mpv=path.join(root,'desktop/vendor/mpv/mpv.exe');
 if(!fs.existsSync(mpv))return;
 const result=require('node:child_process').spawnSync(mpv,['--no-config','--load-scripts=no','--idle=yes','--vo=null',
  '--script=desktop/test-next-episode.lua','--msg-level=all=warn,test_next_episode=info'],{cwd:root,windowsHide:true,encoding:'utf8',timeout:10000});
 assert.match(result.stdout+result.stderr,/PASS: native next episode/,result.error?.message);
});
