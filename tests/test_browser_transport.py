"""Browser transport contracts and real FFmpeg round trips (no simulated GPU)."""
import copy
import json
import subprocess

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from app import main, media
from test_series import client
from test_tracks import mkv
from test_airplay import receiver_setup


@pytest.mark.parametrize('codec,tag', [('h264','hvc1'), ('hevc','hvc1'), ('hevc','hev1'), ('av1','hvc1'), ('vp9','hvc1')])
def test_browser_fmp4_round_trip(client, mkv, receiver_setup, monkeypatch, codec, tag):
    monkeypatch.setattr(media, "config", lambda: ("http://video.test", "http://testserver"))
    mid, source, meta = mkv
    if codec != 'h264':
        target = source.with_name('browser-source.mkv')
        encoder = {'hevc':['libx265','-preset','ultrafast','-x265-params','pools=1:frame-threads=1'],
                   'av1':['libaom-av1','-cpu-used','8','-crf','40'],
                   'vp9':['libvpx-vp9','-deadline','realtime','-cpu-used','8']}[codec]
        subprocess.run(['ffmpeg','-v','error','-i',str(source),'-t','6','-map','0:v:0','-map','0:a:0',
                        '-c:v',*encoder,'-threads','1','-g','24','-c:a','copy','-y',str(target)],
                       check=True,capture_output=True,timeout=45)
        meta = main.probe(target)
        with main.db() as conn:
            conn.execute('UPDATE movies SET path=?,metadata=? WHERE id=?', (str(target),json.dumps(meta),mid))
    response = client.post(f'/api/movies/{mid}/play', json={
        'quality':'auto','video_copy':True,'browser_profile':1,'browser_fmp4':True,
        'browser_hevc_tag':tag,'audio_copy':True,'audio_track':1})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['mode'] == 'Direct Stream'
    assert result['audio_output']['copied'] is True
    job = main.JOBS[result['session']]
    job['process'].wait(timeout=20)
    assert job['process'].returncode == 0, (job['folder']/'ffmpeg.log').read_text()
    assert job['transport'] == 'fmp4'
    playlist = job['folder']/'index.m3u8'
    assert '#EXT-X-MAP:' in playlist.read_text()
    info = json.loads(subprocess.run(['ffprobe','-v','error','-show_streams','-of','json',str(playlist)],
                                    check=True,capture_output=True,timeout=20).stdout)
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    assert video['codec_name'] == codec
    assert (video['width'],video['height']) == (meta['width'],meta['height'])
    if codec == 'hevc':
        assert video['codec_tag_string'] == tag
    subprocess.run(['ffmpeg','-v','error','-i',str(playlist),'-t','1','-f','null','-'],
                   check=True,capture_output=True,timeout=20)
    # Init and media segments must also pass the cookie-free receiver ticket path.
    from urllib.parse import urlsplit
    url = result['url']
    assert urlsplit(url).path.startswith('/media/') and result['media_ticket'] in url
    assert not receiver_setup.cookies
    invalid = url.replace(result['media_ticket'], '0' * 43)
    assert receiver_setup.get(invalid).status_code == 401
    response = receiver_setup.get(url)
    assert response.status_code == 200
    import re
    init = re.search(r'#EXT-X-MAP:URI="([^"]+)"', response.text).group(1)
    segment = next(line for line in response.text.splitlines() if line and not line.startswith('#'))
    for name in (init, segment):
        assert receiver_setup.get(url.rsplit('/',1)[0]+'/'+name).status_code == 200


def test_new_codecs_require_explicit_browser_transport(client, mkv):
    _, _, meta = mkv
    for codec in ('av1','vp9'):
        source = {**meta,'video':codec}
        assert main.decide(source,main.Playback(video_copy=True))['mode'] == 'Transcoding'
        assert main.decide(source,main.Playback(video_copy=True,browser_profile=1,browser_fmp4=True))['mode'] == 'Direct Stream'


def test_resolution_change_does_not_copy_fmp4_only_audio_into_ts(client, mkv):
    _, _, meta = mkv
    result = main.decide(meta,main.Playback(quality='720',video_copy=True,browser_profile=1,browser_fmp4=True,audio_copy=True))
    assert result['mode'] == 'Transcoding'
    assert result['audio_output']['copied'] is False


def test_subtitle_burn_still_requires_transcoding(client, mkv):
    _, _, meta = mkv
    source = copy.deepcopy(meta)
    source['tracks']['subtitles'][0]['delivery'] = 'burn'
    result = main.decide(source,main.Playback(video_copy=True,browser_profile=1,browser_fmp4=True,subtitle_track=3))
    assert result['mode'] == 'Transcoding'


def test_browser_dolby_vision_does_not_silently_use_an_unverified_tone_mapper(client, mkv):
    _, _, meta = mkv
    source = {**meta,'video':'hevc','hdr':True,'quality':{'dynamic_range':'Dolby Vision','dv_profile':5}}
    with pytest.raises(HTTPException) as error:
        main.decide(source,main.Playback(browser_profile=1))
    assert error.value.status_code == 400
    # Existing client policy is deliberately not changed by the browser opt-in.
    assert main.decide(source,main.Playback())['mode'] == 'Transcoding'


def test_browser_hevc_sample_entry_is_allowlisted():
    with pytest.raises(ValidationError):
        main.Playback(browser_hevc_tag='arbitrary-ffmpeg-argument')
    with pytest.raises(ValidationError):
        main.Playback(browser_profile=999)
