"""Xbox playback profile, real HEVC fMP4 delivery and scoped media access."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from test_tv import tv_client, login, main


def hevc_meta(**extra):
    return {'width':3840, 'height':2160, 'video':'hevc', 'audio':'ac3',
            'format':'matroska,webm', 'pix_fmt':'yuv420p10le', 'hdr':True,
            'bitrate':40000000, **extra}


def test_stream_progress_is_owner_scoped_and_private(tv_client, tmp_path):
    client, credentials, mid = tv_client
    _, headers = login(client, credentials)
    with main.db() as conn:
        uid = conn.execute('SELECT id FROM users WHERE name=?', (credentials['name'],)).fetchone()[0]
    sid = 'diagnostic-test'
    (tmp_path / 'progress.txt').write_text('out_time_us=6000000\nspeed=0.75x\nprogress=continue\n')
    main.JOBS[sid] = {'user':uid, 'folder':tmp_path, 'touch':0}
    try:
        assert client.post(f'/tv-api/streams/{sid}/heartbeat').status_code == 401
        response = client.post(f'/tv-api/streams/{sid}/heartbeat',headers=headers)
        assert response.status_code == 200
        assert response.json() == {'ok':True,'transcoding':{'finished':False,'speed':0.75,'encoded_seconds':6}}
        assert str(tmp_path) not in response.text
        with pytest.raises(main.HTTPException) as foreign:
            main.heartbeat(sid, {'id':'someone-else'})
        assert foreign.value.status_code == 404
    finally:
        main.JOBS.pop(sid, None)


@pytest.mark.parametrize('quality', ['auto', 'original', '2160'])
def test_xbox_transcode_is_full_hd_but_hevc_copy_preserves_4k(quality):
    data = main.Playback(client_profile='xbox', quality=quality)
    fallback = main.decide(hevc_meta(), data)
    assert fallback['mode'] == 'Transcoding'
    assert (fallback['height'], fallback['mbps']) == (1080, 8)
    assert 'Xbox' in fallback['reason'] and '1920 × 1080' in fallback['reason']
    for direct in (False, True):
        copied = main.decide(hevc_meta(), data.model_copy(update={'direct':direct, 'video_copy':True}))
        assert copied['mode'] == ('Direct Play' if direct else 'Direct Stream')
        assert copied['height'] == 2160 and copied['mbps'] == 40


def test_xbox_wide_video_stays_inside_1920_by_1080_and_manual_lower_quality_survives():
    meta = hevc_meta(height=1608)
    plan = main.decide(meta, main.Playback(client_profile='xbox', quality='original'))
    assert plan['height'] == 804  # 3840:1608 -> 1920:804, not 2580:1080.
    lower = main.decide(meta, main.Playback(client_profile='xbox', quality='720'))
    assert (lower['height'], lower['mbps']) == (720, 4)
    default = main.decide(meta, main.Playback(quality='original'))
    assert (default['height'], default['mbps']) == (1608, 25)


def test_bitmap_burn_reason_takes_precedence_over_decoder_reason():
    meta = hevc_meta(tracks={'subtitles':[{'index':2, 'delivery':'burn'}]})
    plan = main.decide(meta, main.Playback(client_profile='xbox', quality='original',
                      video_copy=True, subtitle_track=2, capability_reason='A decoder probe message'))
    assert plan['mode'] == 'Transcoding' and plan['height'] == 1080
    assert 'billedbaserede undertekster' in plan['reason']
    assert 'decoder probe' not in plan['reason']


def test_profile_contract_is_optional_and_validated(tv_client):
    client, credentials, mid = tv_client
    info = client.get('/tv-api/info').json()
    assert info['version'] == 1 and 'xbox-hevc-fmp4' in info['features']
    assert info['playback_profiles'] == ['default', 'xbox']
    _, headers = login(client, credentials)
    assert client.post(f'/tv-api/movies/{mid}/plan', headers=headers,
                       json={'client_profile':'anything'}).status_code == 422
    assert client.post(f'/tv-api/movies/{mid}/plan', headers=headers,
                       json={'client_profile':None}).status_code == 422
    assert client.post(f'/tv-api/movies/{mid}/plan', headers=headers,
                       json={'direct':True}).json()['mode'] == 'Direct Play'


def test_xbox_wide_4k_fallback_encodes_actual_full_hd_frames(tv_client, monkeypatch):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg and ffprobe are required for fallback encoding verification.')
    client, credentials, mid = tv_client
    monkeypatch.setattr(main, 'GPU', False)
    row, _ = main.movie(mid)
    source = Path(row['path'])
    subprocess.run(['ffmpeg','-v','error','-nostdin','-f','lavfi','-i',
                    'color=c=blue:s=3840x1608:r=12:d=1','-c:v','libx264','-preset','ultrafast',
                    '-pix_fmt','yuv420p','-y',str(source)],check=True,capture_output=True,timeout=30)
    meta = main.probe(source)
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(meta),mid))
    (main.DATA/'streams').mkdir(exist_ok=True)
    _, headers = login(client,credentials)
    response = client.post(f'/tv-api/movies/{mid}/play',headers=headers,
                           json={'client_profile':'xbox','quality':'original'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['mode'] == 'Transcoding' and result['height'] == 804
    try:
        job = main.JOBS[result['session']]
        job['process'].wait(timeout=15)
        measured = client.post(f'/tv-api/streams/{result["session"]}/heartbeat',headers=headers).json()['transcoding']
        assert measured['finished'] and measured['encoded_seconds'] > 0
        assert measured['speed'] > 0
        inspected = subprocess.run(['ffprobe','-v','error','-show_streams','-of','json',
                                    str(job['folder']/'index.m3u8')],check=True,capture_output=True,timeout=20)
        video = next(s for s in json.loads(inspected.stdout)['streams'] if s['codec_type']=='video')
        assert (video['width'],video['height']) == (1920,804)
        assert video['codec_name'] == 'h264'
    finally:
        main.stop_job(result['session'])


@pytest.mark.parametrize('extension,formats,content_type', [
    ('.mp4', 'mov,mp4,m4a,3gp,3g2,mj2', 'video/mp4'),
    ('.mkv', 'matroska,webm', 'video/x-matroska'),
    ('.webm', 'matroska,webm', 'video/webm'),
])
def test_original_file_content_type_and_ticket_scope(tv_client, extension, formats, content_type):
    client, credentials, mid = tv_client
    row, meta = main.movie(mid)
    old_path = Path(row['path'])
    path = old_path.with_suffix(extension)
    if path != old_path:
        path.write_bytes(old_path.read_bytes())
    meta['format'] = formats
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=? WHERE id=?', (str(path),json.dumps(meta),mid))
    _, headers = login(client, credentials)
    result = client.post(f'/tv-api/movies/{mid}/play', headers=headers,
                         json={'direct':True,'client_profile':'xbox'}).json()
    response = client.get(result['url'], headers={'Range':'bytes=0-9'})
    assert response.status_code == 206 and response.content == b'0123456789'
    assert response.headers['content-type'] == content_type
    assert client.get(result['url'].replace(mid,'0'*32)).status_code == 403


@pytest.mark.parametrize('profile,extension', [('default','.ts'), ('xbox','.m4s')])
def test_hevc_remux_real_output_and_fragment_access(tv_client, profile, extension):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg and ffprobe are required for real HEVC remux verification.')
    client, credentials, mid = tv_client
    row, _ = main.movie(mid)
    source = Path(row['path'])
    subprocess.run(['ffmpeg','-v','error','-nostdin','-f','lavfi','-i','color=c=blue:s=320x180:r=24',
        '-f','lavfi','-i','anullsrc=r=48000:cl=5.1','-t','2','-c:v','libx265',
        '-x265-params','pools=1:frame-threads=1:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        '-pix_fmt','yuv420p10le','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc',
        '-tag:v','hvc1','-c:a','ac3','-y',str(source)],check=True,capture_output=True,timeout=30)
    meta = hevc_meta(width=320,height=180,duration=2,format='mp4',bitrate=1000000,
                     tracks={'audio':[{'index':1,'codec':'ac3','default':True,'channels':6}]})
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(meta),mid))
    (main.DATA/'streams').mkdir(exist_ok=True)
    _, headers = login(client,credentials)
    response = client.post(f'/tv-api/movies/{mid}/play',headers=headers,
        json={'client_profile':profile,'quality':'original','video_copy':True,'audio_copy':True})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['mode'] == 'Direct Stream'
    job = main.JOBS[result['session']]
    try:
        job['process'].wait(timeout=10)
        command = job['process'].args
        assert command[command.index('-c:v')+1] == 'copy'
        playlist = client.get(result['url']).text
        segment_name = next(line for line in playlist.splitlines() if line.endswith(extension))
        base = result['url'].rsplit('/',1)[0]
        media_type = 'video/mp4' if profile == 'xbox' else 'video/mp2t'
        fragment = client.get(base+'/'+segment_name,headers={'Range':'bytes=0-15'})
        assert fragment.status_code == 206 and len(fragment.content) == 16
        assert fragment.headers['content-type'] == media_type
        assert client.head(base+'/'+segment_name).status_code == 200
        assert client.get(base+'/'+segment_name.replace('segment','other')).status_code == 404
        assert client.get(base+'/ffmpeg.log').status_code == 404
        assert client.get(base.replace(result['session'],'0'*32)+'/'+segment_name).status_code == 403
        assert client.get(f'/api/streams/{result["session"]}/{segment_name}').status_code == 401
        with pytest.raises(main.HTTPException) as foreign_user:
            main.stream_file(result['session'],segment_name,{'id':'someone-else'})
        assert foreign_user.value.status_code == 404
        if profile == 'xbox':
            assert '#EXT-X-MAP:URI="init.mp4"' in playlist
            assert not re.search(r'^segment\d+\.ts$',playlist,re.M)
            init = client.get(base+'/init.mp4',headers={'Range':'bytes=0-15'})
            assert init.status_code == 206 and init.headers['content-type'] == 'video/mp4'
            assert client.get(base+'/other.mp4').status_code == 404
        else:
            assert '#EXT-X-MAP' not in playlist
        inspected = subprocess.run(['ffprobe','-v','error','-show_streams','-of','json',
                                    str(job['folder']/'index.m3u8')],check=True,capture_output=True,timeout=20)
        streams = json.loads(inspected.stdout)['streams']
        video = next(s for s in streams if s['codec_type']=='video')
        audio = next(s for s in streams if s['codec_type']=='audio')
        assert video['codec_name'] == 'hevc' and video['pix_fmt'] == 'yuv420p10le'
        assert video['color_transfer'] == 'smpte2084'
        assert (video['width'],video['height']) == (320,180)
        if profile == 'xbox':
            assert video['codec_tag_string'] == 'hvc1'
        assert audio['codec_name'] == 'ac3' and audio['channels'] == 6
        subprocess.run(['ffmpeg','-v','error','-i',str(job['folder']/'index.m3u8'),
                        '-f','null','-'],check=True,capture_output=True,timeout=20)
    finally:
        main.stop_job(result['session'])
