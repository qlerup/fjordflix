const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = require('../app/static/library-ui.js');
const ep = (id,s,e,position=0) => ({id,title:`Show S${s}E${e}`,duration:100,position,series_key:'local:show:',catalog:{series_title:'Show',season:s,episode:e}});
test('opening a single cached suggestion retries automatically once, without forcing its ID', () => {
  const nodes = {}, queued = [], calls = [];
  const element = () => ({hidden:false, children:[], setAttribute(){}, addEventListener(){},
    replaceChildren(...children){this.children=children}, append(...children){this.children.push(...children)}});
  const movie = {id:'film', title:'Piger I Troejen 2', catalog:{status:'unmatched',
    candidates:[{id:42,title:'Piger i trøjen 2',year:'1976'}]}};
  const context = vm.createContext({$: id => nodes[id] ||= element(), selected:movie,
    state:{user:{admin:true}}, document:{createElement:element}, queueMicrotask:fn=>queued.push(fn),
    calls, module:{exports:{}}});
  vm.runInContext(fs.readFileSync(require.resolve('../app/static/library-ui.js'),'utf8'),context);
  vm.runInContext('selectMetadataMatch = (...args) => calls.push(args)',context);
  context.showCatalogStatus(movie);
  context.showCatalogStatus(movie);
  assert.equal(queued.length,1);
  queued.shift()();
  assert.equal(calls.length,1);
  assert.equal(calls[0].length,0);
  context.showCatalogStatus(movie);
  assert.equal(queued.length,0); // Failed refreshes do not loop.
  for (const variant of [
    {...movie,id:'manual',catalog:{...movie.catalog,manual:true}},
    {...movie,id:'many',catalog:{...movie.catalog,candidates:[{id:1},{id:2}]}},
    {...movie,id:'matched',catalog:{...movie.catalog,status:'matched'}}
  ]) { context.selected=variant; context.showCatalogStatus(variant); }
  assert.equal(queued.length,0);
  context.state.user.admin=false;
  context.selected={...movie,id:'viewer'};
  context.showCatalogStatus(context.selected);
  assert.equal(queued.length,0);
  context.state.user.admin=true;
  context.selected={...movie,id:'navigated'};
  context.showCatalogStatus(context.selected);
  context.selected=null;
  queued.shift()();
  assert.equal(calls.length,1);
});
test('source quality badges distinguish cropped 4K, Atmos, channels and mixed series', () => {
  const movie = {width:3840,height:1600,audio:'eac3',quality:{dynamic_range:'Dolby Vision',dolby_atmos:true}};
  assert.deepEqual(ui.qualityBadges(movie).labels, ['4K','Dolby Vision','Dolby Atmos']);
  const episode = {width:1920,height:1080,audio:'aac',quality:{dynamic_range:'SDR',audio_channels:2}};
  assert.deepEqual(ui.qualityLabels(episode), ['1080p','SDR','AAC Stereo']);
  assert.deepEqual(ui.qualityLabels({...episode,audio:'eac3',quality:{audio_channels:6,audio_layout:'5.1(side)'}}), ['1080p','Dolby Digital Plus 5.1']);
  assert.equal(ui.qualityBadges({...episode,isSeries:true,episodes:[episode,movie]}).labels.at(-1), 'Varierer');
  assert.equal(ui.qualityBadges({...episode,isSeries:true,episodes:[episode,episode]}).labels.includes('Varierer'), false);
});
test('HDR tags distinguish Dolby Vision from a confirmed HDR10 base layer', () => {
  const label = quality => ui.dynamicRangeLabel({hdr:true,quality});
  for (const dynamic_range of ['HDR10','HDR10+','HLG']) assert.equal(label({dynamic_range}), 'HDR');
  const dv = {dynamic_range:'Dolby Vision'};
  assert.equal(label({...dv,dv_profile:7,dv_bl:true}), 'Dolby Vision/HDR');
  assert.equal(label({...dv,dv_profile:7}), 'Dolby Vision/HDR');
  assert.equal(label({...dv,dv_profile:8,dv_bl:true,dv_bl_signal_compatibility_id:1}), 'Dolby Vision/HDR');
  assert.equal(label({...dv,dv_profile:7,dv_bl:false}), 'Dolby Vision');
  assert.equal(label({...dv,dv_profile:5}), 'Dolby Vision');
  for (const compatibility of [undefined,0,2,4]) {
    assert.equal(label({...dv,dv_profile:8,dv_bl_signal_compatibility_id:compatibility}), 'Dolby Vision');
  }
  assert.equal(label(dv), 'Dolby Vision');
  assert.equal(label({dynamic_range:'SDR'}), 'SDR');
  assert.equal(ui.dynamicRangeLabel({hdr:true}), 'HDR');
  assert.equal(ui.dynamicRangeLabel({hdr:false}), null);
  assert.ok(ui.qualityBadges({quality:{...dv,dv_profile:7}}).labels.includes('Dolby Vision/HDR'));
});

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

test('episode picker uses readable episode numbers and keeps TMDB status visible to admins', () => {
  const nodes = {};
  const element = () => ({textContent:'', dataset:{}, attributes:{}, children:[], scrollLeft:0, clientWidth:500, scrollWidth:500,
    replaceChildren(...children) {this.children = children}, append(...children) {this.children.push(...children)},
    setAttribute(k,v) {this.attributes[k]=v}, addEventListener() {}, focus() {this.focused=true},
    querySelector() {return null}});
  const $ = id => nodes[id] ||= element();
  const episode = ep('arrow',3,2);
  episode.catalog.lookup_message = 'TMDB afviste API-nøglen.';
  const context = vm.createContext({$, state:{user:{admin:true}}, library:[episode,ep('next',3,3),ep('other-season',4,1)], clock:()=> '0:08',
    document:{createElement:element}, requestAnimationFrame:fn=>fn(),
    Option: function(text,value) {this.text = text; this.value = value}});
  vm.runInContext(fs.readFileSync(require.resolve('../app/static/library-ui.js'), 'utf8'), context);
  context.showEpisodePicker(episode);
  const cards = nodes['series-episodes'].children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].children[1].textContent, 'Afsnit 2');
  assert.equal(cards[0].children[0].src, '/api/movies/arrow/episode-still?v=0');
  assert.equal(cards[0].dataset.episodeId, 'arrow');
  assert.equal(cards[0].attributes['aria-pressed'], 'true');
  assert.equal(cards[1].attributes['aria-pressed'], 'false');
  let opened;
  context.openDetail = movie => {opened=movie; context.showEpisodePicker(movie)};
  cards[1].onclick();
  assert.equal(opened.id, 'next');
  assert.equal(nodes['series-episodes'].children[1].focused, true);
  context.showEpisodePicker(episode);
  assert.equal(nodes['series-season'].children[0].text, 'Sæson 3');
  assert.equal(nodes['detail-catalog-status'].textContent, 'TMDB afviste API-nøglen.');
  assert.equal(nodes['metadata-refresh'].hidden, false);
  vm.runInContext("metadataRefreshPending.add('arrow')", context);
  context.showEpisodePicker(episode);
  assert.equal(nodes['metadata-refresh'].disabled, true);
  assert.match(nodes['detail-catalog-status'].textContent, /Henter/);
  vm.runInContext("metadataRefreshPending.delete('arrow'); selectMetadataMatch = id => chosenId = id;", context);
  episode.catalog.last_lookup = {status:'unmatched', candidates:[{id:1412,title:'Arrow',year:'2012',overview:'Series description',poster_url:'https://image.tmdb.org/t/p/w185/valid.jpg'}]};
  context.showEpisodePicker(episode);
  assert.equal(nodes['metadata-matches'].hidden, false);
  const match = nodes['metadata-match-list'].children[0];
  assert.equal(match.children[1].children[0].textContent, 'Arrow (2012)');
  match.onclick();
  assert.equal(context.chosenId,1412);
  context.state.user.admin = false;
  context.showEpisodePicker(episode);
  assert.equal(nodes['metadata-refresh'].hidden, true);
  assert.equal(nodes['detail-catalog-status'].hidden, true);
  assert.equal(nodes['metadata-matches'].hidden, true);
});
