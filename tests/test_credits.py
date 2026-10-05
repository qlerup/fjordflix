import httpx
import pytest
from app import catalog


def test_credits_cache_and_safe_portraits(monkeypatch, tmp_path):
    import sqlite3
    monkeypatch.setattr(catalog, '_db', None)
    monkeypatch.setattr(catalog, '_data', None)
    catalog.init(lambda: sqlite3.connect(tmp_path / 'credits.db'), tmp_path)
    monkeypatch.setattr(catalog, 'credential', lambda: ('token', 'settings'))
    calls = []
    def get(url, **kwargs):
        calls.append(url)
        assert kwargs['params']['language'] == 'da-DK'
        return httpx.Response(200, request=httpx.Request('GET', url), json={'cast':[
            {'name':'Actor', 'character':'Hero', 'profile_path':'/abc.jpg'},
            {'name':'Other', 'roles':[{'character':'Guest'}], 'profile_path':'https://bad.test/a.jpg'}]})
    monkeypatch.setattr(httpx, 'get', get)
    downloads = []
    def download(profile, destination, size):
        downloads.append(profile)
        destination.write_bytes(b'jpeg')
        return True
    monkeypatch.setattr(catalog, 'download_image', download)
    try:
        first = catalog.credits({'tmdb_id':42})
        assert first['cast'][0]['profile_url'] == '/api/people/abc.jpg'
        assert first['cast'][1]['profile_url'] is None
        assert first == catalog.credits({'tmdb_id':42}) and len(calls) == 1
        assert catalog.credits({'tmdb_id':42,'media_type':'tv'})['cast'][1]['character'] == 'Guest'
        assert calls[-1].endswith('/tv/42/aggregate_credits')
        assert downloads == ['/abc.jpg']
        monkeypatch.setattr(catalog.time, 'time', lambda: 99999999999)
        catalog.credits({'tmdb_id':42})
        assert len(calls) == 2, 'saved credits do not expire and trigger repeat API calls'
        assert catalog.credits({}) == {'cast':[]}
    finally:
        catalog._db = None


@pytest.mark.parametrize('original,expected', [
    ('Self', 'Sig selv'), ('Himself', 'Sig selv'), ('Herself', 'Sig selv'),
    ('Self - Host', 'Sig selv – vært'), ('Narrator', 'Fortæller'),
    ('Self (archive footage)', 'Sig selv (arkivoptagelser)'),
    ('Elsa (voice)', 'Elsa (stemme)'), ('Host, Self', 'Vært, Sig selv'),
    ('James Bond', 'James Bond'), ('John Self', 'John Self'),
    ('Sig selv', 'Sig selv'), ('', ''),
])
def test_generic_roles_are_danish_and_character_names_are_preserved(original, expected):
    assert catalog.danish_character(original) == expected


def test_saved_english_credits_are_translated_without_refetch(monkeypatch, tmp_path):
    import json
    import sqlite3
    monkeypatch.setattr(catalog, '_db', None)
    monkeypatch.setattr(catalog, '_data', None)
    db = lambda: sqlite3.connect(tmp_path / 'credits.db')
    catalog.init(db)
    cached = {'cast': [{'name': 'Uffe Holm', 'character': 'Self', 'profile_path': None}]}
    with db() as conn:
        conn.execute('INSERT INTO catalog_settings VALUES (?, ?)', ('credits:movie:42', json.dumps(cached)))
    def unexpected_fetch(*args, **kwargs):
        pytest.fail('Saved credits should not be fetched again')
    monkeypatch.setattr(httpx, 'get', unexpected_fetch)
    assert catalog.credits({'tmdb_id': 42})['cast'][0]['character'] == 'Sig selv'
    assert catalog.credits({'tmdb_id': 42})['cast'][0]['name'] == 'Uffe Holm'
    with db() as conn:
        stored = json.loads(conn.execute('SELECT value FROM catalog_settings').fetchone()[0])
    assert stored == cached


def test_enrichment_prefetches_credits(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, 'lookup', lambda title: {'status':'matched','tmdb_id':42})
    monkeypatch.setattr(catalog, 'download_image', lambda *args: False)
    seen = []
    monkeypatch.setattr(catalog, 'credits', lambda info: seen.append(info['tmdb_id']))
    assert catalog.enrich('Film', 'abc', tmp_path)['status'] == 'matched'
    assert seen == [42]
