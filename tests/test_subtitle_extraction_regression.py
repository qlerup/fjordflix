import json
import pytest
from app import main, tracks
from test_series import client
from test_tracks import mkv
from test_subtitle_providers import providers, configure, MID


def test_progressive_subtitles_visible_before_extraction_finishes(client, mkv, monkeypatch):
    import threading
    import time
    from pathlib import Path
    from types import SimpleNamespace
    mid, _, _ = mkv
    wrote = threading.Event()
    finish = threading.Event()
    calls = []
    first = 'WEBVTT\n\n00:01.000 --> 00:04.000\nHej!\n\n'
    second = '00:05.000 --> 00:07.000\nSenere.\n\n'
    def slow_extract(command, **kwargs):
        calls.append(command)
        target = Path(command[-1])
        target.write_text(first + '00:05.', encoding='utf-8')
        wrote.set()
        assert finish.wait(5)
        target.write_text(first + second, encoding='utf-8')
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(tracks.subprocess, 'run', slow_extract)
    endpoint = f'/api/movies/{mid}/subtitles/4.vtt?progressive=true'
    try:
        response = client.get(endpoint)
        assert response.status_code == 200
        assert wrote.wait(2)
        response = client.get(endpoint)
        assert response.headers['x-subtitle-complete'] == '0'
        assert response.text == first
        assert len(calls) == 1, 'Polling must reuse the same extraction'
    finally:
        finish.set()
    for _ in range(100):
        response = client.get(endpoint)
        if response.headers['x-subtitle-complete'] == '1': break
        time.sleep(0.01)
    assert response.text == first + second
    assert response.headers['x-subtitle-complete'] == '1'
    assert len(calls) == 1
    assert client.get(endpoint.split('?')[0]).text.replace('\r\n', '\n') == first + second


@pytest.mark.parametrize('matched_id', [42, None, 999])
def test_subdl_title_year_fallback_preserves_identity(client, providers, monkeypatch, matched_id):
    manager, _, data = providers
    configure(client)
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=?', (json.dumps({'catalog':{
            'tmdb_id':42, 'title':'Scary Movie', 'release_date':'2026-06-03'}}),))
    calls = []
    def api(path, params):
        calls.append(params)
        if 'tmdb_id' in params:
            return {'results':[{'tmdb_id':42}], 'subtitles':[]}
        return {**data, 'results':[{'tmdb_id':matched_id, 'name':'Scary Movie', 'year':2026, 'type':'movie'}]}
    monkeypatch.setattr(manager.providers['subdl'], 'request_api', api)
    result = manager.search(MID, 'da')
    assert bool(result['results']) == (matched_id != 999)
    assert len(calls) == 2 and calls[1]['film_name'] == 'Scary Movie' and calls[1]['year'] == '2026'
    assert 'tmdb_id' not in calls[1]


def test_real_progressive_extraction_keeps_text_and_timestamps(client, mkv):
    import time
    mid, _, _ = mkv
    for _ in range(200):
        response = client.get(f'/api/movies/{mid}/subtitles/4.vtt?progressive=true')
        assert response.status_code == 200, response.text
        if response.headers['x-subtitle-complete'] == '1': break
        time.sleep(0.01)
    assert response.headers['x-subtitle-complete'] == '1'
    assert 'Hej med dig! Æ, ø og å.' in response.text
    assert '00:01.023 --> 00:04.023' in response.text or '00:01.000 --> 00:04.000' in response.text


def test_failed_background_extraction_returns_error_instead_of_polling_forever(client, mkv, monkeypatch):
    import time
    from types import SimpleNamespace
    mid, _, _ = mkv
    monkeypatch.setattr(tracks.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=1, stderr=b'invalid data'))
    for _ in range(100):
        response = client.get(f'/api/movies/{mid}/subtitles/4.vtt?progressive=true')
        if response.status_code == 503: break
        time.sleep(0.01)
    assert response.status_code == 503 and 'FFmpeg' in response.json()['detail']
    assert not list((main.DATA / 'subtitles').glob('*.vtt'))


def test_subdl_subrip_format_and_iso_language(client, providers):
    manager, _, data = providers
    configure(client)
    data['subtitles'][0]['unpack_files'] = [{'language':'dan', 'format':'SubRip',
                                          'url':'/subtitle/123/file1'}]
    assert len(manager.search(MID, 'da')['results']) == 1
