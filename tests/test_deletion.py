import json
from pathlib import Path

from app import main
from test_series import client


def seed():
    with main.db() as conn:
        conn.execute('DELETE FROM movies')
        for key, title in [('a', 'Flash 2014 S01E01'), ('b', 'Flash 2014 S02E02'), ('c', 'Other 2020')]:
            mid = key * 32
            path = main.MEDIA / f'{mid}.mp4'
            path.write_bytes(b'video')
            conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', (mid, title, str(path), json.dumps({'duration': 100}), 0))
            for suffix in ('', '-frame', '-episode', '-backdrop'):
                (main.DATA / 'posters' / f'{mid}{suffix}.jpg').write_bytes(b'image')


def test_delete_episode_and_remaining_series(client):
    seed()
    response = client.delete('/api/movies/' + 'a'*32)  # Explicit selection required.
    assert response.status_code == 422
    response = client.request('DELETE', '/api/movies/' + 'a'*32, json={'ids': ['a'*32]})
    assert response.status_code == 200
    assert not (main.MEDIA / ('a'*32 + '.mp4')).exists()
    assert not list((main.DATA / 'posters').glob('a'*32 + '*'))
    assert len(client.get('/api/movies').json()) == 2
    with main.db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM progress').fetchone()[0] == 0


def test_delete_series_rejects_unrelated_selection(client):
    seed()
    endpoint = '/api/movies/' + 'a'*32
    assert client.request('DELETE', endpoint, json={'ids': ['a'*32, 'c'*32]}).status_code == 409
    assert client.request('DELETE', endpoint, json={'ids': ['a'*32, 'b'*32]}).status_code == 200
    assert [item['id'] for item in client.get('/api/movies').json()] == ['c'*32]
    assert (main.MEDIA / ('c'*32 + '.mp4')).exists()


def test_delete_requires_admin_and_confines_paths(client, monkeypatch):
    seed()
    endpoint = '/api/movies/' + 'a'*32
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'viewer', 'admin': False})
    assert client.request('DELETE', endpoint, json={'ids': ['a'*32]}).status_code == 403
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'owner', 'admin': True})
    outside = main.DATA / 'outside.mp4'
    outside.write_bytes(b'keep')
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=? WHERE id=?', (str(outside), 'a'*32))
    assert client.request('DELETE', endpoint, json={'ids': ['a'*32]}).status_code == 409
    assert outside.read_bytes() == b'keep'


def test_locked_file_rolls_back_staged_files(client, monkeypatch):
    seed()
    rename = Path.rename
    calls = []
    def fail_second(path, target):
        calls.append(path)
        if len(calls) == 2:
            raise PermissionError('locked')
        return rename(path, target)
    monkeypatch.setattr(Path, 'rename', fail_second)
    response = client.request('DELETE', '/api/movies/' + 'a'*32, json={'ids': ['a'*32, 'b'*32]})
    assert response.status_code == 409
    assert len(client.get('/api/movies').json()) == 3
    assert len(list(main.MEDIA.glob('*.mp4'))) == 3
    assert len(list((main.DATA / 'posters').glob('*.jpg'))) == 12
