import httpx
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


def test_enrichment_prefetches_credits(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, 'lookup', lambda title: {'status':'matched','tmdb_id':42})
    monkeypatch.setattr(catalog, 'download_image', lambda *args: False)
    seen = []
    monkeypatch.setattr(catalog, 'credits', lambda info: seen.append(info['tmdb_id']))
    assert catalog.enrich('Film', 'abc', tmp_path)['status'] == 'matched'
    assert seen == [42]
