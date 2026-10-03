import io
import json
import zipfile

import httpx
import pytest
from app import main, opensubtitles
from app.subdl import SubDL
from test_series import client
from test_opensubtitles import MID, SRT, CREDS


@pytest.fixture
def providers(client, monkeypatch):
    manager = main.subtitle_manager
    for service in manager.providers.values():
        monkeypatch.setattr(service,'choices',{})
        monkeypatch.setattr(service,'session',None)
    with main.db() as conn:
        conn.execute('CREATE TABLE catalog_settings(name TEXT PRIMARY KEY,value TEXT)')
        path = main.MEDIA/'Film.Release.mkv'; path.write_bytes(b'0'*131072)
        meta = {'catalog':{'tmdb_id':42},'tracks':{'audio':[],'subtitles':[]}}
        conn.execute('UPDATE movies SET path=?,metadata=?',(str(path),json.dumps(meta)))
    requests = []
    response_data = {'status':True,'results':[{'tmdb_id':42}],'subtitles':[{'release_name':'Film.Release.mkv','language':'Danish',
        'url':'/subtitle/123-456.zip'}]}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive,'w') as z: z.writestr('film.srt',SRT)
    def handler(request):
        requests.append(request)
        if request.url.host=='dl.subdl.com':
            assert 'api_key' not in request.url.params and 'authorization' not in request.headers
            return httpx.Response(200,content=archive.getvalue())
        if request.url.host=='api.subdl.com':
            assert request.url.params['api_key']=='subdl-secret'
            if request.url.path.endswith('/me'): return httpx.Response(200,json={'status':True})
            assert request.url.params['tmdb_id']=='42'
            return httpx.Response(200,json=response_data)
        if request.url.path.endswith('/login'):
            return httpx.Response(200,json={'token':'os-token'})
        return httpx.Response(200,json={'data':[]})
    original = httpx.Client
    monkeypatch.setattr(httpx,'Client',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    return manager, requests, response_data


def configure(client, **kwargs):
    response = client.put('/api/admin/subtitles',json={'provider':'subdl','api_key':'subdl-secret',**kwargs})
    assert response.status_code==200,response.text
    assert 'subdl-secret' not in response.text
    return response.json()


def test_switch_only_active_provider_and_reuse_saved_keys(client, providers):
    manager, requests, _ = providers
    assert client.put('/api/admin/opensubtitles',json=CREDS).status_code==200
    assert configure(client)['provider']=='subdl'
    item = client.get(f'/api/movies/{MID}/subtitle-search').json()['results'][0]
    assert item['release_match']
    count = len(requests)
    result = client.put('/api/admin/subtitles',json={'provider':'opensubtitles'})
    assert result.status_code==200 and result.json()['configured']
    assert len(requests)==count, 'switching back reuses saved credentials'
    assert client.post(f'/api/movies/{MID}/subtitle-download',json={'choice':item['choice']}).status_code==400
    assert len(requests)==count, 'inactive provider never receives stale downloads'
    assert client.get(f'/api/movies/{MID}/subtitle-search').json()['provider']=='opensubtitles'
    assert requests[-1].url.host=='api.opensubtitles.com'


def test_subdl_download_cache_and_disjoint_track_ids(client, providers):
    manager, requests, _ = providers
    configure(client)
    item = client.get(f'/api/movies/{MID}/subtitle-search').json()['results'][0]
    endpoint = f'/api/movies/{MID}/subtitle-download'
    result = client.post(endpoint,json={'choice':item['choice']})
    assert result.status_code==200,result.text
    index = result.json()['index']
    assert 2*opensubtitles.OFFSET < index < 2**49
    path = opensubtitles.subtitle_path(main.DATA,MID,index)
    assert path.read_text(encoding='utf-8')==SRT
    count = len(requests)
    assert client.post(endpoint,json={'choice':item['choice']}).json()['cached']
    assert len(requests)==count
    assert client.delete('/api/admin/subtitles').json()['configured'] is False
    assert path.exists()
    assert main.movie(MID)[1]['external_subtitles'][0]['title'].startswith('SubDL')


def test_automatic_primary_fallback_existing_and_failed_import(client, providers, monkeypatch):
    manager, requests, data = providers
    configure(client,automatic=True)
    original = manager.providers['subdl'].search
    languages = []
    def search(mid, language):
        languages.append(language)
        if language=='da': return {'results':[]}
        data['subtitles'][0]['language']='English'
        return original(mid,language)
    monkeypatch.setattr(manager.providers['subdl'],'search',search)
    manager.automatic(MID)
    meta = main.movie(MID)[1]
    assert languages==['da','en']
    assert meta['subtitle_fetch']['status']=='downloaded'
    assert meta['external_subtitles'][0]['language']=='en'
    count = len(requests)
    manager.automatic(MID)
    assert len(requests)==count, 'existing English fallback is reused after empty Danish search'
    assert main.movie(MID)[1]['subtitle_fetch']['status']=='available'
    monkeypatch.setattr(manager.providers['subdl'],'search',lambda *a:(_ for _ in ()).throw(ValueError('private-key')))
    manager.automatic(MID)
    assert main.movie(MID)[1]['subtitle_fetch']['status']=='error'
    assert 'private-key' not in json.dumps(main.movie(MID)[1])


def test_automatic_disabled_unmatched_and_embedded_text(client, providers):
    manager, requests, _ = providers
    configure(client)
    count = len(requests); manager.automatic(MID); assert len(requests)==count
    configure(client,automatic=True)
    with main.db() as conn:
        meta = {'catalog':{'tmdb_id':42},'tracks':{'subtitles':[{'index':1,'language':'dan','delivery':'text'}]}}
        conn.execute('UPDATE movies SET metadata=?',(json.dumps(meta),))
    count = len(requests); manager.automatic(MID); assert len(requests)==count
    with main.db() as conn: conn.execute("UPDATE movies SET metadata='{}'")
    manager.automatic(MID)
    assert main.movie(MID)[1]['subtitle_fetch']['status']=='needs_match'
    assert len(requests)==count


def test_subdl_tv_episode_selection_and_download_validation(client, providers):
    manager, _, data = providers
    configure(client)
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=?',(json.dumps({'catalog':{'tmdb_id':42,'media_type':'tv','season':2,'episode':3}}),))
    data['subtitles'] = [{'full_season':True,'season':2,'unpack_files':[
        {'season':2,'episode':2,'language':'DA','format':'srt','url':'/subtitle/123/wrong'},
        {'season':2,'episode':3,'language':'DA','format':'srt','url':'/subtitle/123/right'}]}]
    result = manager.search(MID,'da')['results']
    assert len(result)==1
    assert manager.providers['subdl'].choices[result[0]['choice']]['link'].endswith('/right')
    for link in ['https://127.0.0.1/subtitle/1.zip','//evil.test/subtitle/1.zip',
                 'https://dl.subdl.com.evil.test/subtitle/1.zip','/subtitle/1.zip?api_key=secret']:
        with pytest.raises(ValueError): SubDL.download_url(link)


def test_settings_permissions_and_validation(client, providers, monkeypatch):
    assert client.put('/api/admin/subtitles',json={'provider':'both'}).status_code==422
    assert client.put('/api/admin/subtitles',json={'provider':'subdl','language':'xx'}).status_code==400
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'admin':False,'id':'viewer'})
    assert client.get('/api/admin/subtitles').status_code==403
    assert client.put('/api/admin/subtitles',json={'provider':'subdl'}).status_code==403
    assert client.delete('/api/admin/subtitles').status_code==403


def test_subdl_broadened_search_does_not_download_another_title(client, providers):
    manager, requests, data = providers
    configure(client,automatic=True)
    data['results'] = [{'tmdb_id':999}]
    manager.automatic(MID)
    assert main.movie(MID)[1]['subtitle_fetch']['status']=='not_found'
    assert not any(r.url.host=='dl.subdl.com' for r in requests)


def test_new_import_invokes_automatic_and_keeps_downloaded_track(client, providers, monkeypatch):
    configure(client,automatic=True)
    monkeypatch.setattr(main,'probe',lambda path:{'duration':10,'tracks':{'audio':[],'subtitles':[]}})
    monkeypatch.setattr(main.subprocess,'run',lambda *a,**kw:None)
    monkeypatch.setattr(main.catalog,'enrich',lambda *a:{'tmdb_id':42})
    path = main.MEDIA/'new.mkv';path.write_bytes(b'0'*131072)
    mid = 'b'*32
    main.index_movie(path,'New film',mid,enrich=True)
    meta = main.movie(mid)[1]
    assert meta['subtitle_fetch']['status']=='downloaded'
    assert meta['external_subtitles'][0]['language']=='da'


@pytest.mark.parametrize('content', ['multiple','oversized','invalid'])
def test_subdl_rejects_ambiguous_or_oversized_archives(client, providers, monkeypatch, content):
    from httpx._client import Client
    archive = io.BytesIO()
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('a.srt',b'a'*(opensubtitles.LIMIT+1) if content=='oversized' else SRT)
        if content=='multiple': z.writestr('b.srt',SRT)
    raw = b'invalid zip' if content=='invalid' else archive.getvalue()
    monkeypatch.setattr(httpx,'Client',lambda **kw:Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=raw)),**kw))
    with pytest.raises(ValueError): providers[0].providers['subdl'].content({'link':'https://dl.subdl.com/subtitle/123.zip'})


def test_subdl_quota_and_connection_errors_do_not_leak_keys(client, providers, monkeypatch):
    from httpx._client import Client
    for status in (401,429,500):
        monkeypatch.setattr(httpx,'Client',lambda **kw:Client(transport=httpx.MockTransport(lambda r:httpx.Response(status)),**kw))
        response = client.put('/api/admin/subtitles',json={'provider':'subdl','api_key':'subdl-secret'})
        assert response.status_code==400 and 'subdl-secret' not in response.text
        assert not client.get('/api/admin/subtitles').json()['providers']['subdl']['configured']
