const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require('playwright');
test('library reindex button starts selected source and reflects running scans', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/static/settings.js'), 'utf8');
  const load = source.slice(source.indexOf('  async function loadSources()'), source.indexOf('  async function browse('));
  const browser = await chromium.launch();
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      await page.setContent('<div id="source-list"></div><button id="source-scan"></button><p id="source-status"></p><p id="source-error"></p>');
      await page.addStyleTag({path:path.join(__dirname,'../app/static/settings.css')});
      await page.evaluate(() => {
        window.$ = id => document.getElementById(id);
        window.timer = null; window.dialog = {open:false};
        window.refresh = async () => {}; window.fail = error => {throw error;};
        window.requests = []; window.running = false;
        window.api = async (url,method) => {
          if (method === 'POST') { window.requests.push(url); window.running = true; }
          return {sources:[{id:'test-source',path:'/library/Series',count:2,available:true}],scan:{running:window.running,added:0,updated:2,errors:[]}};
        };
      });
      await page.addScriptTag({content:load});
      await page.evaluate(() => loadSources());
      const button = page.getByRole('button',{name:'Genindeksér mappen /library/Series'});
      await button.click();
      await page.waitForFunction(() => document.querySelector('#source-list button').disabled);
      assert.deepEqual(await page.evaluate(() => window.requests), ['/admin/library/test-source/reindex']);
      assert.equal(await page.locator('#source-scan').isDisabled(), true);
      await page.evaluate(() => { window.running = false; return loadSources(); });
      assert.equal(await button.isEnabled(), true);
      await page.close();
    }
  } finally { await browser.close(); }
});
