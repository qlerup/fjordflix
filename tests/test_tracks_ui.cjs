const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('../test-results/dropdown-deps/node_modules/jsdom');
const tracks = require('../app/static/tracks.js');

test('subtitle timestamps follow source time after seeking or transcoding', () => {
  const cues = [{startTime:1,endTime:2}, {startTime:2,endTime:5}, {startTime:6,endTime:8}];
  const track = {cues, removeCue(cue) {this.cues.splice(this.cues.indexOf(cue),1)}};
  tracks.shiftCues(track, 3);
  assert.deepEqual(track.cues, [{startTime:0,endTime:2}, {startTime:3,endTime:5}]);
});

test('embedded tracks have readable Danish labels and playback choices stay in sync', async () => {
  const dom = new JSDOM('<dialog id="detail"><label class="quality-label"></label><button id="play-button"></button><button id="restart-button"></button></dialog><dialog id="player-dialog"><div class="player-top"></div></dialog>', {runScripts:'outside-only'});
  const w = dom.window;
  w.$ = id => w.document.getElementById(id);
  w.updatePlan = async () => {};
  const playback = {offset:20, subtitle_delivery:null};
  w.playback = playback;
  w.position = () => 24;
  let restart, attached;
  w.startPlayback = async pos => {restart=pos};
  w.toast = () => {};
  w.eval(fs.readFileSync('app/static/tracks.js','utf8') + '; window.tracks = FjordTracks;');
  const t = w.tracks;
  t.setup();
  const audio = [{index:1,codec:'aac',language:'eng',default:true},{index:2,codec:'eac3',language:'dan',title:'Dansk lyd'}];
  const subtitles = [{index:3,codec:'subrip',language:'dan',delivery:'text'}, {index:4,codec:'hdmv_pgs_subtitle',language:'eng',delivery:'burn'}, {index:5,codec:'unknown',delivery:'unsupported'}];
  await t.prepare({id:'movie',tracks:{version:1,audio,subtitles}});
  assert.equal(w.$('detail-audio').value,'1');
  assert.equal(w.$('detail-subtitle').value,'');
  assert.match(w.$('detail-audio').options[1].textContent,/Dansk/);
  assert.equal(w.$('player-subtitle').options[3].disabled,true);
  w.$('player-audio').value='2'; await w.$('player-audio').onchange();
  assert.equal(restart,24); assert.equal(w.$('detail-audio').value,'2');
  restart = null;
  t.attach = async result => {attached=result.subtitle_track};
  w.$('player-subtitle').value='3'; await w.$('player-subtitle').onchange();
  assert.equal(attached,3); assert.equal(restart,null);
  w.$('player-subtitle').value='4'; await w.$('player-subtitle').onchange();
  assert.equal(restart,24);
  assert.equal(t.request().subtitle_track,4);
  await t.prepare({id:'next',tracks:{version:1,audio:[],subtitles:[]}});
  assert.equal(t.subtitle,null);
  assert.equal(w.$('player-subtitle').disabled,true);
  dom.window.close();
});
