const {test} = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../app/static/library-ui.js');
const ep = (id,s,e,position=0) => ({id,title:`Show S${s}E${e}`,duration:100,position,series_key:'local:show:',catalog:{series_title:'Show',season:s,episode:e}});
test('one card per series, natural episode ordering, sparse seasons and duplicates', () => {
  const items = [ep('a',2,10),ep('b',1,2),ep('c',1,10),ep('d',0,1),ep('e',1,2),{id:'film',title:'Film'}];
  const cards = ui.cards(items);
  assert.equal(cards.length,2);
  assert.deepEqual(cards[0].episodes.map(m => m.id),['d','b','e','c','a']);
  assert.equal(cards[0].seasonCount,3);
  assert.equal(ui.matches(cards[0], 's2e10'),true);
});
test('continue selection remains per file, and favorites group without losing episodes', () => {
  const a=ep('a',1,1,100), b=ep('b',1,2,20), c=ep('c',2,1);
  c.favorite=true;
  const card=ui.cards([c,a,b])[0];
  assert.equal(card.id,'b'); assert.equal(card.favorite,true); assert.equal(card.episodes.length,3);
  assert.equal(ui.code(b),'S01E02');
});
