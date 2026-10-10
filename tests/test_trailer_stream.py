import json
import shutil
import subprocess
import threading
import time

import pytest
from fastapi import HTTPException
from app import main, trailers
from test_tv import tv_client, login


def test_trailer_ticket_range_scoping_and_progress(tv_client, monkeypatch):
    client, credentials, mid = tv_client
    monkeypatch.setattr(main.catalog, 'trailer', lambda info: {'trailer': {'url': 'https://www.youtube.com/watch?v=abcdefghijk'}})
    folder = main.DATA / 'trailers'
    folder.mkdir(exist_ok=True)
    (folder / 'abcdefghijk.mp4').write_bytes(b'0123456789' * 100)
    assert client.post(f'/tv-api/movies/{mid}/trailer/prepare').status_code == 401
    token, headers = login(client, credentials)
    assert client.post(f'/tv-api/movies/{mid}/trailer/prepare', headers=headers).json() == {'status': 'ready'}
    result = client.post(f'/tv-api/movies/{mid}/trailer/play', headers=headers).json()
    assert result['trailer'] and result['session'] is None
    response = client.get(result['url'], headers={'Range': 'bytes=10-19'})
    assert response.status_code == 206 and response.content == b'0123456789'
    assert response.headers['content-type'] == 'video/mp4'
    assert client.head(result['url']).status_code == 200
    assert client.get(result['url'].replace('abcdefghijk', 'otherkey123')).status_code == 403
    assert client.get(result['url'].replace('trailers/abcdefghijk', f'movies/{mid}')).status_code == 403
    assert client.post('/tv-api/media/heartbeat', json={'ticket':result['media_ticket']}, headers=headers).status_code == 200
    with main.db() as conn:
        assert conn.execute('SELECT position FROM progress WHERE movie_id=?', (mid,)).fetchone() is None
    assert client.post('/tv-api/media/revoke', json={'ticket':result['media_ticket']}, headers=headers).status_code == 200
    assert client.get(result['url']).status_code == 401
    # The cookie-authenticated browser/Windows route issues the same scoped media.
    client.cookies.set('fjordflix_session', token)
    result = client.post(f'/api/movies/{mid}/trailer/play').json()
    assert client.get(result['url'], headers={'Range':'bytes=0-9'}).status_code == 206
    assert client.post(f'/api/movies/{mid}/trailer/prepare', headers={'Origin':'https://evil.test'}).status_code == 403
    assert client.post('/tv-api/movies/missing/trailer/prepare', headers=headers).status_code == 404


def test_prepare_deduplicates_bounds_work_and_publishes_atomically(tmp_path, monkeypatch):
    entered, proceed = threading.Event(), threading.Event()
    def download(key, folder):
        entered.set()
        assert proceed.wait(5)
        path = folder / 'source.webm'
        path.write_bytes(b'source')
        return path
    monkeypatch.setattr(trailers, 'download', download)
    monkeypatch.setattr(trailers, 'convert', lambda source, target: target.write_bytes(b'converted'))
    keys = ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm']
    try:
        assert trailers.prepare(tmp_path, keys[0])['status'] == 'preparing'
        assert entered.wait(2)
        assert trailers.prepare(tmp_path, keys[0])['status'] == 'preparing'
        assert trailers.prepare(tmp_path, keys[1])['status'] == 'preparing'
        with pytest.raises(HTTPException) as error:
            trailers.prepare(tmp_path, keys[2])
        assert error.value.status_code == 429
        with pytest.raises(HTTPException):
            trailers.file(tmp_path, keys[0])
    finally:
        proceed.set()
    deadline = time.time() + 5
    while time.time() < deadline and any((str((tmp_path/'trailers').resolve()), key) in trailers._jobs for key in keys[:2]):
        time.sleep(.01)
    for key in keys[:2]:
        assert trailers.prepare(tmp_path, key) == {'status':'ready'}
        assert trailers.file(tmp_path, key).read_bytes() == b'converted'
    assert not list((tmp_path / 'trailers').glob('prepare-*'))


def test_failure_backoff_and_invalid_ids(tmp_path, monkeypatch):
    calls = []
    def fail(key, folder):
        calls.append(key)
        raise RuntimeError('offline')
    monkeypatch.setattr(trailers, 'download', fail)
    key = 'abcdefghijk'
    trailers.prepare(tmp_path, key)
    deadline = time.time() + 3
    while time.time() < deadline and trailers.prepare(tmp_path, key)['status'] == 'preparing':
        time.sleep(.01)
    assert trailers.prepare(tmp_path, key) == {'status':'error'}
    assert calls == [key]
    assert not list((tmp_path / 'trailers').glob('prepare-*'))
    for invalid in ('../anything', 'https://example.com', 'short'):
        with pytest.raises(HTTPException):
            trailers.prepare(tmp_path, invalid)


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='FFmpeg tools required')
def test_convert_produces_compatible_seekable_mp4(tmp_path):
    source, target = tmp_path / 'source.webm', tmp_path / 'trailer.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=24',
                    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1',
                    '-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-c:a','libopus',str(source)], check=True, timeout=60)
    trailers.convert(source, target)
    info = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(target)]))
    video, audio = info['streams']
    assert (video['codec_name'], video['pix_fmt'], video['width'], video['height']) == ('h264', 'yuv420p',1280,720)
    assert audio['codec_name'] == 'aac' and audio['channels'] == 2
    content = target.read_bytes()
    assert content.index(b'moov') < content.index(b'mdat'), 'MP4 metadata precedes video for streaming and seeking'
