const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('../test-results/dropdown-deps/node_modules/jsdom');

test('background results wait for an open dropdown and preserve controls and episode nodes', async () => {
  const dom = new JSDOM(`<section id="detail"><h1 id="detail-title"></h1><p id="detail-episode"></p>
    <p id="detail-description"></p><p id="series-overview"></p><img id="detail-poster"><div id="detail-art"></div>
    <label>Quality<select id="quality"><option value="auto">Auto</option><option value="1080">1080p</option></select></label>
    <div id="series-episodes"><button data-episode-id="episode"><img><span class="episode-name">Old</span></button></div></section>`,
    {runScripts:'outside-only',pretendToBeVisual:true});
  const w = dom.window;
  try {
    w.HTMLElement.prototype.scrollIntoView = function() {};
    w.$ = id => w.document.getElementById(id);
    const old = {id:'episode',title:'Old',catalog:{media_type:'tv',season:1,episode:2,series_refresh_pending:42}};
    const fresh = {...old,title:'New',catalog:{media_type:'tv',season:1,episode:2,series_title:'Show',episode_title:'New episode',overview:'Own plot',artwork_updated:10}};
    w.selected = old; w.library = [old]; w.state = {user:{admin:true}};
    w.playback = null;
    w.eval(fs.readFileSync('app/static/library-ui.js','utf8'));
    let statusUpdates = 0, renders = 0, requests = 0;
    w.showCatalogStatus = () => statusUpdates++;
    w.render = () => renders++;
    w.api = async () => {requests++; return [fresh];};
    let poll;
    w.setInterval = fn => {poll = fn;};
    const app = fs.readFileSync('app/static/app.js','utf8');
    w.eval(app.slice(app.indexOf('let seriesMetadataPolling'),app.indexOf('function render()')));
    w.eval(fs.readFileSync('app/static/selects.js','utf8'));
    await new Promise(resolve => setTimeout(resolve,0));
    const select = w.$('quality'), card = w.$('series-episodes').firstElementChild;
    select.value = '1080';
    w.$('series-episodes').scrollLeft = 137;
    const button = w.document.querySelector('.fx-select-button');
    button.click();
    const focused = w.document.activeElement;
    await poll();
    assert.equal(button.getAttribute('aria-expanded'),'true');
    assert.equal(w.document.activeElement,focused);
    assert.equal(statusUpdates,0);
    button.click();
    await poll(); // All episodes have finished: still apply the deferred last response.
    assert.equal(requests,1);
    assert.equal(statusUpdates,1);
    assert.equal(renders,0);
    assert.equal(w.selected,old);
    assert.equal(select.value,'1080');
    assert.equal(w.$('series-episodes').firstElementChild,card);
    assert.equal(w.$('series-episodes').scrollLeft,137);
    assert.equal(card.querySelector('.episode-name').textContent,'New episode');
    assert.equal(w.$('detail-description').textContent,'Own plot');
    await poll();
    assert.equal(statusUpdates,1);
  } finally {dom.window.close();}
});
