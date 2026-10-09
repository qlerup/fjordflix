import sqlite3

import httpx
import pytest
from app import catalog, main
from test_series import client


@pytest.fixture
def provider(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, '_db', None)
    catalog.init(lambda: sqlite3.connect(tmp_path / 'trailers.db'))
    monkeypatch.setattr(catalog, 'credential', lambda: ('token', 'settings'))
    calls = []
    def install(videos):
        def get(url, **kwargs):
            calls.append(kwargs['params']['language'])
            return httpx.Response(200, request=httpx.Request('GET', url), json={'results': videos})
        monkeypatch.setattr(httpx, 'get', get)
    yield install, calls
    catalog._db = None


def video(key='abcdefghijk', **extra):
    return {'key': key, 'site': 'YouTube', 'type': 'Trailer', 'iso_639_1': 'en', 'official': True, **extra}


def test_official_then_danish_preference_and_cache(provider):
    install, calls = provider
    install([video('enofficial1'), video('daunofficia', iso_639_1='da', official=False),
             video('daofficial1', iso_639_1='da')])
    result = catalog.trailer({'tmdb_id': 42})
    assert result['trailer']['url'].endswith('daofficial1')
    assert catalog.trailer({'tmdb_id': 42}) == result
    assert calls == ['da-DK', 'en-US']


def test_only_valid_trailer_links_and_negative_cache(provider):
    install, calls = provider
    install([video('https://evil.test'), video(type='Teaser'), video(site='Vimeo'), video(iso_639_1='fr')])
    assert catalog.trailer({'tmdb_id': 42}) == {'trailer': None}
    assert catalog.trailer({'tmdb_id': 42}) == {'trailer': None}
    assert len(calls) == 2


def test_no_key_no_id_and_series_do_not_fetch(provider, monkeypatch):
    install, calls = provider
    install([video()])
    for info in ({}, {'tmdb_id': True}, {'tmdb_id': -1}, {'tmdb_id': 42, 'media_type': 'tv'}):
        assert catalog.trailer(info) == {'trailer': None}
    monkeypatch.setattr(catalog, 'credential', lambda: ('', 'none'))
    assert catalog.trailer({'tmdb_id': 42}) == {'trailer': None}
    assert calls == []


def test_outage_is_optional_and_throttled(provider, monkeypatch):
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        raise httpx.ConnectError('offline')
    monkeypatch.setattr(httpx, 'get', fail)
    assert catalog.trailer({'tmdb_id': 42}) == {'trailer': None}
    assert catalog.trailer({'tmdb_id': 42}) == {'trailer': None}
    assert len(calls) == 1


def test_trailer_endpoint_checks_movie_and_login(client, monkeypatch):
    monkeypatch.setattr(main.catalog, 'trailer', lambda info: {'trailer': {'url': 'https://www.youtube.com/watch?v=abcdefghijk'}})
    assert client.get('/api/movies/' + 'a' * 32 + '/trailer').json()['trailer']['url'].endswith('abcdefghijk')
    assert client.get('/api/movies/' + 'f' * 32 + '/trailer').status_code == 404
    with main.db() as conn:
        conn.executescript('CREATE TABLE sessions(token TEXT,user_id TEXT,expires REAL); CREATE TABLE users(id TEXT,name TEXT,admin INTEGER,hub_id TEXT,hub_username TEXT); CREATE TABLE revoked_sessions(token TEXT,expires REAL);')
    monkeypatch.delitem(main.app.dependency_overrides, main.user)
    client.cookies.clear()
    assert client.get('/api/movies/' + 'a' * 32 + '/trailer').status_code == 401


def test_embed_policy_only_allows_youtube_player(client):
    response = client.get('/')
    policy = response.headers['content-security-policy']
    assert 'frame-src https://www.youtube-nocookie.com;' in policy
    assert "frame-ancestors 'none'" in policy
    assert response.headers['referrer-policy'] == 'same-origin'
