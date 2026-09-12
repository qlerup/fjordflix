import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient
from app import catalog, main, library


@pytest.mark.parametrize('filename,season,episode', [
    ('The.Show.S02E10.1080p', 2, 10), ('The_Show_s01e02', 1, 2),
    ('The Show S00E01', 0, 1), ('The Show 2x10', 2, 10), ('The Show S02E10j', 2, 10),
])
def test_identify(filename, season, episode):
    info = catalog.identify(filename)
    assert info['media_type'] == 'tv'
    assert info['series_title'] == 'The Show'
    assert (info['season'], info['episode']) == (season, episode)


def test_tv_offline_and_no_false_movie_match(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, 'credential', lambda: ('', 'none'))
    result = catalog.lookup('The Show 2020 S02E10 1080p')
    assert result['status'] == 'disabled' and result['series_year'] == '2020'
    assert catalog.identify('Se7en 1995 1080p')['media_type'] == 'movie'
    def fail(title):
        raise httpx.ConnectError('offline')
    monkeypatch.setattr(catalog, 'lookup', fail)
    result = catalog.enrich('The Show S02E10', 'abc', tmp_path)
    assert result['media_type'] == 'tv' and result['season'] == 2


@pytest.mark.parametrize('episode_missing', [False, True])
def test_tv_lookup(monkeypatch, episode_missing):
    monkeypatch.setattr(catalog, 'credential', lambda: ('token', 'settings'))
    requests = []
    def handler(request):
        requests.append(str(request.url))
        path = request.url.path
        if path.endswith('/search/tv'):
            assert request.url.params['first_air_date_year'] == '2020'
            return httpx.Response(200, json={'results': [{'id': 42, 'name': 'The Show', 'first_air_date': '2020-01-01'}]})
        if '/episode/' in path:
            assert path.endswith('/season/2/episode/10')
            if episode_missing:
                return httpx.Response(404)
            return httpx.Response(200, json={'name': 'Afsnit ti', 'overview': 'Episode summary' if request.url.params['language'] == 'en-US' else '', 'air_date': '2021-03-04'})
        return httpx.Response(200, json={'name': 'Serien', 'first_air_date': '2020-01-01', 'overview': 'Seriebeskrivelse', 'poster_path': '/abc.jpg', 'genres': [{'name': 'Drama'}]})
    client = httpx.Client
    monkeypatch.setattr(catalog.httpx, 'Client', lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    result = catalog.lookup('The Show 2020 S02E10')
    assert result['media_type'] == 'tv' and result['series_title'] == 'Serien'
    assert result['series_overview'] == 'Seriebeskrivelse'
    assert result['episode_status'] == ('missing' if episode_missing else 'matched')
    assert result['overview'] == ('' if episode_missing else 'Episode summary')
    assert '/search/movie' not in ''.join(requests)


@pytest.fixture
def client(monkeypatch, tmp_path):
    def db():
        conn = sqlite3.connect(tmp_path / 'library.db')
        conn.row_factory = sqlite3.Row
        return conn
    monkeypatch.setattr(main, 'db', db)
    monkeypatch.setattr(main, 'DATA', tmp_path)
    monkeypatch.setattr(main, 'MEDIA', tmp_path / 'media')
    main.MEDIA.mkdir()
    monkeypatch.setattr(main.media, 'config', lambda: ('', ''))
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': True, 'id': 'owner'})
    (tmp_path / 'posters').mkdir()
    with db() as conn:
        conn.executescript('CREATE TABLE movies(id TEXT PRIMARY KEY,title TEXT,path TEXT,metadata TEXT,created REAL); CREATE TABLE progress(user_id TEXT,movie_id TEXT,position REAL,favorite INTEGER);')
        conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', ('a'*32, 'Show S01E02', '/video.mkv', json.dumps({'duration': 100, 'video': 'hevc', 'height': 2160}), 0))
        conn.execute('INSERT INTO progress VALUES (?,?,?,?)', ('owner', 'a'*32, 32, 1))
    return TestClient(main.app)


def test_legacy_and_manual_edit(client, monkeypatch):
    item = client.get('/api/movies').json()[0]
    assert item['catalog']['episode'] == 2 and item['series_key']
    data = {'title': 'Edited episode', 'media_type': 'tv', 'series_title': 'Show', 'season': 2, 'episode': 10, 'overview': '<script>not html</script>'}
    endpoint = '/api/movies/' + 'a'*32 + '/metadata'
    assert client.put(endpoint, json=data).status_code == 200
    item = client.get('/api/movies').json()[0]
    assert item['catalog']['manual'] and item['catalog']['season'] == 2
    assert item['video'] == 'hevc' and item['height'] == 2160
    assert item['position'] == 32 and item['favorite']
    assert client.put(endpoint, json={**data, 'episode': 0}).status_code == 422
    assert client.put(endpoint, json={**data, 'release_date': '2025-99-99'}).status_code == 400
    assert client.put(endpoint, json={**data, 'series_title': ' '}).status_code == 400
    assert client.put(endpoint, json=data, headers={'Origin': 'https://evil.example'}).status_code == 403
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': False, 'id': 'owner'})
    assert client.put(endpoint, json=data).status_code == 403
    assert client.put('/api/movies/'+'a'*32+'/artwork/poster', content=b'bad').status_code == 403


def test_manual_movie_is_not_reclassified(client):
    endpoint = '/api/movies/'+'a'*32+'/metadata'
    assert client.put(endpoint, json={'title': 'Show S01E02', 'media_type': 'movie'}).status_code == 200
    assert client.get('/api/movies').json()[0]['series_key'] is None


def test_invalid_artwork(client):
    assert client.put('/api/movies/'+'a'*32+'/artwork/poster', content=b'<svg/>').status_code == 400
    assert client.put('/api/movies/'+'a'*32+'/artwork/poster', content=b'x'*(8*1024**2+1)).status_code == 413


def test_manual_artwork_preserves_playback(client):
    import base64
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
    response = client.put('/api/movies/'+'a'*32+'/artwork/poster', content=png)
    assert response.status_code == 200, response.text
    item = client.get('/api/movies').json()[0]
    assert item['catalog']['poster_cached'] and item['duration'] == 100
    assert client.get('/api/movies/'+'a'*32+'/poster').content.startswith(b'\xff\xd8\xff')


def test_upload_auto_series_without_api(client, monkeypatch):
    monkeypatch.setattr(catalog, 'credential', lambda: ('', 'none'))
    monkeypatch.setattr(main, 'probe', lambda path: {'duration': 120, 'video': 'h264', 'height': 1080})
    monkeypatch.setattr(main.subprocess, 'run', lambda *args, **kwargs: None)
    response = client.put('/api/upload', params={'filename': 'Example.Show.2020.S02E10.1080p.mkv'}, content=b'test video')
    assert response.status_code == 200, response.text
    uploaded = next(m for m in client.get('/api/movies').json() if m['id'] == response.json()['id'])
    assert uploaded['catalog']['media_type'] == 'tv'
    assert uploaded['catalog']['series_title'] == 'Example Show'
    assert uploaded['catalog']['season'] == 2 and uploaded['catalog']['episode'] == 10
    assert uploaded['series_key'] == 'local:exampleshow:2020'
    assert uploaded['title'] == 'Example Show · S02E10'


def test_offline_episodes_join_unique_tmdb_series(client):
    with main.db() as conn:
        conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', ('b'*32, 'Dansk serie', '/video2.mkv', json.dumps({
            'original_title': 'Show S01E03', 'catalog': {'media_type':'tv', 'series_title':'Dansk serie',
            'tmdb_id':42, 'season':1, 'episode':3, 'series_year':'2020'}}), 1))
    items = client.get('/api/movies').json()
    assert {m['series_key'] for m in items} == {'tmdb:42'}
