const {_electron}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fjordflix-window-state-'));
 const env={...process.env,FJORDFLIX_TEST_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
 let instance;
 async function launch(){instance=await _electron.launch({executablePath:path.join(__dirname,'node_modules/electron/dist/electron.exe'),args:[__dirname],env});const page=await instance.firstWindow();await page.locator('#server').waitFor();}
 async function fullscreen(){return instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen());}
 async function close(){await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await instance.close();instance=null;}
 try{
  await launch();assert.equal(await fullscreen(),true,'first start remains fullscreen');
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await close();
  await launch();assert.equal(await fullscreen(),false,'window mode survives restart');
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await close();
  await launch();assert.equal(await fullscreen(),true,'fullscreen survives restart');
  console.log('PASS: actual Electron remembers window/fullscreen across three launches');
 }finally{if(instance)await instance.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
