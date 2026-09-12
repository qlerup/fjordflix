const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const categories = require('../app/static/categories.js');
const library = require('../app/static/library-ui.js');
const {JSDOM} = require('../test-results/dropdown-deps/node_modules/jsdom');

test('Danish and English genres map to fixed categories including unknown and missing genres', () => {
  assert.deepEqual([...categories.keys({catalog:{genres:['Komedie','Action & Adventure','Sci-Fi & Fantasy']}})].sort(), ['action','comedy','scifi']);
  assert.deepEqual([...categories.keys({catalog:{genres:['Action og eventyr','Sci-fi og fantasy']}})].sort(), ['action','scifi']);
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

test('compact menu hides empty genres, keeps search stable and separates film and series selections', () => {
  const dom = new JSDOM('<div class="library-heading"><h2 id="library-title">Serier</h2></div>', {runScripts:'outside-only'});
  const w = dom.window;
  w.$ = id => w.document.getElementById(id);
  w.view = 'series';
  const items = [{catalog:{genres:['Drama']}}, {catalog:{genres:['Komedie']}}];
  let result;
  let matching = items;
  w.render = () => {result = w.renderCategories(matching, items)};
  w.eval(fs.readFileSync('app/static/categories.js','utf8'));
  w.setupCategories(); w.render();
  const select = w.$('library-genre');
  assert.equal(select.options.length, 3);
  assert.equal(w.document.querySelectorAll('.category-button').length, 0);
  select.value = 'drama'; select.onchange();
  assert.equal(result.label,'Drama');
  matching = []; w.render();
  assert.equal(result.items.length, 0);
  assert.equal(select.options.length, 3);
  assert.equal(select.value, 'drama');
  matching = items;
  w.view = 'all'; w.render();
  assert.equal(result.label,null);
  select.value = 'comedy'; select.onchange();
  assert.equal(result.items.length,1);
  w.view = 'series'; w.render();
  assert.equal(result.label,'Drama');
  w.view = 'home'; w.render();
  assert.equal(w.$('library-categories').hidden,true);
  dom.window.close();
});
