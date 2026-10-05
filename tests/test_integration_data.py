import json
import sqlite3
import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import integration_data, active_streams


def fixture(tmp_path, monkeypatch):
    monkeypatch.setenv('FJORDHUB_API_KEY', 'internal-secret')
    monkeypatch.setenv('FJORDHUB_APP_ID', 'fjordflix')
    (tmp_path / 'posters').mkdir()
    def db():
        conn = sqlite3.connect(tmp_path / 'test.db')
        conn.row_factory = sqlite3.Row
        return conn
    with db() as conn:
        conn.execute('CREATE TABLE movies(id TEXT,title TEXT,metadata TEXT,path TEXT)')
        for i in range(140):
            mid = f'{i:032x}'
            conn.execute('INSERT INTO movies VALUES(?,?,?,?)', (mid, f'Title {i}',
                json.dumps({'catalog': {'overview': 'Description æøå', 'rating': 8, 'secret': 'hidden'}, 'secret': 'hidden'}), '/private/media'))
            if i >= 130:
                (tmp_path / 'posters' / f'{mid}.jpg').write_bytes(b'jpeg')
    main = SimpleNamespace(app=FastAPI(), db=db, DATA=tmp_path)
    integration_data.register(main)
    return TestClient(main.app)


def test_auth_sample_and_posters(tmp_path, monkeypatch):
    client = fixture(tmp_path, monkeypatch)
    headers = {'X-Hub-Key': 'internal-secret'}
    endpoint = '/api/hub/integration-data'
    assert client.get(endpoint).status_code == 401
    assert client.get(endpoint, headers={'X-Hub-Key': 'wrong'}).status_code == 401
    response = client.get(endpoint, headers=headers)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    data = response.json()
    assert data['library_count'] == 140
    assert len(data['items']) == 10
    assert len({item['id'] for item in data['items']}) == 10
    assert '/private' not in response.text and 'hidden' not in response.text
    mid = data['items'][0]['id']
    assert client.get(endpoint + '/posters/' + mid).status_code == 401
    poster = client.get(endpoint + '/posters/' + mid, headers=headers)
    assert poster.content == b'jpeg' and poster.headers['content-type'] == 'image/jpeg'
    assert client.get(endpoint + '/posters/invalid', headers=headers).status_code == 404
    assert client.get(endpoint + '/posters/' + '0'*32, headers=headers).status_code == 404
    monkeypatch.delenv('FJORDHUB_API_KEY')
    assert client.get(endpoint, headers=headers).status_code == 401


def test_live_streams_are_projected_and_expire(tmp_path, monkeypatch):
    client = fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(active_streams, 'LIVE', {
        'live': {'id': 'live', 'movie_id': f'{139:032x}', 'title': 'Film', 'user': 'Anna',
                 'state': 'playing', 'position': 5, 'duration': 100, 'touch': time.time(),
                 '_ticket': 'secret-ticket', 'session': 'secret-session', 'user_id': 'private-id'},
        'stale': {'touch': time.time()-200},
    })
    response = client.get('/api/hub/integration-data', headers={'X-Hub-Key': 'internal-secret'})
    assert len(response.json()['streams']) == 1
    assert response.json()['streams'][0]['user'] == 'Anna'
    assert not any(value in response.text for value in ('secret-ticket', 'secret-session', 'private-id'))
