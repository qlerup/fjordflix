"""Real encoded output and cookie-free receiver requests, without Apple hardware."""
import json
import time
from array import array
from urllib.parse import urlsplit
import subprocess

import pytest
from fastapi.testclient import TestClient
from app import main, media
from test_series import client
from test_tracks import mkv


@pytest.fixture
def receiver_setup(client, monkeypatch):
    monkeypatch.setattr(media, '_db', main.db)
    media.init(main.db)
    login = 'airplay-test-login'
    with main.db() as conn:
        conn.executescript('CREATE TABLE sessions(token TEXT,user_id TEXT,expires REAL); CREATE TABLE users(id TEXT,name TEXT,admin INTEGER,hub_id INTEGER,hub_username TEXT);')
        conn.execute('INSERT INTO users VALUES (?,?,?,?,?)', ('owner', 'Owner', 1, None, None))
        conn.execute('INSERT INTO sessions VALUES (?,?,?)', (main.digest(login), 'owner', time.time()+86400))
    client.cookies.set('fjordflix_session', login)
    monkeypatch.setattr(main, 'GPU', False)
    yield TestClient(main.app)


def frame(path, at):
    return subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ss', str(at),
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], check=True, capture_output=True).stdout


@pytest.mark.parametrize('start', [0, 3])
def test_selected_audio_and_burned_text_after_seek(client, mkv, receiver_setup, start):
    mid, _, _ = mkv
    outputs = []
    for subtitle in [None, 4, 3]:
        data = {'airplay':True, 'burn_subtitles':True, 'quality':'480', 'h264':True, 'direct':True,
                'audio_track':2, 'subtitle_track':subtitle, 'start':start}
        response = client.post(f'/api/movies/{mid}/play', json=data)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['airplay'] and result['media_ticket'] and result['session']
        assert result['subtitle_delivery'] == ('burn' if subtitle else None)
        assert result['offset'] == start
        job = main.JOBS[result['session']]
        assert job['idle_timeout'] == media.AIRPLAY_TTL
        job['process'].wait(timeout=15)
        assert job['process'].returncode == 0, (job['folder']/'ffmpeg.log').read_text()
        playlist = job['folder']/'index.m3u8'
        outputs.append(frame(playlist, 2 if start == 0 else .5))
        if subtitle == 4:
            # Selected Danish audio is the 880 Hz track, not English's 440 Hz.
            pcm = subprocess.run(['ffmpeg','-v','error','-ss','0.5','-i',str(playlist),'-map','0:a:0','-t','1',
                '-ac','1','-ar','8000','-f','f32le','-'],check=True,capture_output=True)
            samples = array('f', pcm.stdout)
            hz = sum(a <= 0 < b for a,b in zip(samples,samples[1:]))*8000/len(samples)
            assert abs(hz-880) < 10
    assert len(outputs[0]) == len(outputs[1]) == len(outputs[2]) > 0
    assert sum(abs(a-b)>40 for a,b in zip(outputs[0],outputs[1])) > 100
    assert sum(abs(a-b)>40 for a,b in zip(outputs[1],outputs[2])) > 50, 'The selected subtitle language must change the video.'


@pytest.mark.parametrize('direct', [False, True])
def test_receiver_access_renewal_scope_expiry_and_logout(client, mkv, receiver_setup, monkeypatch, direct):
    if direct:
        monkeypatch.setattr(media, 'config', lambda: ('http://video.test', 'http://testserver'))
    mid, _, _ = mkv
    response = client.post(f'/api/movies/{mid}/play', json={'airplay':True,'quality':'original','h264':True,'audio_track':1})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['mode'] == 'Direct Stream'
    assert result['delivery'] == ('direct' if direct else 'same-origin')
    receiver = TestClient(main.app, base_url='http://video.test' if direct else 'http://testserver')
    path = urlsplit(result['url']).path
    assert not receiver.cookies
    response = receiver.get(path)
    assert response.status_code == 200 and '#EXTM3U' in response.text
    segment = next(line for line in response.text.splitlines() if line and not line.startswith('#'))
    segment_path = path.rsplit('/',1)[0]+'/'+segment
    assert receiver.head(path).status_code == 200
    # Simulate no phone heartbeats. Receiver traffic renews a nearly expired ticket.
    with main.db() as conn:
        conn.execute('UPDATE media_grants SET expires=?', (time.time()+1,))
    assert receiver.get(segment_path).status_code == 200
    with main.db() as conn:
        grant = conn.execute('SELECT * FROM media_grants').fetchone()
        assert grant['expires'] > time.time()+500
        assert grant['expires'] <= grant['airplay_until']
    assert receiver.get(path.replace(result['session'],'b'*32)).status_code == 403
    assert receiver.get(path.rsplit('/',1)[0]+'/subtitles.vtt').status_code == 404
    assert receiver.get(path,headers={'Origin':'https://evil.test'}).status_code == 403
    assert receiver.get(path,headers={'CF-Ray':'proxy'}).status_code == (403 if direct else 200)
    assert client.post('/api/media/heartbeat',json={'ticket':result['media_ticket']}).status_code == 200
    with main.db() as conn:
        conn.execute('UPDATE media_grants SET airplay_until=?', (time.time()-1,))
    assert receiver.get(path).status_code == 401
    assert client.post('/api/media/heartbeat',json={'ticket':result['media_ticket']}).status_code == 410
    with main.db() as conn:
        conn.execute('UPDATE media_grants SET airplay_until=?,expires=?', (time.time()+1000,time.time()+500))
        conn.execute('DELETE FROM sessions')
    assert receiver.get(path).status_code == 401
    assert client.post('/api/media/revoke',json={'ticket':result['media_ticket']}).status_code == 200
    with main.db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_grants').fetchone()[0] == 0
    receiver.close()


def test_airplay_never_sends_browser_only_original():
    meta = {'height':1080,'video':'hevc','pix_fmt':'yuv420p','hdr':False,'bitrate':1000000,'tracks':{}}
    assert main.decide(meta,main.Playback(airplay=True,direct=True,h264=True,quality='original'))['mode']=='Transcoding'


@pytest.mark.parametrize('quality,start', [('original',0), ('original',3.5), ('480',3.5)])
@pytest.mark.parametrize('direct', [False, True])
def test_soft_subtitles_follow_video_clock_and_keep_video_when_supported(client, mkv, receiver_setup, quality, start, direct, monkeypatch):
    import re
    from app import hls_subtitles
    if direct:
        monkeypatch.setattr(media, 'config', lambda: ('http://video.test', 'http://testserver'))
    mid, source, _ = mkv
    response = client.post(f'/api/movies/{mid}/play', json={
        'airplay':True,'quality':quality,'h264':True,'audio_track':2,'subtitle_track':4,'start':start})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['subtitle_delivery'] == 'hls'
    assert abs(result['offset'] + result['initial_time'] - start) < .05
    assert result['mode'] == ('Direct Stream' if quality=='original' else 'Transcoding')
    path = urlsplit(result['url']).path
    assert path.endswith('/master.m3u8')
    receiver = TestClient(main.app, base_url='http://video.test') if direct else receiver_setup
    master = receiver.get(path)
    assert master.status_code == 200
    assert 'LANGUAGE="da",DEFAULT=YES' in master.text and 'SUBTITLES="text"' in master.text
    base = path.rsplit('/',1)[0]+'/'
    job = main.JOBS[result['session']]
    job['process'].wait(timeout=15)
    video = receiver.get(base+'index.m3u8')
    subtitle = receiver.get(base+'subtitles.m3u8')
    assert subtitle.status_code == 200 and subtitle.headers['content-type'].startswith('application/vnd.apple.mpegurl')
    assert re.findall(r'#EXTINF:([^\n]+)', video.text) == re.findall(r'#EXTINF:([^\n]+)', subtitle.text)
    urls = [l for l in subtitle.text.splitlines() if l and not l.startswith('#')]
    all_text = []
    for url in urls:
        text = receiver.get(base+url)
        assert text.status_code==200 and text.headers['content-type'].startswith('text/vtt')
        assert text.text.startswith('WEBVTT\nX-TIMESTAMP-MAP=')
        all_text.append(text.text)
    assert 'Anden undertekst.' in ''.join(all_text)
    assert 'Hello there!' not in ''.join(all_text)
    if start == 0:
        # A cue crossing the video segment boundary must exist in both segments.
        assert 'Hej med dig!' in all_text[0] and 'Hej med dig!' in all_text[1]
    assert receiver.get(base+'subtitle99999.vtt').status_code==404
    assert receiver.get(base+'subtitles.vtt').status_code==404  # private extraction, not a public segment
    assert receiver.get(base.replace(result['session'],'b'*32)+'subtitles.m3u8').status_code==403
    # Compare text clock against actual packets rather than assuming a 1.4 s mux delay.
    first_pts = float(hls_subtitles.probe(['-select_streams','v:0','-show_entries','stream=start_time'],job['folder']/'segment00000.ts')['streams'][0]['start_time'])
    origin = hls_subtitles.source_origin(source,start) if quality=='original' else start
    mapped = int(re.search(r'MPEGTS:(\d+)',all_text[0])[1]) / 90000
    if mapped > (1<<32)/90000: mapped -= (1<<33)/90000
    assert abs(mapped+origin-first_pts) < .001
    if quality=='original':
        # Container framing changes (AVCC -> Annex B), but the encoded picture
        # NAL units must be preserved, proving no video re-encoding happened.
        def pictures(path, seek):
            raw = subprocess.check_output(['ffmpeg','-v','error','-ss',str(seek),'-i',str(path),
                '-map','0:v:0','-t','1','-c:v','copy','-bsf:v','h264_mp4toannexb','-f','h264','-'])
            return {nal.rstrip(b'\x00') for nal in re.split(b'\x00\x00\x00?\x01',raw) if nal and (nal[0]&31) in (1,5)}
        assert pictures(job['folder']/'segment00000.ts',0) & pictures(source,start)
    with main.db() as conn:
        conn.execute('UPDATE media_grants SET expires=0')
    assert receiver.get(base+'subtitles.m3u8').status_code==401
    assert receiver.get(base+urls[0]).status_code==401


def test_subtitle_boundary_cues_empty_segments_and_hostile_labels():
    from app import hls_subtitles as h
    state={'origin':10,'mpegts':126000,'cues':[(9,13,'00:09.000 --> 00:13.000\nÆ ø å'),(14,15,'00:14.000 --> 00:15.000\nNext')]}
    playlist='#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nsegment00000.ts\n#EXTINF:2,\nsegment00001.ts\n#EXTINF:2,\nsegment00002.ts\n#EXTINF:2,\nsegment00003.ts\n#EXT-X-ENDLIST\n'
    assert 'Æ ø å' in h.segment_text(state,playlist,0)
    assert 'Æ ø å' in h.segment_text(state,playlist,1)
    assert 'Next' in h.segment_text(state,playlist,2)
    assert '-->' not in h.segment_text(state,playlist,3)
    master=h.master({'mbps':4},{'language':'da"\nURI="https://evil.test'})
    assert 'evil.test' not in master and 'LANGUAGE="und"' in master
