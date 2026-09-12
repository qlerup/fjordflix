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

test('persistent sidebar filters without closing and remembers film and series selections', () => {
  const dom = new JSDOM('<section class="library"><div class="library-heading"><h2 id="library-title">Serier</h2></div><div id="movie-grid"></div></section>', {runScripts:'outside-only'});
  const w = dom.window;
  w.$ = id => w.document.getElementById(id);
  w.view = 'series';
  const items = [{catalog:{genres:['Drama']}}, {catalog:{genres:['Komedie']}}];
  let result, matching = items;
  w.render = () => {result = w.renderCategories(matching, items)};
  w.eval(fs.readFileSync('app/static/categories.js','utf8'));
  w.setupCategories(); w.render();
  const links = w.$('categories-links'), sidebar = w.$('library-categories');
  const choose = key => {const button = links.querySelector(`[data-category="${key}"]`); button.focus(); button.click();};
  assert.equal(sidebar.hidden,false);
  assert.equal(w.document.querySelectorAll('dialog,select,#categories-open').length,0);
  assert.ok(w.$('movie-grid').closest('.library-results'));
  assert.equal(links.children.length,3);
  choose('drama');
  assert.equal(result.label,'Drama');
  assert.equal(sidebar.hidden,false);
  assert.equal(w.document.activeElement.dataset.category,'drama');
  matching = []; w.render();
  assert.equal(result.items.length,0);
  assert.equal(links.children.length,3);
  matching = items;
  w.view = 'all'; w.render();
  assert.equal(result.label,null);
  choose('comedy');
  assert.equal(result.items.length,1);
  w.view = 'series'; w.render();
  assert.equal(result.label,'Drama');
  w.view = 'home'; w.render();
  assert.equal(sidebar.hidden,false);
  assert.equal(w.$('sidebar-genres').hidden,true);
  assert.equal(w.document.querySelector('[data-side-view="home"]').getAttribute('aria-current'),'page');
  const header = w.document.createElement('header');
  header.innerHTML = '<button data-view="all">Film</button>';
  w.document.body.append(header);
  header.firstChild.onclick = () => {w.view = 'all'; w.render();};
  w.document.querySelector('[data-side-view="all"]').click();
  assert.equal(w.view,'all');
  assert.equal(w.$('sidebar-genres').hidden,false);
  assert.equal(result.label,'Komedie');
  dom.window.close();
});
