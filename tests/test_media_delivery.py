import json
import time
import secrets
from urllib.parse import urlparse

from fastapi.testclient import TestClient
from test_integration import main


def test_direct_media_scoping_renewal_revocation_and_proxy_block(tmp_path):
    uid, mid = secrets.token_hex(16), secrets.token_hex(16)
    login=secrets.token_urlsafe(32)
    movie=tmp_path/'sample.mp4';movie.write_bytes(b'0123456789'*100)
    meta={'format':'mov,mp4','video':'h264','audio':'aac','width':1280,'height':720,'duration':12,'bitrate':4000000,'size':1000,'hdr':False,'pix_fmt':'yuv420p'}
    with main.db() as conn:
        conn.execute('INSERT INTO users(id,name,password,admin) VALUES (?,?,?,1)',(uid,uid,'unused'))
        conn.execute('INSERT INTO sessions VALUES (?,?,?)',(main.digest(login),uid,time.time()+1000))
        conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)',(mid,'Sample',str(movie),json.dumps(meta),time.time()))
    web=TestClient(main.app,base_url='http://web.test')
    web.cookies.set('fjordflix_session',login)
    direct=TestClient(main.app,base_url='http://video.test')
    try:
        assert web.put('/api/admin/media',json={'web_url':'https://web.test','media_url':'http://video.test'}).status_code==400
        assert web.put('/api/admin/media',json={'web_url':'http://web.test','media_url':'http://video.test'}).status_code==200
        result=web.post(f'/api/movies/{mid}/play',json={'quality':'original','direct':True,'h264':True,'bandwidth':100}).json()
        assert result['delivery']=='direct' and result['encoder']=='Original',result
        path=urlparse(result['url']).path;ticket=result['media_ticket']
        response=direct.get(path,headers={'Origin':'http://web.test','Range':'bytes=10-19'})
        assert response.status_code==206 and response.content==b'0123456789'
        assert response.headers['access-control-allow-origin']=='http://web.test'
        assert 'set-cookie' not in response.headers
        assert direct.head(path).status_code==200
        assert direct.options(path,headers={'Origin':'http://web.test','Access-Control-Request-Headers':'Range'}).status_code==204
        assert direct.get(path,headers={'Origin':'http://evil.test'}).status_code==403
        assert direct.get(path,headers={'CF-Ray':'example'}).status_code==403
        assert web.get(path).status_code==403
        assert web.get(f'/api/movies/{mid}/file').status_code==409
        assert direct.get(path.replace(mid,'other-movie')).status_code==403
        # A local browser must not depend on the public VPN forwarding port.
        with TestClient(main.app, base_url='http://192.168.1.110:8097') as lan:
            lan.cookies.set('fjordflix_session', login)
            local = lan.post(f'/api/movies/{mid}/play', json={'quality':'original','direct':True,'h264':True}).json()
            assert local['delivery'] == 'same-origin'
            assert local['url'].startswith('/media/')
            assert lan.get(local['url'], headers={'Origin':'http://192.168.1.110:8097','Range':'bytes=10-19'}).status_code == 206
            assert lan.get(local['url'], headers={'Origin':'http://evil.test'}).status_code == 403
            assert lan.get(local['url'], headers={'CF-Ray':'proxied'}).status_code == 403
            assert web.get(local['url']).status_code == 403
            # HLS manifests and segments use the same local, scoped-ticket route.
            from starlette.requests import Request
            folder = tmp_path / 'hls'; folder.mkdir()
            (folder / 'index.m3u8').write_text('#EXTM3U\n#EXTINF:2,\nsegment00000.ts\n')
            (folder / 'segment00000.ts').write_bytes(b'test-segment')
            sid = secrets.token_hex(16)
            main.JOBS[sid] = {'folder':folder,'user':uid,'touch':time.time()}
            try:
                request = Request({'type':'http','scheme':'http','server':('192.168.1.110',8097),'path':'/','query_string':b'',
                    'headers':[(b'host',b'192.168.1.110:8097'),(b'cookie',f'fjordflix_session={login}'.encode())]})
                stream = main.media.issue({'session':sid},request,mid,main.db)
                manifest = lan.get(stream['url'], headers={'Origin':'http://192.168.1.110:8097'})
                assert manifest.status_code == 200 and '#EXTM3U' in manifest.text
                assert lan.get(stream['url'].replace('index.m3u8','segment00000.ts')).content == b'test-segment'
                assert lan.post('/api/media/revoke',json={'ticket':stream['media_ticket']}).status_code == 200
                assert lan.get(stream['url']).status_code == 401
            finally:
                main.JOBS.pop(sid, None)
        assert web.post('/api/media/heartbeat',json={'ticket':ticket}).status_code==200
        assert direct.post('/api/media/heartbeat',json={'ticket':ticket}).status_code==401
        assert web.post('/api/media/revoke',json={'ticket':ticket}).status_code==200
        assert direct.get(path).status_code==401
        result=web.post(f'/api/movies/{mid}/play',json={'quality':'original','direct':True,'h264':True}).json()
        with main.db() as conn:
            conn.execute('UPDATE media_grants SET expires=0')
        assert direct.get(urlparse(result['url']).path).status_code==401
        assert web.post('/api/media/heartbeat',json={'ticket':result['media_ticket']}).status_code==410
        result=web.post(f'/api/movies/{mid}/play',json={'quality':'original','direct':True,'h264':True}).json()
        assert web.post('/api/logout').status_code==200
        assert direct.get(urlparse(result['url']).path).status_code==401
    finally:
        main.media.save_config('','',main.db)
        web.close();direct.close()


def test_gateway_probe_without_enabling_media():
    main.media.save_config('', '', main.db)
    main.media.prepare_probe('media.test', 'test-proof', main.db)
    with TestClient(main.app, base_url='https://media.test') as client:
        assert client.get('/media/connection-check').json() == {'nonce':'test-proof'}
        assert client.get('/media/connection-check',headers={'CF-Ray':'proxied'}).status_code == 403
        assert client.get('/media/connection-check',headers={'Host':'other.test'}).status_code == 404
        assert main.media.config() == ('','')
        with main.db() as conn:
            conn.execute("UPDATE media_settings SET value='0' WHERE name='probe_expires'")
        assert client.get('/media/connection-check').status_code == 404
