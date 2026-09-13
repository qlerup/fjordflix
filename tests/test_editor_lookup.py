import json
from app import main
from test_series import client


def test_editor_uses_unsaved_movie_title_and_year_without_losing_failed_edits(client, monkeypatch):
    mid = 'a' * 32
    client.put(f'/api/movies/{mid}/metadata', json={'title':'Saved', 'media_type':'movie', 'overview':'Keep me'})
    queries = []
    def enrich(title, *args, **kwargs):
        queries.append(title)
        return {'status':'ambiguous', 'candidates':[{'id':42,'title':'Champ','year':'2022'}]}
    monkeypatch.setattr(main.catalog, 'enrich', enrich)
    result = client.post(f'/api/movies/{mid}/metadata/refresh', json={'draft':{
        'title':'Champ', 'media_type':'movie', 'release_date':'2022-01-01'}})
    assert result.status_code == 200
    assert result.json()['candidates'][0]['id'] == 42
    assert queries == ['Champ 2022']
    row, meta = main.movie(mid)
    assert row['title'] == 'Saved'
    assert meta['catalog']['overview'] == 'Keep me'
    assert meta['catalog']['manual']


def test_editor_series_draft_and_manual_match_keep_playback_data(client, monkeypatch):
    mid = 'a' * 32
    def enrich(title, ident, path, tmdb_id=None):
        assert title == 'The Flash 2014 S02E03'
        assert tmdb_id == 42
        return {'status':'matched', 'title':'The Flash', 'media_type':'tv', 'season':2,'episode':3}
    monkeypatch.setattr(main.catalog, 'enrich', enrich)
    result = client.post(f'/api/movies/{mid}/metadata/refresh', json={'tmdb_id':42,'draft':{
        'title':'Wrong filename', 'media_type':'tv', 'series_title':'The Flash', 'series_year':'2014','season':2,'episode':3}})
    assert result.json()['ok']
    row, meta = main.movie(mid)
    assert row['path'] == '/video.mkv'
    assert meta['duration'] == 100
    assert meta['catalog']['episode'] == 3
    with main.db() as conn:
        assert conn.execute('SELECT position FROM progress WHERE movie_id=?',(mid,)).fetchone()[0] == 32
