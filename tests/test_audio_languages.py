import json

from app import main
from test_series import client


def test_manual_audio_language_preserves_source_and_can_reset(client):
    mid = 'a' * 32
    with main.db() as conn:
        meta = json.loads(conn.execute('SELECT metadata FROM movies').fetchone()[0])
        meta['tracks'] = {'version': 1, 'audio': [
            {'index': 1, 'codec': 'aac', 'language': 'eng'},
            {'index': 2, 'codec': 'aac', 'language': 'swe'}], 'subtitles': []}
        conn.execute('UPDATE movies SET metadata=?', (json.dumps(meta),))
    edit = {'title': 'CHAMP', 'media_type': 'movie', 'audio_language_overrides': {'1': 'Dansk'}}
    assert client.put(f'/api/movies/{mid}/metadata', json=edit).status_code == 200
    for response in [client.get(f'/api/movies/{mid}/tracks').json(), client.get('/api/movies').json()[0]['tracks']]:
        assert response['audio'][0]['language'] == 'Dansk'
        assert response['audio'][0]['source_language'] == 'eng'
        assert response['audio'][1]['language'] == 'swe'
    with main.db() as conn:
        saved = json.loads(conn.execute('SELECT metadata FROM movies').fetchone()[0])
        assert saved['tracks']['audio'][0]['language'] == 'eng'
        assert 'audio_language_overrides' not in saved['catalog']
    # Older clients and unrelated text edits must preserve the override.
    assert client.put(f'/api/movies/{mid}/metadata', json={'title': 'CHAMP', 'media_type': 'movie'}).status_code == 200
    assert client.get(f'/api/movies/{mid}/tracks').json()['audio'][0]['language'] == 'Dansk'
    for invalid in [{'0': 'Dansk'}, {'1': 'x' * 81}]:
        assert client.put(f'/api/movies/{mid}/metadata', json={**edit, 'audio_language_overrides': invalid}).status_code == 400
    assert client.put(f'/api/movies/{mid}/metadata', json={**edit, 'audio_language_overrides': {}}).status_code == 200
    assert client.get(f'/api/movies/{mid}/tracks').json()['audio'][0]['language'] == 'eng'
    item = client.get('/api/movies').json()[0]
    assert item['position'] == 32 and item['favorite']
