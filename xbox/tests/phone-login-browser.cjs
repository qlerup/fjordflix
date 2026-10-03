/* Real local server + packaged Xbox client + separate phone context.
 * The backend always receives a fresh temporary datastore and no Hub credentials.
 * Run: node tests/phone-login-browser.cjs
 */
const {chromium} = require('playwright');
const jsQR = require('jsqr');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const xboxRoot = path.resolve(__dirname, '..');
const serverRoot = fs.existsSync(path.resolve(xboxRoot,'../app/main.py')) ? path.resolve(xboxRoot,'..') : path.resolve(xboxRoot, '../fjordflix');
const python = process.env.FJORDFLIX_TEST_PYTHON || path.join(serverRoot, '.venv/Scripts/python.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function noOverflow(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} has no horizontal overflow`);
}
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fjordflix-pairing-e2e-'));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const env = {...process.env, DATA_DIR: temporary, MEDIA_DIR: path.join(temporary, 'media'),
    LIBRARY_ROOTS: JSON.stringify([path.join(temporary, 'library')]), TRANSCODE_DEVICE: 'cpu', SECURE_COOKIES: '0'};
  for (const key of ['FJORDHUB_URL', 'FJORDHUB_API_KEY', 'MEDIA_PUBLIC_URL', 'WEB_PUBLIC_URL', 'TMDB_READ_ACCESS_TOKEN']) delete env[key];
  const server = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
    {cwd: serverRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let logs = '', startupError, browser;
  server.stdout.on('data', chunk => logs += chunk);
  server.stderr.on('data', chunk => logs += chunk);
  server.on('error', error => startupError = error);
  const serverExit = new Promise(resolve => server.once('exit', resolve));
  const post = (endpoint, data, extraHeaders = {}) => fetch(origin + endpoint, {
    method: 'POST', headers: {'Content-Type': 'application/json', ...extraHeaders}, body: JSON.stringify(data),
  });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw new Error('Isolated server exited: ' + logs);
      try {ready = (await fetch(origin + '/api/state')).ok;} catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'isolated server starts: ' + logs);
    const credentials = {name: 'Phone Login QA', password: 'Temporary-QR-test-password-73!'};
    const setup = await post('/api/setup', credentials);
    assert.equal(setup.status, 200, 'temporary server administrator is created');
    browser = await chromium.launch({headless: true});
    const xboxContext = await browser.newContext({viewport: {width: 1920, height: 1080}});
    const xbox = await xboxContext.newPage(), errors = [];
    xbox.on('pageerror', error => errors.push('Xbox: ' + error.message));
    await xbox.goto(pathToFileURL(path.join(xboxRoot, 'dist/app/index.html')).href);
    await xbox.locator('#server-address').click();
    await xbox.locator('#server-address').fill(`127.0.0.1:${port}`);
    await xbox.locator('#login-https').uncheck();
    async function startPair() {
      const response = xbox.waitForResponse(res => res.url() === origin + '/tv-api/pair/start' && res.request().method() === 'POST');
      await xbox.locator('#phone-login').click();
      const result = await response;
      assert.equal(result.status(), 200);
      const pair = await result.json();
      assert.match(pair.device_code, /^[A-Za-z0-9_-]{43}$/);
      assert.match(pair.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.equal(pair.expires_in, 300);assert.ok(pair.interval >= 3);
      await xbox.locator('#phone-qr').waitFor();
      await xbox.waitForFunction(() => document.getElementById('phone-qr').complete && document.getElementById('phone-qr').naturalWidth > 0);
      assert.equal((await xbox.locator('#phone-code').innerText()).trim(), pair.user_code);
      return pair;
    }
    const pair = await startPair();
    const pixels = await xbox.locator('#phone-qr').evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      return {width: canvas.width, height: canvas.height, data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)};
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    assert.ok(decoded, 'rendered SVG QR is decodable');
    assert.equal(decoded.data, pair.verification_uri_complete);
    const verifyURL = new URL(decoded.data);
    assert.equal(verifyURL.origin, origin);assert.equal(verifyURL.pathname, '/tv-login');
    assert.equal(new URLSearchParams(verifyURL.hash.slice(1)).get('code'), pair.user_code);
    assert.ok(!decoded.data.includes(pair.device_code), 'QR never discloses the polling secret');
    const crossSite = await post('/tv-api/pair/approve', {user_code: pair.user_code, ...credentials}, {Origin: 'https://other.example'});
    assert.equal(crossSite.status, 403, 'a foreign Origin cannot approve a TV');
    const phoneContext = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    const phone = await phoneContext.newPage();
    phone.on('pageerror', error => errors.push('Phone: ' + error.message));
    await phone.goto(decoded.data);
    await phone.locator('#pair-form').waitFor();
    assert.equal(await phone.locator('#user-code').inputValue(), pair.user_code);
    await noOverflow(phone, 'phone approval form');
    const out = path.join(xboxRoot, 'test-results');fs.mkdirSync(out, {recursive: true});
    await xbox.screenshot({path: path.join(out, '07-phone-login-qr.png'), fullPage: true});
    await xbox.setViewportSize({width: 1280, height: 720});
    const cancelBounds = await xbox.locator('#phone-cancel').boundingBox();
    const footerBounds = await xbox.locator('footer').boundingBox();
    assert.ok(cancelBounds.y >= 0 && cancelBounds.y + cancelBounds.height <= footerBounds.y, '720p QR cancel button stays above the controller footer');
    await xbox.screenshot({path: path.join(out, '07-phone-login-qr-720p.png')});
    await xbox.setViewportSize({width: 1920, height: 1080});
    await phone.screenshot({path: path.join(out, '08-phone-login-mobile.png'), fullPage: true});
    await phone.locator('#username').fill(credentials.name);
    await phone.locator('#password').fill('wrong-password');
    await phone.locator('#approve-button').click();
    await phone.waitForFunction(() => document.getElementById('pair-error').textContent.trim().length > 0);
    assert.ok(await xbox.locator('#login').isVisible(), 'invalid phone credentials do not sign in the Xbox');
    await phone.locator('#password').fill(credentials.password);
    const approval = phone.waitForResponse(res => res.url() === origin + '/tv-api/pair/approve' && res.request().method() === 'POST');
    await phone.locator('#approve-button').click();
    const approved = await approval;
    assert.equal(approved.status(), 200);
    assert.equal(approved.headers()['set-cookie'], undefined, 'approval does not create a browser login cookie');
    assert.equal((await approved.json()).token, undefined, 'phone never receives the Xbox bearer token');
    await phone.locator('#pair-success').waitFor();
    assert.equal(await phone.locator('#password').inputValue(), '', 'phone clears the submitted password');
    await noOverflow(phone, 'phone approval success');
    await phone.screenshot({path: path.join(out, '09-phone-login-success.png'), fullPage: true});
    await xbox.locator('#library').waitFor({state: 'visible', timeout: 15000});
    const saved = await xbox.evaluate(() => JSON.parse(localStorage.getItem('fjordflix.connection')));
    assert.match(saved.token, /^[A-Za-z0-9_-]{43}$/);
    const authorized = await fetch(origin + '/tv-api/state', {headers: {Authorization: 'Bearer ' + saved.token}});
    assert.equal(authorized.status, 200);assert.equal((await authorized.json()).user.name, credentials.name);
    assert.equal((await phoneContext.cookies()).filter(cookie => cookie.name === 'fjordflix_session').length, 0);
    const consumed = await post('/tv-api/pair/poll', {device_code: pair.device_code});
    assert.ok([400, 404, 410].includes(consumed.status), 'approved polling secret is one-use');
    console.log('PASS real QR login: decoded SVG URL, 390px phone form/error/success, explicit authenticated approval, Xbox bearer session and one-use polling');
    await xbox.locator('#logout').click();await xbox.locator('#login').waitFor();
    const cancelledPair = await startPair();
    const cancellation = xbox.waitForResponse(res => res.url() === origin + '/tv-api/pair/cancel' && res.request().method() === 'POST');
    await xbox.locator('#phone-cancel').click();
    assert.equal((await cancellation).status(), 200);
    assert.ok(await xbox.locator('#phone-panel').isHidden());
    const cancelledApproval = await post('/tv-api/pair/approve', {user_code: cancelledPair.user_code, ...credentials}, {Origin: origin});
    assert.ok([400, 404, 410].includes(cancelledApproval.status), 'cancelled user code cannot approve login');
    assert.deepEqual(errors, []);
    console.log('PASS pairing boundaries: wrong credentials rejected, cross-origin approval blocked, no phone bearer/cookie, cancellation invalidates code; no browser errors');
    await phoneContext.close();await xboxContext.close();
    await clientFailureStates(browser);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {server.kill();await serverExit;}
    // Only remove this test's exact, freshly-created temporary directory.
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('fjordflix-pairing-e2e-'));
    await fs.promises.rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
})().catch(error => {console.error(error);process.exitCode = 1;});

async function clientFailureStates(browser) {
  const mockOrigin = 'https://pair-state.test';
  const headers = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type'};
  const pair = {device_code: 'd'.repeat(43), user_code: 'ABCD-EFGH', verification_uri: mockOrigin + '/tv-login',
    qr_data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="white"/></svg>').toString('base64'), expires_in: 300, interval: 3};
  async function scenario(mode) {
    const context = await browser.newContext({viewport: {width: 1280, height: 720}}), page = await context.newPage();
    const errors = [], cancelled = [], logouts = [];
    let createCount = 0, markCreate, releaseCreate, markPoll, releasePoll;
    const createStarted = new Promise(resolve => markCreate = resolve), createGate = new Promise(resolve => releaseCreate = resolve);
    const pollStarted = new Promise(resolve => markPoll = resolve), pollGate = new Promise(resolve => releasePoll = resolve);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(mockOrigin + '/**', async route => {
      const req = route.request(), endpoint = new URL(req.url()).pathname;
      const json = (value, status = 200) => route.fulfill({status, headers, contentType: 'application/json', body: JSON.stringify(value)});
      if (req.method() === 'OPTIONS') return json({});
      if (endpoint.endsWith('/pair/start')) {
        createCount++;markCreate();
        if (mode === 'create-race') await createGate;
        if (mode === 'old-server') return json({detail: 'Not found'}, 404);
        return json({...pair, expires_in: mode === 'expires' && createCount === 1 ? 1 : 300});
      }
      if (endpoint.endsWith('/pair/cancel')) {cancelled.push(req.postDataJSON());return json({ok: true});}
      if (endpoint.endsWith('/pair/poll')) {
        markPoll();
        if (mode === 'poll-race') {await pollGate;return json({status: 'approved', token: 't'.repeat(43)});}
        return json({status: 'pending'});
      }
      if (endpoint.endsWith('/logout')) {logouts.push(req.headers().authorization);return json({ok: true});}
      return json({});
    });
    await page.goto(pathToFileURL(path.join(xboxRoot, 'dist/app/index.html')).href);
    await page.evaluate(base => {TVPhoneLogin.start(base);}, mockOrigin);
    return {context, page, errors, cancelled, logouts, createStarted, releaseCreate, pollStarted, releasePoll, get createCount() {return createCount;}};
  }
  const expired = await scenario('expires');
  await expired.page.locator('#phone-retry').waitFor({state: 'visible'});
  assert.match(await expired.page.locator('#phone-status').textContent(), /udløbet/);
  assert.ok(await expired.page.locator('#phone-qr').isHidden());
  await expired.page.locator('#phone-retry').click();
  await expired.page.locator('#phone-qr').waitFor({state: 'visible'});
  assert.equal(expired.createCount, 2);assert.ok(await expired.page.locator('#phone-retry').isHidden());
  await expired.page.locator('#phone-cancel').click();
  assert.deepEqual(expired.errors, []);await expired.context.close();
  const old = await scenario('old-server');
  await old.page.locator('#phone-retry').waitFor({state: 'visible'});
  assert.match(await old.page.locator('#phone-status').textContent(), /Opdatér FjordFlix-serveren/);
  await old.page.locator('#phone-cancel').click();assert.ok(await old.page.locator('#login-form').isVisible());
  assert.deepEqual(old.errors, []);await old.context.close();
  const creating = await scenario('create-race');
  await creating.createStarted;
  await creating.page.locator('#phone-cancel').click();
  const cancelled = creating.page.waitForResponse(res => res.url().endsWith('/pair/cancel') && res.request().method() === 'POST');
  creating.releaseCreate();await cancelled;
  assert.equal(creating.cancelled[0].device_code, pair.device_code);
  assert.ok(await creating.page.locator('#phone-panel').isHidden());
  assert.deepEqual(creating.errors, []);await creating.context.close();
  const polling = await scenario('poll-race');
  await polling.pollStarted;
  await polling.page.locator('#phone-cancel').click();
  const revoked = polling.page.waitForResponse(res => res.url().endsWith('/logout') && res.request().method() === 'POST');
  polling.releasePoll();await revoked;
  assert.deepEqual(polling.logouts, ['Bearer ' + 't'.repeat(43)], 'late approved token is explicitly revoked');
  assert.ok(await polling.page.locator('#login-form').isVisible());
  assert.equal(await polling.page.evaluate(() => JSON.parse(localStorage.getItem('fjordflix.connection') || '{}').token || ''), '', 'cancelled approval never persists a token');
  assert.deepEqual(polling.errors, []);await polling.context.close();
  console.log('PASS client failure states: expiry/retry, old-server fallback, cancellation during creation and revocation of late approved tokens');
}
