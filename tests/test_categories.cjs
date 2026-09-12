const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const categories = require('../app/static/categories.js');
const library = require('../app/static/library-ui.js');
const {JSDOM} = require('../test-results/dropdown-deps/node_modules/jsdom');

test('Danish and English genres map to fixed categories including unknown and missing genres', () => {
  assert.deepEqual([...categories.keys({catalog:{genres:['Komedie','Action & Adventure','Sci-Fi & Fantasy']}})].sort(), ['action','adventure','comedy','fantasy','scifi']);
  assert.deepEqual([...categories.keys({catalog:{genres:[' ', 'Custom', 'Drama']}})], ['other','drama']);
  assert.deepEqual([...categories.keys({})], ['none']);
});

test('series combine genres across episodes and count only once', () => {
  const episodes = ['Drama','Action','Drama'].map((genre, i) => ({id:String(i),title:'Flash',series_key:'flash',catalog:{season:1,episode:i+1,genres:[genre]}}));
  const cards = library.cards(episodes);
  assert.equal(categories.filter(cards,'drama').length,1);
  assert.equal(categories.filter(cards,'action').length,1);
  assert.equal(categories.filter(cards,'none').length,0);
});

test('category controls preserve focus, separate film and series selections, and show empty categories', () => {
  const dom = new JSDOM('<div class="library-heading"></div>', {runScripts:'outside-only'});
  const w = dom.window;
  w.$ = id => w.document.getElementById(id);
  w.view = 'series';
  const items = [{catalog:{genres:['Drama']}}];
  let result;
  w.render = () => {result = w.renderCategories(items)};
  w.eval(fs.readFileSync('app/static/categories.js','utf8'));
  w.setupCategories(); w.render();
  const button = w.document.querySelector('[data-category="drama"]');
  button.focus(); button.click();
  assert.equal(w.document.activeElement,button);
  assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.equal(result.label,'Drama');
  w.view = 'all'; w.render();
  assert.equal(result.label,null);
  w.document.querySelector('[data-category="comedy"]').click();
  assert.equal(result.items.length,0);
  w.view = 'series'; w.render();
  assert.equal(result.label,'Drama');
  w.view = 'home'; w.render();
  assert.equal(w.$('library-categories').hidden,true);
  dom.window.close();
});
