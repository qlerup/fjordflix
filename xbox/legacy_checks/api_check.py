"""Isolated integration against real FjordFlix auth/database; no user data touched."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import gc

temporary = tempfile.TemporaryDirectory(prefix='fjordflix-tv-tests-', ignore_cleanup_errors=True)
os.environ['DATA_DIR'] = temporary.name
os.environ['MEDIA_DIR'] = str(Path(temporary.name) / 'media')
os.environ['TRANSCODE_DEVICE'] = 'cpu'
for name in ('FJORDHUB_URL', 'FJORDHUB_API_KEY', 'MEDIA_PUBLIC_URL', 'WEB_PUBLIC_URL'):
    os.environ.pop(name, None)
server_root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(server_root if (server_root / 'app/main.py').exists() else server_root / 'fjordflix'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from fjordflix_tv import app
from app import main, media


def test_token_client_and_scoped_media():
    with TestClient(app) as client:
        credentials = {'name':'TV Tester', 'password':'Temporary-password-TV-73!'}
        assert client.post('/api/setup', json=credentials).status_code == 200
        # Existing browser cookie is deliberately insufficient for the TV API.
        assert client.get('/tv-api/movies').status_code == 401
        assert client.get('/').status_code == 200
        info = client.get('/tv-api/info').json()
        assert info['version'] == 1
        assert info['playback_profiles'] == ['default', 'xbox']
        assert 'xbox-hevc-fmp4' in info['features']
        assert 'phone-login-v1' in info['features']
        pairing = client.post('/tv-api/pair/start').json()
        approval = client.post('/tv-api/pair/approve', headers={'Origin':'http://testserver'},
                               json={**credentials, 'user_code':pairing['user_code']})
        assert approval.status_code == 200 and 'set-cookie' not in approval.headers
        approved = client.post('/tv-api/pair/poll', json={'device_code':pairing['device_code']}).json()
        assert approved['status'] == 'approved'
        assert client.post('/tv-api/logout', headers={'Authorization':'Bearer '+approved['token']}).status_code == 200
        preflight = client.options('/tv-api/login', headers={'Origin':'null','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,authorization'})
        assert preflight.status_code == 200
        assert preflight.headers['access-control-allow-origin'] == '*'
        assert 'access-control-allow-credentials' not in preflight.headers
        assert client.post('/tv-api/login', json={**credentials,'password':'wrong'}).status_code == 401
        result = client.post('/tv-api/login', json=credentials, headers={'Origin':'null'})
        assert result.status_code == 200 and 'set-cookie' not in result.headers
        token = result.json()['token']
        headers = {'Authorization':'Bearer '+token, 'Origin':'null'}
        with main.db() as conn:
            assert conn.execute('SELECT token FROM sessions WHERE token=?',(main.digest(token),)).fetchone()
            assert not conn.execute('SELECT token FROM sessions WHERE token=?',(token,)).fetchone()
        assert client.get('/tv-api/state',headers=headers).json()['user']['name'] == credentials['name']
        assert client.get('/tv-api/movies',headers=headers).json() == []
        assert client.get('/tv-api/admin',headers=headers).status_code == 404
        assert client.post('/api/login',json=credentials,headers={'Origin':'https://evil.example'}).status_code == 403
        source = Path(temporary.name) / 'media' / 'fixture.mp4'
        source.write_bytes(b'0123456789'*100)
        meta = {'duration':60,'format':'mp4','video':'h264','audio':None,'pix_fmt':'yuv420p','hdr':False,'height':720,'width':1280,'bitrate':1000000}
        with main.db() as conn:
            conn.execute('INSERT INTO movies(id,title,path,metadata,created) VALUES (?,?,?,?,?)',('fixture','TV fixture',str(source),json.dumps(meta),time.time()))
        assert client.post('/tv-api/movies/fixture/favorite',headers=headers).status_code == 200
        assert client.post('/tv-api/movies/fixture/progress',headers=headers,json={'position':12}).status_code == 200
        item = client.get('/tv-api/movies',headers=headers).json()[0]
        assert item['favorite'] and item['position'] == 12
        uhd = {**meta, 'video':'hevc', 'width':3840, 'height':2160, 'pix_fmt':'yuv420p10le', 'hdr':True}
        with main.db() as conn:
            conn.execute('INSERT INTO movies(id,title,path,metadata,created) VALUES (?,?,?,?,?)',
                         ('uhd', '4K fixture', str(source), json.dumps(uhd), time.time()))
        for quality in ('auto', 'original', '2160'):
            plan = client.post('/tv-api/movies/uhd/plan', headers=headers,
                               json={'quality':quality, 'direct':True, 'video_copy':True}).json()
            assert plan['height'] == 2160 and plan['mode'] == 'Direct Play'
            plan = client.post('/tv-api/movies/uhd/plan', headers=headers,
                               json={'quality':quality, 'direct':False, 'video_copy':True}).json()
            assert plan['height'] == 2160 and plan['mode'] == 'Direct Stream'
        play = client.post('/tv-api/movies/fixture/play',headers=headers,json={'direct':True,'h264':True,'quality':'auto'}).json()
        assert play['mode'] == 'Direct Play' and token not in play['url']
        assert client.get(play['url'],headers={'Range':'bytes=0-9'}).content == b'0123456789'
        assert client.get(play['url'].replace('/fixture/','/other/')).status_code == 403
        assert client.post('/tv-api/media/heartbeat',headers=headers,json={'ticket':play['media_ticket']}).status_code == 200
        with main.db() as conn:
            conn.execute('UPDATE media_grants SET expires=0 WHERE token=?',(media.key(play['media_ticket']),))
        assert client.get(play['url']).status_code == 401
        assert client.post('/tv-api/media/heartbeat',headers=headers,json={'ticket':play['media_ticket']}).status_code == 410
        play = client.post('/tv-api/movies/fixture/play',headers=headers,json={'direct':True}).json()
        assert client.post('/tv-api/logout',headers=headers).status_code == 200
        assert client.get('/tv-api/movies',headers=headers).status_code == 401
        assert client.get(play['url']).status_code == 401
    conn.close()
    main.conn.close()
    gc.collect()
    temporary.cleanup()
