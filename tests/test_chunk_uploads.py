import hashlib
import json
import threading
import time

from app import main
from app.uploads import CHUNK_SIZE, Uploads
from test_series import client


def start(client, size):
    result = client.post('/api/uploads', json={'filename': 'Show.2014.S01E02.mp4', 'size': size})
    assert result.status_code == 200
    return result.json()['id']


def test_chunk_replay_order_limits_and_exact_assembly(client, monkeypatch):
    content = bytes(range(256)) * (CHUNK_SIZE // 256) + b'last bytes'
    uid = start(client, len(content))
    url = '/api/uploads/' + uid
    assert client.post(url + '/complete').status_code == 409
    assert client.put(url + f'?offset={CHUNK_SIZE}', content=content[CHUNK_SIZE:]).status_code == 409
    assert client.put(url + '?offset=0', content=b'x' * (CHUNK_SIZE + 1)).status_code == 413
    assert client.put(url + '?offset=0', content=b'too short').status_code == 400
    assert client.put(url + '?offset=0', content=content[:CHUNK_SIZE]).status_code == 200
    assert client.put(url + '?offset=0', content=content[:CHUNK_SIZE]).json()['offset'] == CHUNK_SIZE
    assert client.put(url + '?offset=0', content=b'x' * CHUNK_SIZE).status_code == 409
    # Restart the upload service and recover its persisted offset.
    recovered = Uploads(main)
    assert recovered.status(uid, 'owner')['offset'] == CHUNK_SIZE
    assert client.put(url + f'?offset={CHUNK_SIZE}', content=content[CHUNK_SIZE:]).status_code == 200
    entered, release = threading.Event(), threading.Event()
    indexed = []
    def index(path, title, mid, enrich):
        indexed.append(mid)
        assert hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(content).digest()
        entered.set()
        assert release.wait(5)
        with main.db() as conn:
            conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', (mid, title, str(path), json.dumps({}), 0))
    monkeypatch.setattr(main, 'index_movie', index)
    try:
        assert client.post(url + '/complete').json()['status'] == 'processing'
        assert entered.wait(2)
        assert client.post(url + '/complete').json()['status'] == 'processing'
    finally:
        release.set()
    for _ in range(100):
        state = client.get(url).json()
        if state['status'] != 'processing':
            break
        time.sleep(.02)
    assert state['status'] == 'done'
    assert client.post(url + '/complete').json()['status'] == 'done'
    assert indexed == [uid]


def test_upload_authorization_validation_and_disk_space(client, monkeypatch):
    uid = start(client, 1)
    url = '/api/uploads/' + uid
    assert client.post('/api/uploads', json={'filename': 'bad.txt', 'size': 2}).status_code == 400
    assert client.post('/api/uploads', json={'filename': 'empty.mp4', 'size': 0}).status_code == 422
    assert client.post('/api/uploads', json={'filename': 'huge.mp4', 'size': 101 * 1024**3}).status_code == 422
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'other', 'admin': True})
    assert client.get(url).status_code == 404
    assert client.put(url + '?offset=0', content=b'x').status_code == 404
    assert client.post(url + '/complete').status_code == 404
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'viewer', 'admin': False})
    assert client.post('/api/uploads', json={'filename': 'x.mp4', 'size': 1}).status_code == 403
    assert client.put(url + '?offset=0', content=b'x').status_code == 403
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'id': 'owner', 'admin': True})
    from types import SimpleNamespace
    monkeypatch.setattr(main.shutil, 'disk_usage', lambda _: SimpleNamespace(free=0))
    assert client.put(url + '?offset=0', content=b'x').status_code == 507
    assert client.get(url).json()['offset'] == 0


def test_expired_upload_cleanup_and_interrupted_processing(client):
    uid = start(client, 1)
    service = main.chunk_uploads
    service.chunk(uid, 'owner', 0, b'x')
    state = service.status(uid, 'owner')
    state.update(status='processing', touch=time.time())
    service.save(state)
    service.cleanup(restarting=True)
    assert service.status(uid, 'owner')['status'] == 'uploading'
    state.update(status='uploading', touch=0)
    service.save(state)
    service.cleanup()
    assert client.get('/api/uploads/' + uid).status_code == 404
    assert not (service.root / (uid + '.part')).exists()


def test_processing_error_releases_file(client, monkeypatch):
    from fastapi import HTTPException
    uid = start(client, 1)
    main.chunk_uploads.chunk(uid, 'owner', 0, b'x')
    state = main.chunk_uploads.status(uid, 'owner')
    def fail(*args):
        raise HTTPException(400, 'Invalid video')
    monkeypatch.setattr(main, 'index_movie', fail)
    main.chunk_uploads.finish(state)
    assert main.chunk_uploads.status(uid, 'owner')['status'] == 'error'
    assert not (main.MEDIA / (uid + '.mp4')).exists()
