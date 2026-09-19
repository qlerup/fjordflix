"""TV token API integration; only the disposable test database is used."""
import json
import secrets
import time
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient
from test_integration import main


@pytest.fixture
def tv_client(tmp_path, monkeypatch):
    monkeypatch.setattr(main.hub, 'managed', lambda: False)
    monkeypatch.setattr(main, 'ATTEMPTS', {})
    previous = main.media.config()
    main.media.save_config('', '', main.db)
    uid, mid = secrets.token_hex(16), secrets.token_hex(16)
    credentials = {'name': uid, 'password': 'TV-test-password-73!'}
    source = tmp_path / 'sample.mp4'
    source.write_bytes(b'0123456789' * 100)
    meta = {'format':'mp4', 'video':'h264', 'audio':None, 'width':1280, 'height':720,
            'duration':60, 'bitrate':1000000, 'size':1000, 'hdr':False, 'pix_fmt':'yuv420p'}
    with main.db() as conn:
        conn.execute('INSERT INTO users(id,name,password,admin) VALUES (?,?,?,0)',
                     (uid, uid, main.PASSWORDS.hash(credentials['password'])))
        conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)',
                     (mid, 'TV sample', str(source), json.dumps(meta), time.time()))
    client = TestClient(main.app, base_url='https://web.test')
    try:
        yield client, credentials, mid
    finally:
        client.close()
        main.media.save_config(*previous, main.db)
        with main.db() as conn:
            conn.execute('DELETE FROM progress WHERE user_id=?', (uid,))
            conn.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
            conn.execute('DELETE FROM movies WHERE id=?', (mid,))
            conn.execute('DELETE FROM users WHERE id=?', (uid,))


def login(client, credentials):
    response = client.post('/tv-api/login', json=credentials, headers={'Origin':'null'})
    assert response.status_code == 200, response.text
    assert 'set-cookie' not in response.headers
    assert response.headers['cache-control'] == 'no-store'
    token = response.json()['token']
    return token, {'Authorization':'Bearer ' + token, 'Origin':'null'}


def test_login_cookie_isolation_cors_and_logout(tv_client):
    client, credentials, _ = tv_client
    assert client.get('/tv-api/info').json() == {'app':'fjordflix-tv', 'version':1}
    preflight = client.options('/tv-api/login', headers={'Origin':'null',
        'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'authorization,content-type'})
    assert preflight.status_code == 200
    assert preflight.headers['access-control-allow-origin'] == '*'
    assert 'access-control-allow-credentials' not in preflight.headers
    assert client.post('/api/login', json=credentials).status_code == 200
    assert client.get('/api/movies').status_code == 200

    # Valid browser cookies alone do not authorize a cross-origin TV request.
    assert client.get('/tv-api/movies').status_code == 401
    assert client.post('/api/login', json=credentials, headers={'Origin':'https://evil.test'}).status_code == 403
    assert client.post('/tv-api/login', json={**credentials, 'password':'wrong'}).status_code == 401
    token, headers = login(client, credentials)
    with main.db() as conn:
        assert conn.execute('SELECT token FROM sessions WHERE token=?', (main.digest(token),)).fetchone()
        assert not conn.execute('SELECT token FROM sessions WHERE token=?', (token,)).fetchone()
    assert client.get('/tv-api/state', headers=headers).json()['user']['name'] == credentials['name']
    assert client.get('/tv-api/admin', headers=headers).status_code == 404
    assert client.post('/tv-api/logout', headers=headers).status_code == 200
    assert client.get('/tv-api/movies', headers=headers).status_code == 401
    # Logging out of the TV does not end the separate browser login.
    assert client.get('/api/movies').status_code == 200


def test_tv_subtitles_require_bearer_and_validate_track(tv_client, tmp_path, monkeypatch):
    client, credentials, mid = tv_client
    with main.db() as conn:
        meta = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?', (mid,)).fetchone()[0])
        meta['tracks'] = {'version':1, 'audio':[], 'subtitles':[
            {'index':2, 'delivery':'text'}, {'index':3, 'delivery':'burn'}]}
        meta['external_subtitles'] = [{'index':1000000002,'external':True,'codec':'subrip','delivery':'text'}]
        conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), mid))
    output = tmp_path / 'subtitle.vtt'
    output.write_text('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHej\n')
    monkeypatch.setattr(main.tracks, 'webvtt', lambda *args: output)
    path = f'/tv-api/movies/{mid}/subtitles/2.vtt'
    assert client.get(path).status_code == 401
    assert client.post('/api/login', json=credentials).status_code == 200
    assert client.get(path).status_code == 401
    _, headers = login(client, credentials)
    response = client.get(path, headers=headers)
    assert response.status_code == 200 and response.text.startswith('WEBVTT')
    assert response.headers['access-control-allow-origin'] == '*'
    assert client.get(path.replace('/2.vtt', '/9.vtt'), headers=headers).status_code == 400
    assert client.get(path.replace('/2.vtt', '/3.vtt'), headers=headers).status_code == 400
    assert client.get(f'/tv-api/movies/{mid}/tracks').status_code == 401
    available = client.get(f'/tv-api/movies/{mid}/tracks',headers=headers).json()
    assert available['subtitles'][-1]['index'] == 1000000002
    assert client.get(path.replace('/2.vtt','/1000000002.vtt'),headers=headers).status_code == 200


def test_progress_favorites_scoped_video_renewal_and_expiry(tv_client):
    client, credentials, mid = tv_client
    token, headers = login(client, credentials)
    assert client.post(f'/tv-api/movies/{mid}/favorite', headers=headers).status_code == 200
    assert client.post(f'/tv-api/movies/{mid}/progress', headers=headers, json={'position':12}).status_code == 200
    movie = next(m for m in client.get('/tv-api/movies', headers=headers).json() if m['id'] == mid)
    assert movie['favorite'] and movie['position'] == 12
    play = client.post(f'/tv-api/movies/{mid}/play', headers=headers, json={'direct':True}).json()
    assert play['mode'] == 'Direct Play' and token not in play['url']
    assert play['url'].startswith('https://web.test/tv-media/')
    response = client.get(play['url'], headers={'Range':'bytes=10-19', 'Origin':'null'})
    assert response.status_code == 206 and response.content == b'0123456789'
    assert response.headers['access-control-allow-origin'] == '*'
    assert client.get(play['url'].replace(mid, 'other')).status_code == 403
    assert client.post('/tv-api/media/heartbeat', headers=headers, json={'ticket':play['media_ticket']}).status_code == 200
    _, other_session = login(client, credentials)
    assert client.post('/tv-api/media/heartbeat', headers=other_session, json={'ticket':play['media_ticket']}).status_code == 410
    with main.db() as conn:
        conn.execute('UPDATE media_grants SET expires=0 WHERE token=?', (main.media.key(play['media_ticket']),))
    assert client.get(play['url']).status_code == 401
    play = client.post(f'/tv-api/movies/{mid}/play', headers=headers, json={'direct':True}).json()
    assert client.post('/tv-api/logout', headers=headers).status_code == 200
    assert client.get(play['url']).status_code == 401


def test_direct_media_host_proxy_and_ticket_revocation(tv_client):
    client, credentials, mid = tv_client
    main.media.save_config('https://video.test', 'https://web.test', main.db)
    _, headers = login(client, credentials)
    play = client.post(f'/tv-api/movies/{mid}/play', headers=headers, json={'direct':True}).json()
    path = urlparse(play['url']).path
    assert play['url'].startswith('https://video.test/tv-media/')
    assert client.get(path).status_code == 403
    assert client.get(play['url'], headers={'CF-Ray':'proxy'}).status_code == 403
    assert client.get(play['url']).status_code == 200
    assert client.post('/tv-api/media/revoke', headers=headers, json={'ticket':play['media_ticket']}).status_code == 200
    assert client.get(play['url']).status_code == 401


def test_quality_plan_preserves_4k_or_reports_transcoding_without_starting_jobs(tv_client):
    client, credentials, mid = tv_client
    assert client.post(f'/tv-api/movies/{mid}/plan', json={}).status_code == 401
    _, headers = login(client, credentials)
    with main.db() as conn:
        meta = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?', (mid,)).fetchone()[0])
        meta.update(width=3840, height=2160)
        conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), mid))
    jobs_before = set(main.JOBS)
    for request, mode, height in [
        ({'quality':'auto','direct':True,'h264':True}, 'Direct Play', 2160),
        ({'quality':'original','direct':False,'h264':True}, 'Direct Stream', 2160),
        ({'quality':'2160','direct':True,'h264':True}, 'Direct Play', 2160),
        ({'quality':'2160','direct':False,'h264':True}, 'Direct Stream', 2160),
        ({'quality':'2160','direct':False,'h264':False}, 'Transcoding', 2160),
        ({'quality':'original','direct':False,'h264':False}, 'Transcoding', 2160),
        ({'quality':'1080','direct':True,'h264':True}, 'Transcoding', 1080),
        ({'quality':'720','direct':True,'h264':True}, 'Transcoding', 720),
    ]:
        result = client.post(f'/tv-api/movies/{mid}/plan', headers=headers, json=request)
        assert result.status_code == 200
        assert result.json()['mode'] == mode and result.json()['height'] == height
        assert result.json()['reason']
    assert set(main.JOBS) == jobs_before


def test_expired_session_and_hub_revocation(tv_client, monkeypatch):
    client, credentials, _ = tv_client
    token, headers = login(client, credentials)
    with main.db() as conn:
        conn.execute('UPDATE sessions SET expires=0 WHERE token=?', (main.digest(token),))
    assert client.get('/tv-api/state', headers=headers).status_code == 401
    monkeypatch.setattr(main.hub, 'managed', lambda: True)
    person = {'id':73531, 'username':'TV Hub User', 'role':'user', 'must_change_password':False}
    monkeypatch.setattr(main.hub, 'call', lambda *a, **kw: {'user':person})
    monkeypatch.setattr(main.hub, 'current', lambda *a, **kw: person)
    _, headers = login(client, {'name':person['username'], 'password':'hub-password'})
    assert client.get('/tv-api/state', headers=headers).json()['user']['name'] == person['username']
    def removed(*a, **kw):
        raise main.HTTPException(403, 'Adgang fjernet')
    monkeypatch.setattr(main.hub, 'current', removed)
    assert client.get('/tv-api/movies', headers=headers).status_code == 403
    # Hub revocation invalidates the session, including subsequent media checks.
    assert client.get('/tv-api/state', headers=headers).status_code == 401


@pytest.mark.parametrize('height', [720, 1080, 1600, 2160])
@pytest.mark.parametrize('quality', ['2160', 'original'])
def test_hdr_transcoding_preserves_resolution_without_upscaling(height, quality):
    meta = {'format': 'mkv', 'video': 'hevc', 'audio': 'truehd',
            'width': 3840, 'height': height, 'bitrate': 40000000,
            'hdr': True, 'pix_fmt': 'yuv420p10le'}
    plan = main.decide(meta, main.Playback(quality=quality, h264=True))
    assert plan['mode'] == 'Transcoding'
    assert plan['height'] == height
    if height > 1080:
        assert plan['mbps'] == 25

def test_hdr_hevc_remux_preserves_video_and_surround_audio(tv_client):
    import subprocess
    from pathlib import Path
    client, credentials, mid = tv_client
    _, headers = login(client, credentials)
    row, _ = main.movie(mid)
    path = Path(row['path'])
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=24',
                    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-t', '2', '-c:v', 'libx265',
                    '-x265-params', 'pools=1:frame-threads=1:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-pix_fmt', 'yuv420p10le',
                    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
                    '-tag:v', 'hvc1', '-c:a', 'ac3', '-y', str(path)], check=True, capture_output=True)
    meta = {'width':1280,'height':720,'video':'hevc','audio':'ac3','format':'mp4',
            'hdr':True,'pix_fmt':'yuv420p10le','duration':2,'bitrate':1000000,
            'tracks':{'audio':[{'index':1,'codec':'ac3','default':True,'channels':6}]}}
    (main.DATA / 'streams').mkdir(exist_ok=True)
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), mid))
    response = client.post(f'/tv-api/movies/{mid}/play', headers=headers,
                           json={'quality':'original', 'video_copy':True, 'audio_copy':True})
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan['mode'] == 'Direct Stream'
    try:
        playlist = client.get(plan['url']).text
        name = next(line for line in playlist.splitlines() if line.endswith('.ts'))
        segment = main.DATA / 'streams' / plan['session'] / name
        # Decode the actual HLS segment and inspect the input stream description.
        result = subprocess.run(['ffmpeg','-hide_banner','-i',str(segment),'-f','null','-'], capture_output=True, check=True)
        description = result.stderr.decode('utf-8', errors='replace')
        assert 'Video: hevc' in description and 'yuv420p10le' in description
        assert 'smpte2084' in description, description
        assert 'Audio: ac3' in description and '5.1' in description
    finally:
        main.stop_job(plan['session'])

@pytest.mark.parametrize('options,expected', [
    ({'direct':True,'video_copy':True}, 'Direct Play'),
    ({'direct':False,'video_copy':True}, 'Direct Stream'),
    ({'direct':False,'video_copy':False}, 'Transcoding'),
    ({'direct':True,'video_copy':True,'quality':'720'}, 'Transcoding'),
])
def test_hdr_plan_uses_actual_video_capability(options, expected):
    meta = {'height':2160,'width':3840,'video':'hevc','pix_fmt':'yuv420p10le','hdr':True,'bitrate':40000000}
    result = main.decide(meta, main.Playback(**{'quality':'original', **options}))
    assert result['mode'] == expected
    assert result['height'] == (720 if options.get('quality') == '720' else 2160)
