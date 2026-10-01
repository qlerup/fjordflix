import json
import sqlite3
from pathlib import Path

import pytest

from app.legacy_cleanup import RETIRED, remove_test_movies


@pytest.fixture
def library(tmp_path):
    def db():
        conn = sqlite3.connect(tmp_path / 'library.db')
        conn.row_factory = sqlite3.Row
        return conn
    with db() as conn:
        conn.executescript('''
            CREATE TABLE movies(id TEXT PRIMARY KEY, title TEXT, path TEXT, metadata TEXT);
            CREATE TABLE library_files(movie_id TEXT);
            CREATE TABLE progress(movie_id TEXT);
            CREATE TABLE media_grants(movie TEXT);
        ''')
    (tmp_path / 'media').mkdir()
    (tmp_path / 'posters').mkdir()
    return db, tmp_path, tmp_path / 'media'


def seed(library, title, index=1, **meta_overrides):
    db, data, media = library
    mid = f'{index:032x}'
    path = media / f'{mid}.mp4'
    path.write_bytes(b'legacy sample')
    width, height, duration = RETIRED[title]
    meta = dict(width=width, height=height, duration=duration, video='h264', audio='aac',
                pix_fmt='yuv420p', size=path.stat().st_size, **meta_overrides)
    with db() as conn:
        conn.execute('INSERT INTO movies VALUES (?,?,?,?)', (mid, title, str(path), json.dumps(meta)))
        conn.execute('INSERT INTO progress VALUES (?)', (mid,))
        conn.execute('INSERT INTO media_grants VALUES (?)', (mid,))
    for suffix in ('', '-frame', '-episode', '-backdrop'):
        (data / 'posters' / f'{mid}{suffix}.jpg').write_bytes(b'poster')
    return mid, path


def test_upgrade_removes_all_five_and_artifacts_idempotently(library):
    db, data, _ = library
    for index, title in enumerate(RETIRED, 1):
        mid, _ = seed(library, title, index)
        folder = data / 'subtitles' / 'downloaded'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f'{mid}-1000.srt').write_text('subtitle')
    assert remove_test_movies(*library) == 5
    assert remove_test_movies(*library) == 0
    assert not list((data / 'media').iterdir())
    assert not list((data / 'posters').iterdir())
    assert not list(folder.iterdir())
    with db() as conn:
        for table in ('movies', 'progress', 'media_grants'):
            assert conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 0


@pytest.mark.parametrize('kind', ['upload', 'source', 'linked', 'outside', 'shared', 'replaced', 'wrong_signature', 'malformed'])
def test_preserves_user_media_even_with_sample_title(library, kind):
    db, data, _ = library
    meta = {'original_title': 'Fjordens ro'} if kind == 'upload' else {'library_source': 'x'} if kind == 'source' else {}
    mid, path = seed(library, 'Fjordens ro', **meta)
    with db() as conn:
        if kind == 'linked':
            conn.execute('INSERT INTO library_files VALUES (?)', (mid,))
        if kind == 'outside':
            outside = data / 'outside.mp4'
            path.rename(outside)
            path = outside
            conn.execute('UPDATE movies SET path=?', (str(path),))
        if kind == 'shared':
            conn.execute('INSERT INTO movies SELECT ?, title, path, metadata FROM movies', ('b'*32,))
        if kind == 'replaced':
            path.write_bytes(b'a replacement user video')
        if kind in ('wrong_signature', 'malformed'):
            conn.execute('UPDATE movies SET metadata=?', ('{}' if kind == 'wrong_signature' else 'broken',))
    assert remove_test_movies(*library) == 0
    assert path.exists()
    with db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM movies').fetchone()[0] >= 1


def test_retry_after_partial_cleanup(library, monkeypatch):
    db, data, _ = library
    mid, path = seed(library, 'Fjordens ro')
    unlink = Path.unlink
    with monkeypatch.context() as patch:
        def locked(p, *args, **kwargs):
            if p.suffix == '.jpg':
                raise PermissionError('locked')
            return unlink(p, *args, **kwargs)
        patch.setattr(Path, 'unlink', locked)
        assert remove_test_movies(*library) == 0
    assert not path.exists()
    with db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM movies').fetchone()[0] == 1
    assert remove_test_movies(*library) == 1
    assert not list((data / 'posters').iterdir())


def test_old_media_directory_after_storage_move(library):
    db, data, _ = library
    seed(library, 'Fjordens ro')
    new_media = data / 'new-media'
    new_media.mkdir()
    assert remove_test_movies(db, data, new_media) == 1


def test_symlink_does_not_delete_target(library):
    _, data, _ = library
    _, path = seed(library, 'Fjordens ro')
    outside = data / 'real-user-video.mp4'
    path.rename(outside)
    try:
        path.symlink_to(outside)
    except OSError:
        pytest.skip('Symlinks require privileges on this platform')
    assert remove_test_movies(*library) == 0
    assert outside.read_bytes() == b'legacy sample'


def test_removed_routes_and_controls():
    from app import main
    assert not any(route.path.startswith('/api/demo') for route in main.app.routes)
    root = Path(__file__).resolve().parents[1]
    for name in ('app.js', 'index.html', 'tvremote.js'):
        content = (root / 'app' / 'static' / name).read_text(encoding='utf-8')
        assert 'demo-button' not in content and '/demo' not in content
    assert not (root / 'app' / 'demos.py').exists()
