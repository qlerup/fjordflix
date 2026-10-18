"""Small HTTP uploads; disk-backed sessions for the single-worker app."""
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

CHUNK_SIZE = 2 * 1024 * 1024


class StartUpload(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    relative_path: str = Field(default='', max_length=2048)


class Uploads:
    def __init__(self, backend):
        self.backend = backend
        self.lock = threading.RLock()

    @property
    def root(self):
        root = self.backend.MEDIA / '.uploads'
        root.mkdir(exist_ok=True)
        return root

    def save(self, state):
        path = self.root / (state['id'] + '.json')
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state), encoding='utf-8')
        temporary.replace(path)

    def destination(self, state, create=False):
        """Keep folder uploads beneath MEDIA; never traverse a link or replace a file."""
        relative = state.get('stored_path') or state.get('relative_path') or (state['id'] + state['suffix'])
        parts = relative.split('/')
        if (relative.startswith('/') or any(not p or p in ('.', '..', '.uploads')
                or len(p.encode('utf-8')) > 255 or re.search(r'[\\:\x00-\x1f\x7f]', p) for p in parts)):
            raise HTTPException(400, 'Ugyldig mappesti i upload.')
        path = self.backend.MEDIA
        for part in parts[:-1]:
            path = path / part
            if path.is_symlink():
                raise HTTPException(400, 'Uploadmapper må ikke være links.')
            if create:
                path.mkdir(exist_ok=True)
        path = path / parts[-1]
        if path.is_symlink():
            raise HTTPException(400, 'Uploadfilen må ikke være et link.')
        return path

    @staticmethod
    def identity(path):
        info = path.stat(follow_symlinks=False)
        return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]

    def read(self, uid, owner):
        if not re.fullmatch(r'[a-f0-9]{32}', uid):
            raise HTTPException(404, 'Upload findes ikke.')
        try:
            state = json.loads((self.root / (uid + '.json')).read_text(encoding='utf-8'))
        except FileNotFoundError:
            raise HTTPException(404, 'Upload er udløbet. Vælg filen igen.')
        if state['owner'] != owner:
            raise HTTPException(404, 'Upload findes ikke.')
        return state

    def cleanup(self, restarting=False):
        with self.lock:
            for path in self.root.glob('*.json'):
                state = json.loads(path.read_text(encoding='utf-8'))
                if restarting and state['status'] == 'processing':
                    # Completion can be requested again after a server restart.
                    state['status'] = 'uploading'
                    self.save(state)
                if state['status'] != 'processing' and time.time() - state['touch'] > 48 * 3600:
                    (self.root / (state['id'] + '.part')).unlink(missing_ok=True)
                    with self.backend.db() as conn:
                        indexed = conn.execute('SELECT id FROM movies WHERE id=?', (state['id'],)).fetchone()
                    if not indexed:
                        final = self.destination(state)
                        # A later upload may reuse the same folder/filename. It is not ours.
                        legacy = not state.get('relative_path')
                        if final.exists() and (legacy or state.get('published') and state.get('file_identity') == self.identity(final)):
                            final.unlink()
                    path.unlink(missing_ok=True)

    def start(self, data, owner):
        suffix = Path(data.filename).suffix.lower()
        if suffix not in ('.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.ts'):
            raise HTTPException(400, 'Filtypen understøttes ikke.')
        if data.relative_path and (data.relative_path.split('/')[-1] != data.filename or '/' not in data.relative_path):
            raise HTTPException(400, 'Mappestien skal indeholde filens navn og mappe.')
        with self.lock:
            if shutil.disk_usage(self.backend.MEDIA).free < data.size + 512 * 1024**2:
                raise HTTPException(507, 'Serveren mangler ledig diskplads.')
            state = dict(id=secrets.token_hex(16), owner=owner, filename=data.filename,
                         relative_path=data.relative_path, suffix=suffix, size=data.size, offset=0, status='uploading', touch=time.time())
            self.destination(state)  # Validate before creating an upload session.
            (self.root / (state['id'] + '.part')).touch()
            self.save(state)
            return state

    def chunk(self, uid, owner, offset, content):
        with self.lock:
            state = self.read(uid, owner)
            expected = min(CHUNK_SIZE, state['size'] - offset)
            if offset < 0 or offset % CHUNK_SIZE or not content or len(content) != expected:
                raise HTTPException(400, 'Ugyldig uploadbid.')
            if state['status'] != 'uploading' or offset > state['offset']:
                raise HTTPException(409, 'Uploadpositionen er ændret. Prøv igen.')
            path = self.root / (uid + '.part')
            with path.open('r+b') as output:
                output.seek(offset)
                if offset < state['offset']:
                    # Lost HTTP responses may cause an already saved chunk to be resent.
                    if output.read(len(content)) != content:
                        raise HTTPException(409, 'Uploadbidden stemmer ikke med filen.')
                else:
                    if shutil.disk_usage(self.backend.MEDIA).free < len(content) + 512 * 1024**2:
                        raise HTTPException(507, 'Serveren mangler ledig diskplads.')
                    output.write(content)
                    output.truncate()
                    output.flush()
                    state['offset'] += len(content)
            state['touch'] = time.time()
            self.save(state)
            return state

    def status(self, uid, owner):
        with self.lock:
            state = self.read(uid, owner)
            state['touch'] = time.time()
            self.save(state)
            return state

    def complete(self, uid, owner):
        with self.lock:
            state = self.read(uid, owner)
            if state['offset'] != state['size']:
                raise HTTPException(409, 'Filen er ikke færdiguploadet.')
            if state['status'] == 'uploading':
                state['status'] = 'processing'
                self.save(state)
                threading.Thread(target=self.finish, args=(dict(state),), daemon=True).start()
            return state

    def finish(self, state):
        mid = state['id']
        path = None
        published = False
        try:
            with self.backend.db() as conn:
                exists = conn.execute('SELECT id FROM movies WHERE id=?', (mid,)).fetchone()
            if not exists:
                part = self.root / (mid + '.part')
                if part.exists() and not state.get('published'):
                    with self.lock:
                        path = self.destination(state, create=True)
                        if path.exists():
                            stem = path.stem.encode('utf-8')[:180].decode('utf-8', errors='ignore')
                            path = path.with_name(stem + '-' + mid + state['suffix'])
                        state['stored_path'] = path.relative_to(self.backend.MEDIA).as_posix()
                        # Exclusive publication protects simultaneous same-name uploads.
                        try:
                            os.link(part, path)
                            published = True
                        except OSError as error:
                            if isinstance(error, FileExistsError):
                                raise HTTPException(409, 'En fil med samme navn findes allerede. Prøv igen.')
                            # Filesystems without hard links use bounded disk-to-disk copying.
                            with path.open('xb') as output, part.open('rb') as source:
                                published = True
                                shutil.copyfileobj(source, output, CHUNK_SIZE)
                        state['published'] = True
                        state['file_identity'] = self.identity(path)
                        self.save(state)
                        part.unlink()
                else:
                    path = self.destination(state)
                    published = bool(state.get('published')) or not state.get('relative_path')
                    part.unlink(missing_ok=True)
                title = self.backend.catalog.file_title(Path(state.get('relative_path') or state['filename']))
                self.backend.index_movie(path, title, mid, True)
            info = self.backend.movie(mid)[1].get('catalog', {})
            state.update(status='done', metadata_status=info.get('status', 'disabled'),
                         metadata_message=self.backend.catalog.message(info))
        except Exception as exc:
            state.update(status='error', message=exc.detail if isinstance(exc, HTTPException)
                         else 'Videoen kunne ikke behandles. Tjek serverens log og diskplads.')
            import logging
            logging.getLogger(__name__).exception('Upload processing failed: %s', mid)
            # Do not remove a video that was successfully indexed before an error.
            with self.backend.db() as conn:
                exists = conn.execute('SELECT id FROM movies WHERE id=?', (mid,)).fetchone()
            if not exists and path is not None and published:
                path.unlink(missing_ok=True)
                state['published'] = False
        finally:
            with self.lock:
                state['touch'] = time.time()
                self.save(state)


def register(app, backend):
    uploads = Uploads(backend)

    @app.post('/api/uploads')
    def start(data: StartUpload, u=Depends(backend.admin)):
        return uploads.start(data, u['id'])

    @app.put('/api/uploads/{uid}')
    async def chunk(uid: str, request: Request, offset: int, u=Depends(backend.admin)):
        content = bytearray()
        async for block in request.stream():
            content.extend(block)
            if len(content) > CHUNK_SIZE:
                raise HTTPException(413, 'Uploadbidder må højst være 2 MB.')
        import asyncio
        return await asyncio.to_thread(uploads.chunk, uid, u['id'], offset, bytes(content))

    @app.get('/api/uploads/{uid}')
    def status(uid: str, u=Depends(backend.admin)):
        return uploads.status(uid, u['id'])

    @app.post('/api/uploads/{uid}/complete')
    def complete(uid: str, u=Depends(backend.admin)):
        return uploads.complete(uid, u['id'])

    return uploads
