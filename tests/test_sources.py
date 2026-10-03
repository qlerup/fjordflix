import json
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import main, sources


@pytest.fixture
def mounted(monkeypatch, tmp_path):
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'posters').mkdir()
    (data / 'media').mkdir()
    root = tmp_path / 'storage'
    root.mkdir()
    (root / 'Film').mkdir()
    (root / 'Serier').mkdir()
    def db():
        conn = sqlite3.connect(data / 'test.db')
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        return conn
    monkeypatch.setattr(main, 'db', db)
    monkeypatch.setattr(main, 'DATA', data)
    monkeypatch.setattr(main, 'MEDIA', data / 'media')
    monkeypatch.setenv('LIBRARY_ROOTS', json.dumps([str(root)]))
    monkeypatch.setattr(main.media, 'config', lambda: ('', ''))
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': True, 'id': 'owner'})
    with db() as conn:
        conn.executescript('''
            CREATE TABLE movies(id TEXT PRIMARY KEY,title TEXT,path TEXT,metadata TEXT,created REAL);
            CREATE TABLE catalog_settings(name TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE progress(user_id TEXT,movie_id TEXT,position REAL,favorite INTEGER);
            CREATE TABLE media_grants(token TEXT,movie TEXT);
        ''')
    sources.Sources(FastAPI(), main)  # same schema as startup, isolated database
    monkeypatch.setattr(main, 'probe', lambda p: {'duration': 90, 'format': 'mp4', 'size': p.stat().st_size})
    monkeypatch.setattr(main.subprocess, 'run', lambda *a, **kw: None)
    monkeypatch.setattr(main.catalog, 'enrich', lambda *a: {'status': 'disabled', 'media_type': 'movie'})
    monkeypatch.setattr(main.library_sources, 'status', {'running': False, 'added': 0, 'updated': 0, 'errors': []})
    monkeypatch.setattr(main.library_sources, 'rescan', threading.Event())
    return TestClient(main.app), root


def test_write_guide_requires_admin_and_is_not_a_mutation(mounted, monkeypatch):
    client, root = mounted
    monkeypatch.setattr(main.hub, 'managed', lambda: True)
    guide = {'source': '/mnt/Film', 'target': '/mnt/Film', 'ctid': '1000', 'commands': 'review only'}
    calls = []
    def call(path, payload, **kwargs):
        calls.append((payload, kwargs['method']))
        return {'storages': [], 'disks': [], 'mounts': [{'path': '/mnt/Film', 'write_guide': guide}], 'errors': []}
    monkeypatch.setattr(main.hub, 'call', call)
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'owner', 'admin': True, 'hub_id': 17})
    assert client.get('/api/admin/library/proxmox').json()['mounts'][0]['write_guide'] == guide
    assert calls == [({'user_id': 17}, 'GET')]
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'viewer', 'admin': False})
    assert client.get('/api/admin/library/proxmox').status_code == 403
    assert len(calls) == 1


def test_pool_connection_requires_confirmation_and_forwards_admin(mounted, monkeypatch):
    client, _ = mounted
    monkeypatch.setattr(main.hub, 'managed', lambda: True)
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id':'owner','admin':True,'hub_id':17})
    calls = []
    def call(path, payload, **kwargs):
        calls.append((path,payload))
        return {'ok':True,'accepted':True,'job':{'state':'queued'}}
    monkeypatch.setattr(main.hub, 'call', call)
    url = '/api/admin/library/proxmox/connect'
    assert client.post(url,json={'pool_id':'a'*20}).status_code == 400
    assert client.post(url,json={'pool_id':'/etc','confirm_restart':True}).status_code == 422
    assert not calls
    result = client.post(url,json={'pool_id':'a'*20,'confirm_restart':True})
    assert result.status_code == 200 and result.json()['job']['state'] == 'queued'
    assert calls == [('/api/hub/apps/fjordflix/library/connect',{'user_id':17,'pool_id':'a'*20,'confirm_restart':True})]
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id':'viewer','admin':False})
    assert client.post(url,json={'pool_id':'a'*20,'confirm_restart':True}).status_code == 403
    assert len(calls) == 1


def scan(reindex_source=None):
    assert main.library_sources.lock.acquire(blocking=False)
    main.library_sources.rescan.clear()
    main.library_sources.status = {'running': True, 'added': 0, 'updated': 0, 'errors': []}
    main.library_sources.scan(reindex_source)
    assert not main.library_sources.status['running']


def test_reindex_repairs_existing_episodes_and_fetches_metadata(mounted, monkeypatch):
    client, root = mounted
    folder = root / 'Serier' / 'Example Show'
    folder.mkdir()
    for name in ['E01.mkv', 'E02.mkv']:
        (folder / name).write_bytes(b'video')
    sid = client.post('/api/admin/library', json={'path': str(root / 'Serier')}).json()['id']
    scan()  # Fixture simulates the old movie-only classification.
    before = client.get('/api/movies').json()
    ids = {item['id'] for item in before}
    with main.db() as conn:
        conn.execute('INSERT INTO progress VALUES (?,?,?,?)', ('owner', before[0]['id'], 42, 1))
    calls = []
    def enrich(title, *args):
        calls.append(title)
        return {**main.catalog.identify(title), 'status': 'disabled'}
    monkeypatch.setattr(main.catalog, 'enrich', enrich)
    scan(sid)
    after = client.get('/api/movies').json()
    assert set(calls) == {'Example Show E01', 'Example Show E02'}
    assert {item['id'] for item in after} == ids
    assert {item['catalog']['episode'] for item in after} == {1, 2}
    assert len({item['series_key'] for item in after}) == 1
    assert next(item for item in after if item['id'] == before[0]['id'])['position'] == 42
    assert main.library_sources.status['updated'] == 2
    assert main.library_sources.status['errors'] == []
    with main.db() as conn:
        row = conn.execute('SELECT metadata FROM movies WHERE id=?', (before[0]['id'],)).fetchone()
        meta = json.loads(row['metadata'])
        meta['catalog']['manual'] = True
        conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), before[0]['id']))
    calls.clear()
    scan(sid)
    assert len(calls) == 1  # Explicit manual edits are not looked up again.


def test_reindex_endpoint_scope_and_authorization(mounted, monkeypatch):
    client, root = mounted
    sid = client.post('/api/admin/library', json={'path': str(root / 'Film')}).json()['id']
    calls = []
    monkeypatch.setattr(main.library_sources, 'start', lambda source: calls.append(source) or True)
    assert client.post(f'/api/admin/library/{sid}/reindex').status_code == 202
    assert calls == [sid]
    assert client.post('/api/admin/library/missing/reindex').status_code == 404
    monkeypatch.setattr(main.library_sources, 'start', lambda source: False)
    assert client.post(f'/api/admin/library/{sid}/reindex').status_code == 409
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': False, 'id': 'viewer'})
    assert client.post(f'/api/admin/library/{sid}/reindex').status_code == 403


def test_episode_only_files_group_as_series(mounted, monkeypatch):
    client, root = mounted
    monkeypatch.setattr(main.catalog, 'enrich', lambda title, *args: main.catalog.identify(title))
    folder = root / 'Serier' / 'Example Show'
    folder.mkdir()
    for filename in ['E01.mkv', 'E02.mkv']:
        (folder / filename).write_bytes(b'episode')
    assert client.post('/api/admin/library', json={'path': str(root / 'Serier')}).status_code == 201
    scan()
    items = client.get('/api/movies').json()
    assert len(items) == 2
    assert {item['catalog']['episode'] for item in items} == {1, 2}
    assert all(item['catalog']['season'] == 1 for item in items)
    assert all(item['catalog']['series_title'] == 'Example Show' for item in items)
    assert len({item['series_key'] for item in items}) == 1


def test_browse_multiple_sources_stream_and_remove_without_copy(mounted):
    client, root = mounted
    video = root / 'Film' / 'Film.mp4'
    episode = root / 'Serier' / 'Show S01E01.mkv'
    video.write_bytes(b'original movie bytes')
    episode.write_bytes(b'episode bytes')
    assert client.get('/api/admin/library/browse').json()['directories'][0]['path'] == str(root)
    assert len(client.get('/api/admin/library/browse', params={'path': str(root)}).json()['directories']) == 2
    added = [client.post('/api/admin/library', json={'path': str(root / name)}).json() for name in ('Film', 'Serier')]
    scan()
    assert main.library_sources.status['added'] == 2
    items = client.get('/api/movies').json()
    assert len(items) == 2
    assert not list(main.MEDIA.iterdir())
    movie = next(m for m in items if m['title'] == 'Film')
    response = client.get(f'/api/movies/{movie["id"]}/file', headers={'Range': 'bytes=0-7'})
    assert response.status_code == 206 and response.content == b'original'
    assert client.request('DELETE', f'/api/movies/{movie["id"]}', json={'ids': [movie['id']]}).status_code == 409
    scan()
    assert main.library_sources.status['added'] == 0
    assert client.delete('/api/admin/library/' + added[0]['id']).status_code == 200
    assert len(client.get('/api/movies').json()) == 1
    assert video.read_bytes() == b'original movie bytes'
    assert episode.read_bytes() == b'episode bytes'
    with main.db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM library_files').fetchone()[0] == 1


def test_scope_auth_overlap_and_scan_serialization(mounted, monkeypatch):
    client, root = mounted
    assert client.post('/api/admin/library', json={'path': str(root / 'Film')}).status_code == 201
    for path in (root / 'Film', root):
        assert client.post('/api/admin/library', json={'path': str(path)}).status_code == 409
    for path in (root.parent, root / '..', Path('relative'), root / 'absent'):
        assert client.get('/api/admin/library/browse', params={'path': str(path)}).status_code == 400
    with main.library_sources.lock:
        assert client.post('/api/admin/library/scan').status_code == 409
        sid = client.get('/api/admin/library').json()['sources'][0]['id']
        assert client.delete('/api/admin/library/' + sid).status_code == 409
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': False, 'id': 'viewer'})
    assert client.get('/api/admin/library').status_code == 403
    assert client.get('/api/admin/library/browse').status_code == 403
    assert client.post('/api/admin/library', json={'path': str(root)}).status_code == 403
    assert client.post('/api/admin/library/scan').status_code == 403


def test_updates_preserve_edits_and_missing_drive_preserves_index(mounted):
    client, root = mounted
    video = root / 'Film' / 'Film.mp4'
    video.write_bytes(b'first')
    client.post('/api/admin/library', json={'path': str(root / 'Film')})
    scan()
    item = client.get('/api/movies').json()[0]
    with main.db() as conn:
        metadata = json.loads(conn.execute('SELECT metadata FROM movies').fetchone()[0])
        metadata['catalog'] = {'manual': True, 'title': 'My title'}
        conn.execute('UPDATE movies SET metadata=?', (json.dumps(metadata),))
        conn.execute('INSERT INTO progress VALUES (?,?,?,?)', ('owner', item['id'], 12, 1))
    video.write_bytes(b'changed content')
    scan()
    item = client.get('/api/movies').json()[0]
    assert item['size'] == 15 and item['catalog']['title'] == 'My title'
    assert item['position'] == 12 and item['favorite']
    video.unlink()
    (root / 'Film').rmdir()
    scan()
    assert main.library_sources.status['errors']
    assert len(client.get('/api/movies').json()) == 1
    assert client.get(f'/api/movies/{item["id"]}/file').status_code == 404


def test_symlinks_cannot_escape_mount(mounted):
    client, root = mounted
    outside = root.parent / 'secret'
    outside.mkdir()
    (outside / 'private.mp4').write_bytes(b'private')
    try:
        (root / 'link').symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip('Symlinks require privileges on this Windows host')
    assert client.get('/api/admin/library/browse', params={'path': str(root / 'link')}).status_code == 400
    client.post('/api/admin/library', json={'path': str(root)})
    scan()
    assert not client.get('/api/movies').json()


def test_proxmox_uses_hub_identity_and_checks_local_access(mounted, monkeypatch):
    client, root = mounted
    monkeypatch.setattr(main.hub, 'managed', lambda: True)
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'owner', 'admin': True, 'hub_id': 17})
    monkeypatch.setenv('LIBRARY_HOST_ROOT', '/mnt')
    def call(path, payload, **kwargs):
        assert path == '/api/hub/apps/fjordflix/library' and payload == {'user_id': 17}
        return {'storages': [{'id': 'pool', 'paths': ['/mnt/Film', '/etc', '/mnt/../etc']}],
                'disks': [], 'mounts': [{'path': '/mnt/Film'}], 'errors': []}
    monkeypatch.setattr(main.hub, 'call', call)
    # No /library/server mount exists on this QA host: inventory remains visible,
    # but no path is offered as usable just because it appears in PVE config.
    data = client.get('/api/admin/library/proxmox').json()
    assert data['configured'] and data['storages'][0]['directories'] == []
    assert data['mounts'][0]['local_path'] is None
    monkeypatch.setattr(main.hub, 'managed', lambda: False)
    assert not client.get('/api/admin/library/proxmox').json()['configured']


def test_folder_added_during_scan_is_picked_up_without_waiting(mounted, monkeypatch):
    client, root = mounted
    (root / 'Film' / 'Film.mp4').write_bytes(b'film')
    (root / 'Serier' / 'Show.mkv').write_bytes(b'show')
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    original_index = main.index_movie
    def index(path, *args, **kwargs):
        if path.name == 'Film.mp4':
            entered.set()
            assert release.wait(3)
        result = original_index(path, *args, **kwargs)
        if path.name == 'Show.mkv':
            finished.set()
        return result
    monkeypatch.setattr(main, 'index_movie', index)
    client.post('/api/admin/library', json={'path': str(root / 'Film')})
    assert client.post('/api/admin/library/scan').status_code == 202
    try:
        assert entered.wait(3)
        added = client.post('/api/admin/library', json={'path': str(root / 'Serier')})
        assert added.status_code == 201 and added.json()['queued']
    finally:
        release.set()
    assert finished.wait(3)
    assert main.library_sources.lock.acquire(timeout=3)
    main.library_sources.lock.release()
    assert len(client.get('/api/movies').json()) == 2
