/* Phone pairing UI: mocked approval responses, no accounts or running backend. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
for (const moduleName of ['playwright', '../../fjordflix-XBOX-APP/node_modules/playwright']) {
  try { ({chromium} = require(moduleName)); break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
if (!chromium) throw new Error('Playwright is required.');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results/tv-login');

(async () => {
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await context.addCookies([{name:'fjordflix_session',value:'ambient-session-must-not-be-used',domain:'fjordflix.test',path:'/'}]);
    const page = await context.newPage(), errors = [], approvals = [];
    page.on('pageerror', error => errors.push(error.message));
    let responseStatus = 401, networkFailure = false, gate = null, release;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/tv-login') return route.fulfill({path:path.join(root,'app/static/tv-login.html'),contentType:'text/html'});
      if (url.pathname.startsWith('/static/')) return route.fulfill({path:path.join(root,'app',url.pathname.slice(1))});
      assert.equal(url.pathname, '/tv-api/pair/approve');
      approvals.push({body:request.postDataJSON(),headers:request.headers()});
      if (gate) await gate;
      if (networkFailure) return route.abort('failed');
      return route.fulfill({status:responseStatus,contentType:'application/json',body:JSON.stringify(responseStatus === 200 ? {status:'approved'} : {detail:responseStatus === 403 ? 'Skift din adgangskode i FjordHub. <em>Før login</em>' : 'Fixture error'})});
    });
    const screenshot = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'no horizontal overflow');
      await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
    };
    await page.goto('http://fjordflix.test/tv-login#code=abcd-efgh');
    assert.equal(await page.inputValue('#user-code'),'ABCD-EFGH');
    assert.equal(await page.locator('#user-code').getAttribute('readonly'),'');
    assert.equal(await page.locator('#username').evaluate(el => getComputedStyle(el).fontSize),'16px');
    await screenshot('390-login');
    await page.setViewportSize({width:720,height:1000});
    await screenshot('720-login');
    await page.setViewportSize({width:390,height:844});
    await page.fill('#username','Sofie'); await page.fill('#password','wrong-password');
    gate = new Promise(resolve => {release=resolve;});
    await page.click('#approve-button');
    await page.waitForFunction(() => document.getElementById('pair-form').getAttribute('aria-busy') === 'true');
    assert.ok(await page.locator('#approve-button').isDisabled());
    await page.evaluate(() => document.getElementById('pair-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    await page.waitForTimeout(50);
    assert.equal(approvals.length,1,'pending submit cannot be duplicated');
    release(); gate = null;
    await page.locator('#pair-error').waitFor();
    assert.match(await page.textContent('#pair-error'),/Brugernavn eller adgangskode/);
    assert.equal(await page.evaluate(() => document.activeElement.id),'password');
    assert.equal(approvals[0].headers.cookie,undefined,'approval omits ambient cookies');
    assert.deepEqual(approvals[0].body,{user_code:'ABCD-EFGH',name:'Sofie',password:'wrong-password'});
    for (const [status,pattern] of [[410,/udløbet/],[404,/ikke fundet/],[409,/allerede godkendt/],[403,/Skift din adgangskode i FjordHub/],[429,/For mange forsøg/],[503,/svarer ikke/]]) {
      responseStatus=status;
      await page.click('#approve-button');
      await page.waitForFunction(() => document.getElementById('pair-form').getAttribute('aria-busy') === 'false');
      assert.match(await page.textContent('#pair-error'),pattern);
      if (status === 403) assert.equal(await page.locator('#pair-error em').count(),0,'backend detail is plain text');
    }
    await screenshot('390-error');
    networkFailure=true;
    await page.click('#approve-button');
    await page.waitForFunction(() => document.getElementById('pair-form').getAttribute('aria-busy') === 'false');
    assert.match(await page.textContent('#pair-error'),/forbindelse/);
    networkFailure=false; responseStatus=200;
    await page.fill('#password','correct-password');
    await page.click('#approve-button');
    await page.locator('#pair-success').waitFor();
    assert.ok(await page.locator('#pair-form').isHidden());
    assert.equal(await page.inputValue('#password'),'');
    assert.equal(await page.textContent('#success-code'),'ABCD-EFGH');
    assert.equal(await page.evaluate(() => document.activeElement.id),'success-title');
    await screenshot('390-success');
    await page.goto('http://fjordflix.test/tv-login');
    assert.equal(await page.inputValue('#user-code'),'');
    assert.equal(await page.locator('#user-code').getAttribute('readonly'),null);
    await page.locator('#user-code').pressSequentially('abcd2345');
    assert.equal(await page.inputValue('#user-code'),'ABCD-2345');
    await page.fill('#username','Sofie'); await page.fill('#password','correct-password');
    await page.click('#approve-button');
    await page.locator('#pair-success').waitFor();
    assert.equal(approvals.at(-1).body.user_code,'ABCD-2345');
    await page.goto('http://fjordflix.test/tv-login#code=bad-link');
    await page.locator('#pair-error').waitFor();
    assert.equal(await page.inputValue('#user-code'),'');
    await page.setViewportSize({width:320,height:720});
    await screenshot('320-manual');
    assert.deepEqual(errors,[]);
    await context.close();
    console.log('PASS phone Xbox login: QR/manual code, mobile/desktop layout, duplicate prevention, credentials without cookies, invalid/expired/rate/network errors, success and password cleanup.');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
