import json
import shutil
import subprocess
import time

import pytest

from app import main
from test_series import client


def start(client, relative):
    return client.post('/api/uploads', json={'filename':relative.split('/')[-1], 'relative_path':relative, 'size':3})


def finish(client, monkeypatch, relative):
    calls = []
    def index(path, title, mid, enrich):
        calls.append((path, title, enrich))
        assert path.read_bytes() == b'new'
        with main.db() as conn:
            conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', (mid, title, str(path), json.dumps({}), 0))
    monkeypatch.setattr(main, 'index_movie', index)
    response = start(client, relative)
    assert response.status_code == 200, response.text
    uid = response.json()['id']
    assert client.put(f'/api/uploads/{uid}?offset=0', content=b'new').status_code == 200
    assert client.post(f'/api/uploads/{uid}/complete').status_code == 200
    for _ in range(200):
        state = client.get(f'/api/uploads/{uid}').json()
        if state['status'] not in ('uploading', 'processing'):
            break
        time.sleep(.01)
    assert state['status'] == 'done', state
    assert calls[0][2] is True  # Existing metadata/thumbnail import flow.
    return state, calls[0]


def test_nested_folders_preserve_names_and_supply_series_context(client, monkeypatch):
    state, (path, title, _) = finish(client, monkeypatch, 'The Show/Season 2/E01.mkv')
    assert path == main.MEDIA / 'The Show/Season 2/E01.mkv'
    assert main.catalog.identify(title)['season'] == 2
    assert main.catalog.identify(title)['series_title'] == 'The Show'
    assert state['stored_path'] == 'The Show/Season 2/E01.mkv'
    # A repeated complete call does not index/upload it again.
    assert client.post(f"/api/uploads/{state['id']}/complete").json()['status'] == 'done'


def test_existing_files_are_preserved_and_names_in_separate_folders_stay_distinct(client, monkeypatch):
    old = main.MEDIA / 'Movie/Film.mp4'
    old.parent.mkdir()
    old.write_bytes(b'keep')
    state, (path, _, _) = finish(client, monkeypatch, 'Movie/Film.mp4')
    assert path != old and path.parent == old.parent
    assert old.read_bytes() == b'keep'
    _, (other, _, _) = finish(client, monkeypatch, 'Other Movie/Film.mp4')
    assert other == main.MEDIA / 'Other Movie/Film.mp4'


@pytest.mark.parametrize('relative', ['../Film.mp4', '/Film.mp4', 'A/../Film.mp4',
    'A//Film.mp4', '.uploads/Film.mp4', 'A\\B/Film.mp4', 'C:/Film.mp4', 'A/\x00Film.mp4'])
def test_unsafe_folder_paths_are_rejected_before_creating_a_session(client, relative):
    assert start(client, relative).status_code == 400
    assert not list(main.chunk_uploads.root.glob('*.json'))


def test_expired_unpublished_upload_never_deletes_an_existing_file(client):
    old = main.MEDIA / 'Movie/Film.mp4'
    old.parent.mkdir()
    old.write_bytes(b'keep')
    uid = start(client, 'Movie/Film.mp4').json()['id']
    service = main.chunk_uploads
    state = service.read(uid, 'owner')
    state['touch'] = 0
    service.save(state)
    service.cleanup()
    assert old.read_bytes() == b'keep'
    assert not (service.root / (uid + '.part')).exists()


def test_processing_failure_removes_only_this_upload(client, monkeypatch):
    old = main.MEDIA / 'Movie/Film.mp4'
    old.parent.mkdir()
    old.write_bytes(b'keep')
    uid = start(client, 'Movie/Film.mp4').json()['id']
    service = main.chunk_uploads
    service.chunk(uid, 'owner', 0, b'new')
    def fail(*args):
        raise ValueError('invalid fixture video')
    monkeypatch.setattr(main, 'index_movie', fail)
    service.finish(service.read(uid, 'owner'))
    state = service.read(uid, 'owner')
    assert state['status'] == 'error'
    assert not (main.MEDIA / state['stored_path']).exists()
    assert old.read_bytes() == b'keep'


def test_expired_session_cannot_delete_a_later_replacement(client, monkeypatch):
    state, (path, _, _) = finish(client, monkeypatch, 'Movie/Film.mp4')
    with main.db() as conn:
        conn.execute('DELETE FROM movies WHERE id=?', (state['id'],))
    replacement = path.with_suffix('.replacement')
    replacement.write_bytes(b'new owner')
    replacement.replace(path)
    state['touch'] = 0
    main.chunk_uploads.save(state)
    main.chunk_uploads.cleanup()
    assert path.read_bytes() == b'new owner'


def test_non_hardlink_filesystems_use_the_same_complete_video(client, monkeypatch):
    import errno
    def unsupported(*args):
        raise OSError(errno.EOPNOTSUPP, 'no hard links')
    monkeypatch.setattr(main.uploads.os, 'link', unsupported)
    _, (path, _, _) = finish(client, monkeypatch, 'Movie/Film.mp4')
    assert path.read_bytes() == b'new'


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='Requires the production media tools')
def test_folder_upload_runs_real_probe_index_and_series_metadata(client, monkeypatch, tmp_path):
    fixture = tmp_path / 'fixture.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=size=64x64:rate=10',
                    '-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',str(fixture)], check=True)
    content = fixture.read_bytes()
    monkeypatch.setattr(main.catalog, 'credential', lambda: ('','none'))
    result = client.post('/api/uploads', json={'filename':'E01.mp4',
        'relative_path':'The Show/Season 2/E01.mp4','size':len(content)})
    uid = result.json()['id']
    assert client.put(f'/api/uploads/{uid}?offset=0',content=content).status_code == 200
    assert client.post(f'/api/uploads/{uid}/complete').status_code == 200
    for _ in range(500):
        state = client.get(f'/api/uploads/{uid}').json()
        if state['status'] not in ('processing','uploading'):
            break
        time.sleep(.02)
    assert state['status'] == 'done', state
    item = main.movie(uid)[1]
    assert item['video'] == 'h264'
    assert item['catalog']['series_title'] == 'The Show'
    assert item['catalog']['season'] == 2
    assert (main.MEDIA / 'The Show/Season 2/E01.mp4').read_bytes() == content
    assert (main.DATA / 'posters' / f'{uid}-frame.jpg').exists()
