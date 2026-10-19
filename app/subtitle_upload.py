"""Bounded, explicit SRT uploads to a single library title."""
import hashlib
import json
from pathlib import Path
import re
import tempfile
import threading

from fastapi import Depends, HTTPException, Request
from app.opensubtitles import LIMIT, normalize_srt, subtitle_path
from app.sidecars import LANGUAGES

LOCK = threading.RLock()
OFFSET = 2**49


def store(backend, mid, filename, language, raw):
    if (not filename or len(filename) > 255 or Path(filename).name != filename
            or re.search(r'[\\/\x00-\x1f\x7f]', filename) or not filename.lower().endswith('.srt')):
        raise HTTPException(400, 'Vælg en SRT-fil med et gyldigt filnavn.')
    if language not in LANGUAGES | {'und'}:
        raise HTTPException(400, 'Vælg et understøttet undertekstsprog.')
    try:
        content = normalize_srt(raw).encode('utf-8')
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    fingerprint = hashlib.sha256(language.encode() + b'\0' + content).hexdigest()
    index = OFFSET + int(fingerprint[:12], 16)
    path = subtitle_path(backend.DATA, mid, index)
    track = {'index':index,'codec':'subrip','delivery':'text','language':language,
             'title':'Tilføjet · '+filename,'external':True,'uploaded':True,
             'default':False,'forced':False,'hearing_impaired':False}
    with LOCK, backend.db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT metadata FROM movies WHERE id=?', (mid,)).fetchone()
        if row is None:
            raise HTTPException(404, 'Filmen eller afsnittet findes ikke længere.')
        meta = json.loads(row['metadata'])
        existing = meta.get('external_subtitles', [])
        duplicate = next((t for t in existing if t['index'] == index), None)
        if duplicate and path.is_file():
            if path.read_bytes() != content:
                raise HTTPException(409, 'Undertekstfilens identitet er i konflikt med et eksisterende spor.')
            return {'index':index,'cached':True}
        if not duplicate and len(existing) >= 100:
            raise HTTPException(400, 'Denne titel har allerede 100 tilføjede eller hentede undertekstspor.')
        path.parent.mkdir(parents=True, exist_ok=True)
        created = not path.exists()
        if not created and path.read_bytes() != content:
            raise HTTPException(409, 'En anden undertekst bruger allerede denne filplacering.')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.srt', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content)
            temporary.replace(path)
            meta['external_subtitles'] = [t for t in existing if t['index'] != index] + [track]
            conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), mid))
            conn.commit()
        except Exception:
            if created:
                path.unlink(missing_ok=True)
            raise
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    return {'index':index,'cached':False}


def register(backend):
    @backend.app.delete('/api/movies/{mid}/subtitle-upload/{index}')
    def delete_upload(mid: str, index: int, u=Depends(backend.admin)):
        backend.movie(mid)
        with LOCK, backend.db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT metadata FROM movies WHERE id=?', (mid,)).fetchone()
            if row is None:
                raise HTTPException(404)
            meta = json.loads(row['metadata'])
            existing = meta.get('external_subtitles', [])
            track = next((t for t in existing if t.get('index') == index), None)
            if not track or not track.get('uploaded') or not OFFSET <= index < 2**50:
                raise HTTPException(400, 'Kun manuelt uploadede undertekster kan slettes her.')
            path = subtitle_path(backend.DATA, mid, index)
            meta['external_subtitles'] = [t for t in existing if t.get('index') != index]
            try:
                # Keep a recoverable file until the metadata transaction commits.
                if path.exists():
                    with tempfile.TemporaryDirectory(prefix='delete-', dir=path.parent) as folder:
                        backup = Path(folder) / 'subtitle.srt'
                        path.replace(backup)
                        try:
                            conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), mid))
                            conn.commit()
                        except Exception:
                            backup.replace(path)
                            raise
                else:
                    conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta), mid))
                    conn.commit()
            except OSError:
                raise HTTPException(503, 'Undertekstfilen kunne ikke slettes. Prøv igen.') from None
        return {'deleted': index}

    @backend.app.post('/api/movies/{mid}/subtitle-upload')
    async def upload(mid: str, request: Request, filename: str, language: str = 'und', u=Depends(backend.admin)):
        backend.movie(mid)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > LIMIT:
                raise HTTPException(413, 'Undertekstfilen må højst være 2 MiB.')
        return store(backend, mid, filename, language, bytes(raw))
