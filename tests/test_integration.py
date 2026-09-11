"""Real FFmpeg integration checks; always use an isolated temporary database."""
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

test_dir = tempfile.TemporaryDirectory(prefix='fjordflix-test-')
os.environ['DATA_DIR'] = test_dir.name

from fastapi.testclient import TestClient
from app import main


def test_complete_streaming_flow():
    with TestClient(main.app) as owner:
        anonymous = TestClient(main.app)
        assert owner.get('/api/state').json()['setup'] is True
        assert anonymous.get('/api/movies').status_code == 401
        credentials = {'name': 'Test Admin', 'password': 'Temporary-test-password-73!'}
        assert owner.post('/api/setup', json=credentials, headers={'Origin': 'https://other.example'}).status_code == 403
        assert owner.post('/api/setup', json=credentials).status_code == 200
        assert owner.post('/api/setup', json=credentials).status_code == 409
        cookie = owner.cookies.get('session')
        with main.db() as conn:
            assert conn.execute('SELECT token FROM sessions').fetchone()[0] != cookie
            assert conn.execute('SELECT password FROM users').fetchone()[0].startswith('$argon2')
        assert anonymous.post('/api/register', json={**credentials, 'invite': 'bad'}).status_code == 400
        token = owner.post('/api/invites').json()['token']
        viewer = TestClient(main.app)
        viewer_credentials = {'name': 'Viewer', 'password': 'Temporary-viewer-password!', 'invite': token}
        assert viewer.post('/api/register', json=viewer_credentials).status_code == 200
        assert anonymous.post('/api/register', json={**viewer_credentials, 'name': 'Another'}).status_code == 400
        assert viewer.post('/api/invites').status_code == 403
        assert viewer.put('/api/upload?filename=test.mp4', content=b'bad').status_code == 403
        assert owner.put('/api/upload?filename=test.mp4', content=b'not a video').status_code == 400
        assert not list((main.DATA / 'media').iterdir())

        began = time.monotonic()
        generated = owner.post('/api/demo')
        assert generated.status_code == 200, generated.text
        mid = generated.json()['id']
        movie = owner.get('/api/movies').json()[0]
        assert movie['width'] == 3840 and movie['height'] == 2160
        assert owner.get(f'/api/movies/{mid}/poster').status_code == 200
        assert anonymous.get(f'/api/movies/{mid}/file').status_code == 401
        ranged = viewer.get(f'/api/movies/{mid}/file', headers={'Range': 'bytes=0-1023'})
        assert ranged.status_code == 206 and len(ranged.content) == 1024

        direct = viewer.post(f'/api/movies/{mid}/play', json={'quality':'original', 'direct':True}).json()
        assert direct['mode'] == 'Direct Play' and direct['session'] is None
        auto = viewer.post(f'/api/movies/{mid}/plan', json={'quality':'auto', 'direct':True, 'bandwidth':5}).json()
        assert auto['mode'] == 'Transcoding' and auto['height'] == 480
        remux = viewer.post(f'/api/movies/{mid}/play', json={'quality':'original', 'h264':True}).json()
        assert remux['mode'] == 'Direct Stream', remux
        assert viewer.get(remux['url']).status_code == 200
        assert viewer.delete(f"/api/streams/{remux['session']}").status_code == 200

        start = time.monotonic()
        response = viewer.post(f'/api/movies/{mid}/play', json={'quality':'1080'})
        assert response.status_code == 200, response.text
        stream = response.json()
        assert stream['mode'] == 'Transcoding' and stream['height'] == 1080
        sid = stream['session']
        playlist = viewer.get(stream['url'])
        assert playlist.status_code == 200 and '#EXTM3U' in playlist.text
        assert anonymous.get(stream['url']).status_code == 401
        assert owner.get(stream['url']).status_code == 404
        assert owner.delete(f'/api/streams/{sid}').status_code == 403
        first_segment = next(line for line in playlist.text.splitlines() if line.endswith('.ts'))
        assert viewer.get(f'/api/streams/{sid}/{first_segment}').status_code == 200
        info = subprocess.run(['ffprobe','-v','error','-show_streams','-of','json',str(main.DATA / 'streams' / sid / first_segment)], capture_output=True, check=True)
        decoded = json.loads(info.stdout)['streams'][0]
        assert decoded['width'] == 1920 and decoded['height'] == 1080
        subprocess.run(['ffmpeg','-v','error','-i',str(main.DATA / 'streams' / sid / first_segment),'-f','null','-'],capture_output=True,check=True)
        print(f"\n4K -> 1080p first segment: {time.monotonic()-start:.2f}s; encoder: {stream['encoder']}")
        assert viewer.post(f'/api/streams/{sid}/heartbeat').status_code == 200
        assert viewer.delete(f'/api/streams/{sid}').status_code == 200
        assert not (main.DATA / 'streams' / sid).exists()

        seek = viewer.post(f'/api/movies/{mid}/play', json={'quality':'720', 'start':6}).json()
        assert seek['offset'] == 6 and seek['height'] == 720
        viewer.delete(f"/api/streams/{seek['session']}")
        viewer.post(f'/api/movies/{mid}/progress', json={'position':5})
        viewer.post(f'/api/movies/{mid}/favorite')
        assert viewer.get('/api/movies').json()[0]['position'] == 5
        assert viewer.get('/api/movies').json()[0]['favorite'] is True
        assert owner.get('/api/movies').json()[0]['position'] == 0
        assert owner.get('/api/movies').json()[0]['favorite'] is False

        source = Path(main.movie(mid)[0]['path'])
        uploaded = owner.put('/api/upload?filename=Uploaded%20test.mp4', content=source.read_bytes())
        assert uploaded.status_code == 200, uploaded.text
        assert len(viewer.get('/api/movies').json()) == 2
        assert viewer.post('/api/logout').status_code == 200
        assert viewer.get('/api/movies').status_code == 401
        assert viewer.post('/api/login', json={**viewer_credentials, 'password':'wrong-password'}).status_code == 401
        assert viewer.post('/api/login', json=viewer_credentials).status_code == 200
        print(f"Full integration flow completed in {time.monotonic()-began:.2f}s")
