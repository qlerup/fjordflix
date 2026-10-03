// Run with NODE_PATH pointing to a Playwright installation. All data is temporary.
const {_electron} = require('playwright');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-desktop-smoke-'));
 const profile=path.join(temp,'profile');fs.mkdirSync(profile);
 const env={...process.env,DATA_DIR:path.join(temp,'data'),TRANSCODE_DEVICE:'cpu',FJORDFLIX_TEST_PROFILE:profile};
 delete env.ELECTRON_RUN_AS_NODE;
 const py=path.join(root,'.venv/Scripts/python.exe');
 const fixture=`import wave,json,time\nfrom app import main\np=main.DATA/'sample.wav'\nwith wave.open(str(p),'wb') as f:\n f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b'\\0\\0'*8000*40)\nmeta={'format':'wav','video':'','audio':'pcm_s16le','width':0,'height':0,'duration':40,'size':p.stat().st_size,'bitrate':128000,'tracks':{'version':1,'audio':[{'index':0,'default':True,'codec':'pcm_s16le','language':'und'}],'subtitles':[]}}\nwith main.db() as c:\n c.execute('INSERT INTO movies VALUES (?,?,?,?,?)',('a'*32,'Desktop smoke',str(p),json.dumps(meta),time.time()))\n`;
 const seed=spawnSync(py,['-c',fixture],{cwd:root,env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);
 const server=spawn(py,['-m','uvicorn','app.main:app','--port','18763'],{cwd:root,env,windowsHide:true,stdio:'ignore'});
 let electron;
 try {
  for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:18763/api/state')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  electron=await _electron.launch({executablePath:path.join(__dirname,'node_modules/electron/dist/electron.exe'),args:[__dirname],env});
  const page=await electron.firstWindow(); await page.locator('#server').fill('http://127.0.0.1:18763');
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),true,'app starts fullscreen');
  await page.screenshot({path:path.join(temp,'setup.png')});
  await page.locator('button').click(); await page.waitForURL('http://127.0.0.1:18763/');
  const result=await page.evaluate(async()=>{
    const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Desktop Tester',password:'Desktop-test-password-738!'})});
    return r.status;
  });assert.equal(result,200);
  await page.reload();await page.waitForTimeout(1500);
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  await page.locator('#logout').click();
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),false,'header button exits fullscreen');
  assert.ok(await page.evaluate(async()=> (await (await fetch('/api/state')).json()).user),'fullscreen toggle must not log out');
  await page.locator('#logout').click();
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),true,'header button returns to fullscreen');
  const png=await electron.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(path.join(temp,'library.png'),Buffer.from(png,'base64'));
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  await page.locator('#movie-grid .movie-card').first().click();
  assert.ok(await page.locator('#library-categories').isVisible(),'Windows detail page keeps sidebar visible');
  assert.equal(await page.locator('#library-categories').evaluate(el=>el.parentElement.id),'shell');
  const sidebar=await page.locator('#library-categories').boundingBox(),detail=await page.locator('#detail').boundingBox();
  assert.equal(sidebar.x,0);assert.ok(detail.x>=sidebar.width,'Windows detail content stays beside navigation');
  if(process.env.FJORDFLIX_UI_ONLY){console.log('PASS: actual Electron title page keeps sidebar fixed and visible');return;}
  await page.evaluate(()=>window.fjordDesktop.play({id:'a'.repeat(32),start:3,audio_track:0,subtitle_track:null}));
  let progress=0;
  for(let n=0;n<25;n++){
    await new Promise(r=>setTimeout(r,1000));
    progress=await page.evaluate(async()=>{const movies=await (await fetch('/api/movies')).json();return movies.find(m=>m.id==='a'.repeat(32))?.position||0;});
    if(progress>5)break;
  }
  assert.ok(progress>5,'Native mpv must report playback progress through authenticated IPC: '+progress);
  const streams=await page.evaluate(async()=> (await (await fetch('/api/admin/active-streams')).json()).streams);
  assert.equal(streams.length,1,'native playback is visible to administrator');
  assert.equal(streams[0].client,'Windows-app');
  assert.equal(streams[0].mode,'Direct Play');
  assert.ok(streams[0].position>5,'native position is reported');
  console.log('PASS: setup, login, isolated renderer, mpv HTTP playback and saved progress',progress,temp);
 } finally {if(electron)await electron.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
