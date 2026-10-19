import json
import httpx

from app import catalog, main, series_metadata
from test_series import client


def test_batch_fetches_series_and_whole_season_once_with_shared_language_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(catalog, 'credential', lambda: ('token', 'settings'))
    def handler(request):
        path = request.url.path
        language = request.url.params['language']
        calls.append((path, language))
        assert '/episode/' not in path and '/search/' not in path
        if path.endswith('/season/1'):
            return httpx.Response(200,json={'episodes':[
                {'episode_number':n,'name':f'Episode {n}',
                 'overview':f'Own plot {n}' if language=='en-US' else '',
                 'still_path':f'/episode{n}.jpg'} for n in (1,2)]})
        return httpx.Response(200,json={'id':42,'name':'Show','overview':'Series plot','first_air_date':'2014-01-01'})
    original = httpx.Client
    monkeypatch.setattr(catalog.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler),**kwargs))
    with catalog.lookup_batch():
        first = catalog.lookup('Show S01E01',tmdb_id=42)
        second = catalog.lookup('Show S01E02',tmdb_id=42)
        missing = catalog.lookup('Show S01E03',tmdb_id=42)
    assert first['overview']=='Own plot 1' and first['episode_path']=='/episode1.jpg'
    assert second['overview']=='Own plot 2' and second['episode_path']=='/episode2.jpg'
    assert missing['episode_status']=='missing' and missing['overview']==''
    assert calls==[('/3/tv/42','da-DK'),('/3/tv/42/season/1','da-DK'),('/3/tv/42/season/1','en-US')]


def test_batch_worker_drains_multiple_episodes(client,monkeypatch):
    monkeypatch.setattr(catalog,'enrich',fake_enrich([]))
    add_episode('b'*32,'Show S01E03')
    add_episode('c'*32,'Show S01E04')
    client.post('/api/movies/'+'a'*32+'/metadata/refresh',json={'tmdb_id':42})
    series_metadata.process_batch(main)
    assert not series_metadata.process_one(main)
    assert main.movie('b'*32)[1]['catalog']['overview']=='Plot 1/3'
    assert main.movie('c'*32)[1]['catalog']['overview']=='Plot 1/4'


def add_episode(mid, title, info=None):
    with main.db() as conn:
        conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', (mid, title, '/'+mid+'.mkv',
            json.dumps({'original_title': title, 'duration': 321, 'video': 'hevc',
                        'catalog': info or {**catalog.identify(title), 'status': 'unmatched'}}), 1))


def fake_enrich(calls):
    def enrich(title, mid, destination, tmdb_id=None):
        info = catalog.identify(title)
        calls.append((mid, tmdb_id, info['season'], info['episode']))
        for suffix in ('', '-backdrop', '-episode'):
            (destination/'posters'/f'{mid}{suffix}.jpg').write_bytes(mid.encode())
        return {**info, 'status': 'matched', 'tmdb_id': tmdb_id,
                'series_title': 'Correct Show', 'series_year': '2014',
                'episode_title': f"Episode {info['episode']}",
                'overview': f"Plot {info['season']}/{info['episode']}",
                'poster_cached': True, 'backdrop_cached': True, 'episode_cached': True}
    return enrich


def test_selection_applies_to_unmatched_episodes_across_seasons(client, monkeypatch):
    calls = []
    monkeypatch.setattr(catalog, 'enrich', fake_enrich(calls))
    add_episode('b'*32, 'Show S01E03')
    add_episode('c'*32, 'Show S02E01')
    add_episode('d'*32, 'Show Book S01E03')
    add_episode('e'*32, 'Show 2024 S01E03')
    add_episode('f'*32, 'Show S01E04', {**catalog.identify('Show S01E04'), 'manual': True})
    (main.DATA/'posters'/('b'*32+'-episode.jpg')).write_bytes(b'wrong old episode')
    response = client.post('/api/movies/'+'a'*32+'/metadata/refresh', json={'tmdb_id': 42})
    assert response.status_code == 200, response.text
    assert response.json()['series_updated'] == 2
    for mid, season, episode in [('b'*32, 1, 3), ('c'*32, 2, 1)]:
        row, meta = main.movie(mid)
        info = meta['catalog']
        assert info['tmdb_id'] == info['selected_tmdb_id'] == 42
        assert (info['season'], info['episode']) == (season, episode)
        assert info['series_title'] == 'Correct Show'
        assert info['overview'] == '' and info['series_refresh_pending'] == 42
        assert meta['duration'] == 321 and row['path'] == '/'+mid+'.mkv'
        assert (main.DATA/'posters'/f'{mid}.jpg').read_bytes() == b'a'*32
        assert not (main.DATA/'posters'/f'{mid}-episode.jpg').exists()
    for mid in ('d'*32, 'e'*32, 'f'*32):
        assert 'selected_tmdb_id' not in main.movie(mid)[1]['catalog']
    assert series_metadata.process_one(main)
    assert series_metadata.process_one(main)
    assert not series_metadata.process_one(main)
    assert calls == [('a'*32, 42, 1, 2), ('b'*32, 42, 1, 3), ('c'*32, 42, 2, 1)]
    for mid, plot in [('b'*32, 'Plot 1/3'), ('c'*32, 'Plot 2/1')]:
        info = main.movie(mid)[1]['catalog']
        assert info['overview'] == plot
        assert 'series_refresh_pending' not in info
        assert (main.DATA/'posters'/f'{mid}-episode.jpg').read_bytes() == mid.encode()
    assert series_metadata.selected_id(main.db, 'Show S03E05') == 42
    assert series_metadata.selected_id(main.db, 'Show 2024 S03E05') is None
    item = next(m for m in client.get('/api/movies').json() if m['id'] == 'a'*32)
    assert item['position'] == 32 and item['favorite']


def test_new_episode_reuses_series_choice_without_search(client, monkeypatch):
    calls = []
    monkeypatch.setattr(catalog, 'enrich', fake_enrich(calls))
    client.post('/api/movies/'+'a'*32+'/metadata/refresh', json={'tmdb_id': 42})
    monkeypatch.setattr(main, 'probe', lambda path: {'duration': 120})
    monkeypatch.setattr(main.subprocess, 'run', lambda *args, **kwargs: None)
    result = client.put('/api/upload', params={'filename': 'Show.S03E07.mkv'}, content=b'video')
    assert result.status_code == 200, result.text
    mid = result.json()['id']
    assert calls[-1] == (mid, 42, 3, 7)
    assert main.movie(mid)[1]['catalog']['selected_tmdb_id'] == 42


def test_failed_episode_lookup_retains_shared_identity(client, monkeypatch):
    monkeypatch.setattr(catalog, 'enrich', fake_enrich([]))
    add_episode('b'*32, 'Show S00E01')
    client.post('/api/movies/'+'a'*32+'/metadata/refresh', json={'tmdb_id': 42})
    monkeypatch.setattr(catalog, 'enrich', lambda *args, **kwargs: {'status': 'error'})
    assert series_metadata.process_one(main)
    info = main.movie('b'*32)[1]['catalog']
    assert info['tmdb_id'] == 42 and info['selected_tmdb_id'] == 42
    assert info['season'] == 0 and info['episode'] == 1
    assert 'series_refresh_pending' not in info
    assert not series_metadata.process_one(main)


def test_failed_series_selection_does_not_spread(client, monkeypatch):
    add_episode('b'*32, 'Show S01E03')
    monkeypatch.setattr(catalog, 'enrich', lambda *args, **kwargs: {'status': 'error'})
    result = client.post('/api/movies/'+'a'*32+'/metadata/refresh', json={'tmdb_id': 42})
    assert not result.json()['ok']
    assert 'selected_tmdb_id' not in main.movie('b'*32)[1]['catalog']
    assert series_metadata.selected_id(main.db, 'Show S01E03') is None
