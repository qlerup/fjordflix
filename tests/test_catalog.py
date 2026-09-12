from pathlib import Path
import httpx
import pytest
from app import catalog


def test_filename_cleanup():
    assert catalog.clean_title('The.Matrix.1999.1080p.BluRay.x264') == ('The Matrix', '1999')
    assert catalog.clean_title('1917 1080p') == ('1917', None)


def test_conservative_matching():
    films = [{'id': 1, 'title': 'Dune', 'release_date': '1984-01-01'},
             {'id': 2, 'title': 'Dune', 'release_date': '2021-01-01'}]
    assert catalog.choose_match(films, 'Dune', None) is None
    assert catalog.choose_match(films, 'Dune', '2021')['id'] == 2
    assert catalog.choose_match(films, 'Home video', None) is None


def test_ambiguous_lookup_returns_candidates_and_selection_skips_search(monkeypatch):
    monkeypatch.setattr(catalog, 'credential', lambda: ('private-token', 'settings'))
    requests = []
    def handler(request):
        requests.append(request.url.path)
        if request.url.path.endswith('/search/tv'):
            return httpx.Response(200, json={'results':[
                {'id':1412, 'name':'Arrow', 'first_air_date':'2012-10-10', 'poster_path':'/valid.jpg'},
                {'id':999, 'name':'Arrow', 'first_air_date':'2020-01-01', 'poster_path':'https://evil.example/image.jpg'}]})
        if '/episode/' in request.url.path:
            assert request.url.path.endswith('/tv/1412/season/3/episode/2')
            return httpx.Response(200, json={'name':'Episode two', 'overview':'Episode summary'})
        assert request.url.path.endswith('/tv/1412')
        return httpx.Response(200, json={'name':'Arrow', 'overview':'Series summary', 'first_air_date':'2012-10-10'})
    client = httpx.Client
    monkeypatch.setattr(catalog.httpx, 'Client', lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    result = catalog.lookup('Arrow S03E02')
    assert result['status'] == 'unmatched'
    assert [c['id'] for c in result['candidates']] == [1412,999]
    assert result['candidates'][0]['year'] == '2012'
    assert result['candidates'][1]['poster_url'] is None
    assert 'private-token' not in str(result)
    requests.clear()
    selected = catalog.lookup('Arrow S03E02', tmdb_id=1412)
    assert selected['status'] == 'matched' and selected['episode'] == 2
    assert not any('/search/' in path for path in requests)


def test_disabled(monkeypatch):
    monkeypatch.delenv('TMDB_READ_ACCESS_TOKEN', raising=False)
    assert catalog.lookup('Dune')['status'] == 'disabled'


def test_network_failure_keeps_upload(monkeypatch, tmp_path):
    def fail(title):
        raise httpx.ConnectError('offline')
    monkeypatch.setattr(catalog, 'lookup', fail)
    assert catalog.enrich('Dune', 'abc', tmp_path) == {'status': 'error', 'media_type': 'movie', 'error_code': 'network'}


@pytest.mark.parametrize('status,code', [(401, 'unauthorized'), (403, 'unauthorized'), (429, 'rate_limited'), (503, 'provider_error')])
def test_lookup_errors_are_actionable_without_exposing_credentials(monkeypatch, tmp_path, status, code):
    def fail(title):
        response = httpx.Response(status, request=httpx.Request('GET', 'https://api.themoviedb.org/3/search/tv?api_key=secret'))
        response.raise_for_status()
    monkeypatch.setattr(catalog, 'lookup', fail)
    result = catalog.enrich('Arrow S03E02', 'abc', tmp_path)
    assert result['error_code'] == code
    assert result['season'] == 3 and result['episode'] == 2
    assert 'secret' not in str(result) + catalog.message(result)


def test_lookup_timeout_is_distinct(monkeypatch, tmp_path):
    def fail(title):
        raise httpx.ReadTimeout('secret request URL')
    monkeypatch.setattr(catalog, 'lookup', fail)
    result = catalog.enrich('Arrow S03E02', 'abc', tmp_path)
    assert result['error_code'] == 'timeout'
    assert 'secret' not in catalog.message(result)


def test_images_failure_keeps_metadata(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, 'lookup', lambda title: {'status': 'matched', 'title': 'Dune', 'poster_path': '/abc.jpg'})
    monkeypatch.setattr(catalog, 'download_image', lambda *args: False)
    result = catalog.enrich('Dune', 'abc', tmp_path)
    assert result['title'] == 'Dune'
    assert result['poster_cached'] is False


def test_episode_still_download_uses_its_own_file(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, 'lookup', lambda title: {'status':'matched', 'media_type':'tv',
                        'poster_path':'/poster.jpg', 'backdrop_path':'/banner.jpg', 'episode_path':'/still.jpg'})
    downloads = []
    def download(remote, destination, size):
        downloads.append((remote, destination.name, size))
        return True
    monkeypatch.setattr(catalog, 'download_image', download)
    result = catalog.enrich('Arrow S03E02', 'abc', tmp_path)
    assert result['episode_cached'] and result['poster_cached']
    assert ('/still.jpg', 'abc-episode.jpg', 'w300') in downloads
    assert ('/poster.jpg', 'abc.jpg', 'w500') in downloads


def test_image_url_validation(tmp_path):
    for path in ['https://evil.example/a.jpg', '/../abc.jpg', '/abc.svg', None]:
        assert catalog.download_image(path, tmp_path / 'poster.jpg', 'w500') is False


def test_danish_details_and_english_fallback(monkeypatch):
    monkeypatch.setenv('TMDB_READ_ACCESS_TOKEN', 'test-token')
    requests = []
    def handler(request):
        requests.append(request)
        assert request.headers['Authorization'] == 'Bearer test-token'
        if request.url.path.endswith('/search/movie'):
            return httpx.Response(200, json={'results': [{'id': 1, 'title': 'The Matrix', 'release_date': '1999-01-01'}]})
        return httpx.Response(200, json={'title': 'The Matrix', 'overview': 'English overview' if request.url.params['language'] == 'en-US' else '', 'genres': []})
    original = httpx.Client
    monkeypatch.setattr(catalog.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = catalog.lookup('The.Matrix.1999.1080p')
    assert result['overview'] == 'English overview'
    assert requests[0].url.params['primary_release_year'] == '1999'


def test_index_preserves_video_metadata(monkeypatch, tmp_path):
    import json
    import sqlite3
    from app import main
    def database():
        return sqlite3.connect(tmp_path / 'test.db')
    with database() as conn:
        conn.execute('CREATE TABLE movies(id TEXT, title TEXT, path TEXT, metadata TEXT, created REAL)')
    monkeypatch.setattr(main, 'db', database)
    monkeypatch.setattr(main, 'DATA', tmp_path)
    monkeypatch.setattr(main, 'probe', lambda path: {'duration': 120, 'video': 'hevc', 'height': 2160})
    monkeypatch.setattr(main.subprocess, 'run', lambda *args, **kwargs: None)
    monkeypatch.setattr(catalog, 'enrich', lambda *args: {'status': 'matched', 'title': 'Correct title', 'overview': 'Description'})
    main.index_movie(tmp_path / 'movie.mkv', 'Original filename', 'abc', True)
    with database() as conn:
        title, metadata = conn.execute('SELECT title,metadata FROM movies').fetchone()
    assert title == 'Correct title'
    meta = json.loads(metadata)
    assert meta['height'] == 2160 and meta['video'] == 'hevc'
    assert meta['original_title'] == 'Original filename'
    assert meta['catalog']['overview'] == 'Description'
