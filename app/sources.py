"""Read-only mounted library sources. Media bytes always stay at their source."""
import asyncio
import json
import logging
import os
import secrets
import subprocess
import threading
from pathlib import Path, PurePosixPath

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

VIDEO_SUFFIXES = {'.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.ts'}
log = logging.getLogger(__name__)


class SourceInput(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class Sources:
    def __init__(self, app, host):
        self.host = host
        self.lock = threading.Lock()
        self.rescan = threading.Event()
        self.status = {'running': False, 'added': 0, 'updated': 0, 'errors': []}
        with host.db() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS library_sources(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
                CREATE TABLE IF NOT EXISTS library_files(
                    movie_id TEXT PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
                    source_id TEXT NOT NULL REFERENCES library_sources(id),
                    fingerprint TEXT NOT NULL);
            ''')

        @app.get('/api/admin/library')
        def listing(u=Depends(host.admin)):
            with host.db() as conn:
                rows = conn.execute('SELECT s.*, COUNT(f.movie_id) AS count FROM library_sources s '
                                    'LEFT JOIN library_files f ON f.source_id=s.id GROUP BY s.id').fetchall()
            return {'sources': [{**dict(row), 'available': Path(row['path']).is_dir()} for row in rows],
                    'scan': self.status}

        @app.get('/api/admin/library/browse')
        def browse(path: str = '', u=Depends(host.admin)):
            if not path:
                return {'path': '', 'parent': None, 'directories': [
                    {'name': str(root), 'path': str(root)} for root in self.roots() if root.is_dir()]}
            folder = self.allowed(path)
            try:
                children = sorted((p for p in folder.iterdir() if not p.is_symlink() and p.is_dir()),
                                  key=lambda p: p.name.casefold())
                directories = [{'name': p.name, 'path': str(p)} for p in children[:1000]]
            except OSError:
                raise HTTPException(400, 'Mappen kunne ikke læses. Kontrollér montering og læserettigheder.')
            parent = '' if folder in self.roots() else str(folder.parent)
            return {'path': str(folder), 'parent': parent, 'directories': directories,
                    'truncated': len(children) > 1000}

        @app.get('/api/admin/library/proxmox')
        def proxmox(u=Depends(host.admin)):
            if not host.hub.managed():
                return {'configured': False, 'storages': [], 'disks': [], 'mounts': [],
                        'errors': ['Proxmox-oversigten kræver forbindelsen gennem FjordHub. Monterede biblioteksdrev kan stadig vælges med Tilføj mappe.']}
            try:
                data = host.hub.call('/api/hub/apps/fjordflix/library', {'user_id': u.get('hub_id')}, method='GET', timeout=50)
            except HTTPException as exc:
                if exc.status_code == 503:
                    raise HTTPException(503, 'Lageroversigten kunne ikke hentes fra FjordHub. Opdatér både FjordHub og FjordFlix, og kontrollér Proxmox-forbindelsen.') from exc
                raise
            host_root = PurePosixPath(os.getenv('LIBRARY_HOST_ROOT', '/mnt'))
            def mapped(value):
                path = PurePosixPath(value)
                if not path.is_absolute() or '..' in path.parts or not path.is_relative_to(host_root):
                    return None
                local = Path('/library/server') / str(path.relative_to(host_root))
                try:
                    return str(self.allowed(str(local)))
                except HTTPException:
                    return None
            for entry in data.get('storages', []) + data.get('disks', []):
                entry['directories'] = [{'name': path, 'path': local} for path in entry.get('paths', []) if (local := mapped(path))]
            for entry in data.get('mounts', []):
                entry['local_path'] = mapped(entry['path'])
            return {**data, 'configured': True}

        @app.post('/api/admin/library', status_code=201)
        def add(data: SourceInput, u=Depends(host.admin)):
            folder = self.allowed(data.path)
            try:
                with os.scandir(folder):
                    pass
            except OSError:
                raise HTTPException(400, 'Mappen kunne ikke læses. Kontrollér læserettigheder.')
            with host.db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                for row in conn.execute('SELECT path FROM library_sources'):
                    existing = Path(row['path'])
                    if folder.is_relative_to(existing) or existing.is_relative_to(folder):
                        raise HTTPException(409, 'Mappen eller en overordnet/underordnet mappe er allerede tilføjet.')
                sid = secrets.token_hex(16)
                conn.execute('INSERT INTO library_sources VALUES (?,?)', (sid, str(folder)))
            # If a scan has already taken its snapshot, pick up this new source
            # immediately afterwards instead of waiting for the periodic scan.
            self.rescan.set()
            return {'id': sid, 'path': str(folder), 'queued': self.status['running']}

        @app.delete('/api/admin/library/{sid}')
        def remove(sid: str, u=Depends(host.admin)):
            if not self.lock.acquire(blocking=False):
                raise HTTPException(409, 'Vent til scanningen er færdig, før mappen fjernes.')
            try:
                with host.LOCK, host.db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    ids = {r['movie_id'] for r in conn.execute('SELECT movie_id FROM library_files WHERE source_id=?', (sid,))}
                    if any(job.get('movie_id') in ids for job in host.JOBS.values()):
                        raise HTTPException(409, 'Stop aktive konverteringer fra mappen, før den fjernes.')
                    for mid in ids:
                        conn.execute('DELETE FROM progress WHERE movie_id=?', (mid,))
                        conn.execute('DELETE FROM media_grants WHERE movie=?', (mid,))
                        conn.execute('DELETE FROM library_files WHERE movie_id=?', (mid,))
                        conn.execute('DELETE FROM movies WHERE id=?', (mid,))
                    conn.execute('DELETE FROM library_sources WHERE id=?', (sid,))
            finally:
                self.lock.release()
            return {'ok': True}

        @app.post('/api/admin/library/scan', status_code=202)
        def scan(u=Depends(host.admin)):
            if not self.start():
                raise HTTPException(409, 'Biblioteket scannes allerede.')
            return self.status

    def roots(self):
        # JSON also supports Windows paths without ambiguous colon separators.
        configured = json.loads(os.getenv('LIBRARY_ROOTS', json.dumps([str(Path('/library').resolve())])))
        if not isinstance(configured, list) or any(not isinstance(p, str) or not Path(p).is_absolute() for p in configured):
            raise RuntimeError('LIBRARY_ROOTS skal være en JSON-liste med absolutte mapper.')
        return list(dict.fromkeys(Path(p).resolve() for p in configured))

    def allowed(self, value):
        path = Path(value)
        if not path.is_absolute():
            raise HTTPException(400, 'Vælg en absolut mappesti.')
        path = path.resolve()
        if not any(path.is_relative_to(root) for root in self.roots()):
            raise HTTPException(400, 'Mappen ligger uden for de tilgængelige biblioteksdrev.')
        if not path.is_dir():
            raise HTTPException(400, 'Mappen er ikke tilgængelig. Kontrollér at lageret er monteret.')
        return path

    def start(self):
        if not self.lock.acquire(blocking=False):
            return False
        self.rescan.clear()
        self.status = {'running': True, 'added': 0, 'updated': 0, 'errors': []}
        threading.Thread(target=self.scan, daemon=True, name='library-scan').start()
        return True

    def error(self, message):
        log.warning('Library scan: %s', message)
        # Bound the status response even for a damaged or disconnected drive.
        self.status = {**self.status, 'errors': (self.status['errors'] + [message])[-50:]}

    def scan(self):
        try:
            with self.host.db() as conn:
                sources = conn.execute('SELECT * FROM library_sources').fetchall()
                known = {str(Path(r['path']).resolve()): dict(r) for r in conn.execute(
                    'SELECT m.id,m.path,f.fingerprint FROM movies m LEFT JOIN library_files f ON f.movie_id=m.id')}
            for source in sources:
                try:
                    folder = self.allowed(source['path'])
                    for directory, dirs, files in os.walk(folder, followlinks=False, onerror=lambda e: self.error(f'{source["path"]}: {e.strerror}')):
                        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
                        for name in files:
                            path = Path(directory) / name
                            if path.suffix.lower() not in VIDEO_SUFFIXES or path.is_symlink():
                                continue
                            try:
                                path = path.resolve()
                                if not path.is_relative_to(folder):
                                    continue
                                stat = path.stat()
                                fingerprint = f'{stat.st_size}:{stat.st_mtime_ns}'
                                old = known.get(str(path))
                                if old and (old['fingerprint'] is None or old['fingerprint'] == fingerprint):
                                    continue
                                if old:
                                    details = self.host.probe(path)
                                    with self.host.db() as conn:
                                        conn.execute('BEGIN IMMEDIATE')
                                        row = conn.execute('SELECT metadata FROM movies WHERE id=?', (old['id'],)).fetchone()
                                        if row:
                                            meta = {**json.loads(row['metadata']), **details}
                                            conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), old['id']))
                                            conn.execute('UPDATE library_files SET fingerprint=? WHERE movie_id=?', (fingerprint, old['id']))
                                    self.status['updated'] += 1
                                else:
                                    mid = secrets.token_hex(16)
                                    self.host.index_movie(path, path.stem.replace('_', ' ').replace('.', ' '), mid,
                                                          True, source=(source['id'], fingerprint))
                                    known[str(path)] = {'id': mid, 'fingerprint': fingerprint}
                                    self.status['added'] += 1
                            except (OSError, ValueError, subprocess.TimeoutExpired, HTTPException) as exc:
                                self.error(f'{path.name}: {getattr(exc, "detail", str(exc))}')
                except (OSError, HTTPException) as exc:
                    self.error(f'{source["path"]}: {getattr(exc, "detail", str(exc))}')
        except Exception:
            log.exception('Library scan failed')
            self.error('Scanningen blev afbrudt. Se serverloggen og prøv igen.')
        finally:
            self.status['running'] = False
            self.lock.release()
            if self.rescan.is_set():
                self.start()

    async def watch(self):
        while True:
            self.start()
            await asyncio.sleep(900)
