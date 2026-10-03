const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
(async()=> {
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=> {
    window.testPad={mapping:'standard',buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};
    Object.defineProperty(navigator,'getGamepads',{value:()=>[window.testPad]});
  });
  const key=code=>page.evaluate(code=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{keyCode:code,bubbles:true,cancelable:true})),code);
  try {
    await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
    await page.locator('#server-address').waitFor({state:'visible'});
    await key(203);assert.equal(await page.evaluate(()=>document.activeElement.id),'phone-login');
    await key(204);assert.equal(await page.evaluate(()=>document.activeElement.id),'server-address');
    await key(204);assert.equal(await page.evaluate(()=>document.activeElement.id),'username');
    await key(195);assert.equal(await page.locator('#username').evaluate(el=>el.readOnly),false);
    await key(196);assert.equal(await page.locator('#username').evaluate(el=>el.readOnly),true);
    // One A press toggles a checkbox exactly once even when held.
    await page.locator('#login-https').focus();
    await page.evaluate(()=>testPad.buttons[0].pressed=true);
    await page.waitForTimeout(650);assert.equal(await page.isChecked('#login-https'),false);
    await page.evaluate(()=>testPad.buttons[0].pressed=false);await page.waitForTimeout(50);
    // B at the root opens the app's own exit dialog; B cancels and restores focus.
    await key(196);assert.equal(await page.locator('.exit-dialog').count(),1);
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Bliv her');
    await key(206);assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Luk appen');
    await key(196);assert.equal(await page.locator('.exit-dialog').count(),0);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'login-https');
    // Xbox X and shoulder buttons operate the player without moving focus.
    await page.evaluate(()=>{
      document.getElementById('player').hidden=false;
      window.controllerClicks=[];
      ['toggle','rewind','forward'].forEach(id=>document.getElementById(id).onclick=()=>controllerClicks.push(id));
    });
    await key(197);await key(200);await key(199);
    assert.deepEqual(await page.evaluate(()=>controllerClicks),['toggle','rewind','forward']);
    assert.deepEqual(errors,[]);
    // Exercise WinRT calls and event ownership, which the browser-only path cannot cover.
    const nativePage=await browser.newPage({viewport:{width:1920,height:1080}});
    nativePage.on('pageerror',e=>errors.push(e.message));
    await nativePage.addInitScript(()=>{
      window.nativeCalls=[];
      window.paneHandlers={};
      const pane={
        tryShow(){nativeCalls.push(['show',document.activeElement.id,document.activeElement.readOnly]);return true;},
        tryHide(){nativeCalls.push(['hide']);return true;},
        addEventListener(name,handler){paneHandlers[name]=handler;}
      };
      window.Windows={UI:{ViewManagement:{
        ApplicationViewScaling:{trySetDisableLayoutScaling(value){nativeCalls.push(['scaling',value]);return true;}},
        InputPane:{getForCurrentView(){return pane;}}
      },WebUI:{WebUIApplication:{addEventListener(){}}}},Media:{
        SystemMediaTransportControls:{getForCurrentView(){return {addEventListener(){}};}},
        MediaPlaybackStatus:{}
      }};
    });
    await nativePage.goto(pathToFileURL(path.resolve(__dirname,'../dist/app/index.html')).href);
    assert.deepEqual(await nativePage.evaluate(()=>nativeCalls),[['scaling',true]]);
    for (const id of ['server-address','username','password']) {
      await nativePage.locator('#'+id).focus();
      await nativePage.evaluate(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{keyCode:195,bubbles:true,cancelable:true})));
      assert.deepEqual(await nativePage.evaluate(()=>nativeCalls[nativeCalls.length-1]),['show',id,false]);
      // Once editing, native A/B must be available to the system keyboard.
      for (const code of [195,196,204]) {
        assert.equal(await nativePage.evaluate(code=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{keyCode:code,bubbles:true,cancelable:true})),code),true);
      }
      await nativePage.evaluate(()=>paneHandlers.hiding());
      assert.equal(await nativePage.locator('#'+id).evaluate(el=>el.readOnly),true);
    }
    await nativePage.locator('#server-address').click();
    assert.deepEqual(await nativePage.evaluate(()=>nativeCalls[nativeCalls.length-1]),['show','server-address',false]);
    await nativePage.keyboard.press('Escape');
    assert.deepEqual(await nativePage.evaluate(()=>nativeCalls[nativeCalls.length-1]),['hide']);
    assert.equal(await nativePage.locator('#server-address').evaluate(el=>el.readOnly),true);
    assert.deepEqual(errors,[]);
    console.log('Xbox input passed: A/B, D-pad, text entry, held-button suppression, exit dialog, X and LB/RB.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
