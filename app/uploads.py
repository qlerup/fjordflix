"""Small HTTP uploads; disk-backed sessions for the single-worker app."""
import json
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
                        (self.backend.MEDIA / (state['id'] + state['suffix'])).unlink(missing_ok=True)
                    path.unlink(missing_ok=True)

    def start(self, data, owner):
        suffix = Path(data.filename).suffix.lower()
        if suffix not in ('.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.ts'):
            raise HTTPException(400, 'Filtypen understøttes ikke.')
        with self.lock:
            if shutil.disk_usage(self.backend.MEDIA).free < data.size + 512 * 1024**2:
                raise HTTPException(507, 'Serveren mangler ledig diskplads.')
            state = dict(id=secrets.token_hex(16), owner=owner, filename=data.filename,
                         suffix=suffix, size=data.size, offset=0, status='uploading', touch=time.time())
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
        path = self.backend.MEDIA / (mid + state['suffix'])
        try:
            with self.backend.db() as conn:
                exists = conn.execute('SELECT id FROM movies WHERE id=?', (mid,)).fetchone()
            if not exists:
                part = self.root / (mid + '.part')
                if part.exists():
                    part.replace(path)
                self.backend.index_movie(path, Path(state['filename']).stem.replace('_', ' ').replace('.', ' '), mid, True)
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
            if not exists:
                path.unlink(missing_ok=True)
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
