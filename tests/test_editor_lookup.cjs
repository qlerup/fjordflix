const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('../test-results/dropdown-deps/node_modules/jsdom');

test('editor searches unsaved fields, shows candidates, and retains draft on no match', async () => {
  const dom = new JSDOM(fs.readFileSync('app/static/index.html','utf8'), {runScripts:'outside-only'});
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  w.$ = id => w.document.getElementById(id);
  w.setupLibraryDeletion = () => {};
  w.selected = {id:'movie',title:'Old title',catalog:{media_type:'movie'}};
  w.library = [w.selected];
  w.refresh = async () => {};
  w.openDetail = async () => {};
  const requests = [];
  w.api = async (url, method, data) => {
    requests.push(data);
    return {ok:false,message:'Choose a match',candidates:[{id:42,title:'Champ',year:'2022'}]};
  };
  w.eval(fs.readFileSync('app/static/library-ui.js','utf8'));
  w.setupLibraryUI();
  w.$('library-edit').click();
  w.$('edit-title').value = 'Champ';
  w.$('edit-date').value = '2022-01-01';
  await w.$('library-edit-refresh').onclick();
  assert.equal(requests[0].draft.title, 'Champ');
  assert.equal(requests[0].draft.release_date, '2022-01-01');
  assert.equal(w.$('edit-title').value, 'Champ');
  assert.equal(w.$('library-editor').open, true);
  const match = w.$('library-edit-matches').querySelector('button');
  assert.equal(match.textContent,'Champ (2022)');
  await match.onclick();
  assert.equal(requests[1].tmdb_id,42);
  assert.equal(w.$('library-edit-refresh').disabled, false);
  dom.window.close();
});
