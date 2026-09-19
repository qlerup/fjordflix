import json
import time
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from app import main, opensubtitles, tracks
from test_series import client

MID = 'a'*32
CREDS = {'api_key':'private-key','username':'test-user','password':'private-password'}
SRT = '1\n00:00:01,000 --> 00:00:03,000\nÆble, ø og å.\n'


@pytest.fixture
def provider(client,monkeypatch):
    service = main.subtitle_provider
    monkeypatch.setattr(service,'session',None)
    monkeypatch.setattr(service,'choices',{})
    with main.db() as conn:
        conn.execute('CREATE TABLE catalog_settings(name TEXT PRIMARY KEY,value TEXT)')
        path = main.MEDIA/'film.mp4'; path.write_bytes(b'\0'*131072)
        meta = {'format':'mp4','video':'h264','height':1080,'width':1920,'duration':100,'bitrate':1000000,'audio':'aac','pix_fmt':'yuv420p','hdr':False,
                'catalog':{'tmdb_id':42},'tracks':{'version':1,'audio':[],'subtitles':[]}}
        conn.execute('UPDATE movies SET path=?,metadata=?',(str(path),json.dumps(meta)))
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.host == 'dl.opensubtitles.com':
            assert 'authorization' not in request.headers and 'api-key' not in request.headers
            return httpx.Response(200,content=SRT.encode())
        assert request.headers['api-key']=='private-key'
        if request.url.path.endswith('/login'):
            return httpx.Response(200,json={'token':'jwt-secret','base_url':'api.opensubtitles.com'})
        assert request.headers['authorization']=='Bearer jwt-secret'
        if request.url.path.endswith('/subtitles'):
            assert request.url.params['tmdb_id']=='42'
            assert request.url.params['moviehash']=='0000000000020000'
            return httpx.Response(200,json={'data':[{'attributes':{'language':'da','release':'Film BluRay','moviehash_match':True,'files':[{'file_id':123}]}}]})
        if request.url.path.endswith('/download'):
            assert json.loads(request.content)=={'file_id':123,'sub_format':'srt'}
            return httpx.Response(200,json={'link':'https://dl.opensubtitles.com/sub.srt','remaining':9})
        return httpx.Response(404)
    original = httpx.Client
    monkeypatch.setattr(opensubtitles.httpx,'Client',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    return service, requests


def test_config_search_download_cache_and_playback(client,provider,monkeypatch):
    service, requests = provider
    settings = client.put('/api/admin/opensubtitles',json=CREDS)
    assert settings.status_code==200
    assert 'private-' not in settings.text and 'jwt-secret' not in settings.text
    assert client.get('/api/admin/opensubtitles').json()['configured']
    result = client.get(f'/api/movies/{MID}/subtitle-search').json()['results'][0]
    assert result['hash_match'] and not result['downloaded']
    endpoint = f'/api/movies/{MID}/subtitle-download'
    downloaded = client.post(endpoint,json={'choice':result['choice']})
    assert downloaded.status_code==200,downloaded.text
    index = downloaded.json()['index']
    path = opensubtitles.subtitle_path(main.DATA,MID,index)
    assert path.read_text(encoding='utf-8')==SRT
    count = len(requests)
    assert client.post(endpoint,json={'choice':result['choice']}).json()['cached']
    assert len(requests)==count
    available = client.get(f'/api/movies/{MID}/tracks').json()
    assert available['subtitles'][0]['index']==index
    assert client.get('/api/movies').json()[0]['tracks']['subtitles'][0]['delivery']=='text'
    plan = client.post(f'/api/movies/{MID}/plan',json={'quality':'original','direct':True,'subtitle_track':index})
    assert plan.json()['mode']=='Direct Play'
    output = main.DATA/'fixture.vtt'; output.write_text('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHej\n')
    convert = Mock(return_value=output); monkeypatch.setattr(tracks,'webvtt',convert)
    assert client.get(f'/api/movies/{MID}/subtitles/{index}.vtt').status_code==200
    convert.assert_called_with(path,0,main.DATA/'subtitles')
    assert client.delete('/api/admin/opensubtitles').json()['configured'] is False
    assert path.exists()
    assert client.get(f'/api/movies/{MID}/subtitles/{index}.vtt').status_code==200
    assert client.request('DELETE',f'/api/movies/{MID}',json={'ids':[MID]}).status_code==200
    assert not path.exists()


def test_permissions_and_choice_binding(client,provider,monkeypatch):
    service,_ = provider
    client.put('/api/admin/opensubtitles',json=CREDS)
    choice=client.get(f'/api/movies/{MID}/subtitle-search').json()['results'][0]['choice']
    assert client.post('/api/movies/'+'b'*32+'/subtitle-download',json={'choice':choice}).status_code==400
    service.choices[choice]['expires']=0
    assert client.post(f'/api/movies/{MID}/subtitle-download',json={'choice':choice}).status_code==400
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'admin':False,'id':'viewer'})
    for endpoint in ('/api/admin/opensubtitles',f'/api/movies/{MID}/subtitle-search'):
        assert client.get(endpoint).status_code==403
    assert client.post(f'/api/movies/{MID}/subtitle-download',json={'choice':choice}).status_code==403
    assert client.put('/api/admin/opensubtitles',json=CREDS).status_code==403


def test_download_validation_and_quota_errors(client,provider,monkeypatch):
    service,_ = provider
    for link in ('http://dl.opensubtitles.com/sub','https://127.0.0.1/sub','https://dl.opensubtitles.com.evil.test/sub','https://user:pass@dl.opensubtitles.com/sub'):
        with pytest.raises(ValueError): service.fetch_file(link)
    for raw in (b'',b'<html>login page</html>',b'a'*(opensubtitles.LIMIT+1)):
        with pytest.raises(ValueError): opensubtitles.normalize_srt(raw)
    assert opensubtitles.normalize_srt(SRT.encode('cp1252'))==SRT
    class Quota:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def request(self,*args,**kwargs): return httpx.Response(429)
    monkeypatch.setattr(opensubtitles.httpx,'Client',lambda **kwargs:Quota())
    with pytest.raises(ValueError,match='kvoten'): service.request('/download',credentials=CREDS)


def test_external_tracks_survive_rescan_and_avoid_duplicates():
    external = {'index':opensubtitles.OFFSET+1,'external':True,'delivery':'text'}
    meta = {'external_subtitles':[external],'tracks':{'subtitles':[{'index':3,'delivery':'burn'},external]}}
    assert len(tracks.displayed(meta)['subtitles'])==2
    assert tracks.select(meta,subtitle_index=external['index'])[1]==external


def test_downloaded_srt_converts_to_webvtt(tmp_path):
    import shutil
    if not shutil.which('ffmpeg'): pytest.skip('Requires FFmpeg')
    source = tmp_path/'download.srt'
    source.write_text(SRT,encoding='utf-8')
    result = tracks.webvtt(source,0,tmp_path/'cache')
    content = result.read_text(encoding='utf-8')
    assert content.startswith('WEBVTT') and 'Æble, ø og å.' in content
    assert '00:01.000 --> 00:03.000' in content
