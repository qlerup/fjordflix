const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const options = require('../audio-options.cjs');
const mpv = path.resolve(__dirname, '../vendor/mpv/mpv.com');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const encoder = spawnSync(ffmpeg, ['-version'], {windowsHide:true});

test('bundled player sends Dolby bitstreams and still decodes ordinary PCM',
  {skip:!fs.existsSync(mpv) || encoder.status !== 0}, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fjordflix-audio-'));
    try {
      for (const codec of ['ac3','eac3','truehd','pcm_s16le']) {
        const source = path.join(folder, codec + '.mkv');
        const made = spawnSync(ffmpeg, ['-v','error','-f','lavfi','-i',
          'anullsrc=r=48000:cl=5.1','-t','0.5','-c:a',codec,'-strict','-2',source],
          {windowsHide:true, encoding:'utf8', timeout:15000});
        assert.equal(made.status, 0, made.stderr);
        // Null output verifies the real encoded audio path without claiming HDMI
        // receiver support or producing sound on the developer's computer.
        const played = spawnSync(mpv, ['--no-config',...options,'--ao=null',
          '--no-video','--audio-display=no',source],
          {windowsHide:true, encoding:'utf8', timeout:15000});
        const output = played.stdout + played.stderr;
        assert.equal(played.status, 0, output);
        assert.match(output, /AO: \[null\]/);
        if (codec === 'pcm_s16le') assert.doesNotMatch(output, /AO:.*spdif-/);
        else assert.match(output, new RegExp('AO:.*spdif-' + codec));
      }
    } finally {
      // Only this test's explicit files in its own generated temp directory.
      for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder,name));
      fs.rmdirSync(folder);
    }
  });
