const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../tv/capabilities.js'),'utf8');
function detect(device){const window={SamsungPlatform:{device}};vm.runInNewContext(source,{window,Promise});return window.TVCapabilities;}
const video={canPlayType:()=>''};
const movie={video:'hevc',audio:'aac',format:'matroska',pix_fmt:'yuv420p10le',width:3840,height:2160,bitrate:25e6,quality:{dynamic_range:'HDR10',frame_rate:'24/1',video_level:153}};
test('native UHD/HDR10 2018 Samsung preserves HEVC but never promises DTS or TrueHD',()=>{
  const caps=detect({native:true,uhd:true,hdr10:true});
  assert.equal(caps(movie,video,'original',false).direct,true);
  const dts=caps({...movie,audio:'dts'},video,'original',false);assert.equal(dts.direct,false);assert.equal(dts.video_copy,true);assert.equal(dts.audio_copy,false);
  assert.equal(caps({...movie,audio:'truehd'},video,'auto',false).audio_copy,false);
  assert.equal(caps(movie,video,'auto','remux').video_copy,true);
  assert.equal(caps(movie,video,'auto',true).video_copy,false);
  assert.equal(caps(movie,video,'original',true).quality,'original');
});
test('FHD panel, missing HDR, unsupported Dolby Vision, level and rate limits do not force native playback',()=>{
  assert.equal(detect({native:true,uhd:false,hdr10:true})(movie,video,'auto',false).direct,false);
  assert.equal(detect({native:true,uhd:true,hdr10:false})(movie,video,'auto',false).video_copy,false);
  const caps=detect({native:true,uhd:true,hdr10:true});
  for(const quality of [{dynamic_range:'Dolby Vision'},{video_level:186},{frame_rate:'120/1'}])assert.equal(caps({...movie,quality:{...movie.quality,...quality}},video,'auto',false).video_copy,false);
  assert.equal(caps({...movie,bitrate:100e6},video,'auto',false).video_copy,false);
});
test('selected audio track negotiates independently; ordinary browser uses its real decoder test',()=>{
  const caps=detect({native:true,uhd:true,hdr10:true});
  const m={...movie,tracks:{audio:[{index:2,codec:'truehd',default:true},{index:4,codec:'aac'}]}};
  assert.equal(caps(m,video,'auto',false,null,4).direct,true);assert.equal(caps(m,video,'auto',false,null,4).audio_track,4);
  assert.equal(detect({native:false})(movie,video,'auto',false).video_copy,false);
  const baseline={...movie,video:'h264',pix_fmt:'yuv420p',format:'mp4',width:1920,height:1080,bitrate:8e6,quality:{dynamic_range:'SDR',frame_rate:'24/1'}};
  assert.equal(detect({native:false})(baseline,{canPlayType:()=>'probably'},'auto',false).direct,true);
});
