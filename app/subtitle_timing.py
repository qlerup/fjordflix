"""Persist admin timing edits as replacement text tracks, preserving media files."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from app import sidecars, tracks, subtitle_upload


def saved_path(data, mid, index, revision):
    if not re.fullmatch(r'[a-f0-9]{32}', mid) or not 0 <= index < 2**53 or not re.fullmatch(r'[a-f0-9]{64}', revision):
        raise ValueError('Ugyldigt undertekstspor.')
    return Path(data) / 'subtitles' / 'adjusted' / f'{mid}-{index}-{revision}.srt'


def shift_vtt(text, delay):
    def milliseconds(value):
        parts = value.split(':')
        return round((int(parts[-3]) * 3600 if len(parts) == 3 else 0) * 1000 + int(parts[-2]) * 60000 + float(parts[-1]) * 1000)
    def stamp(value):
        seconds, ms = divmod(max(0,value),1000)
        hours, seconds = divmod(seconds,3600)
        minutes, seconds = divmod(seconds,60)
        return f'{hours:02}:{minutes:02}:{seconds:02},{ms:03}'
    blocks = []
    for block in re.split(r'\n\s*\n', text.replace('\r\n','\n').strip()):
        lines = block.splitlines()
        for n, line in enumerate(lines):
            match = re.fullmatch(r'((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})(?: .*)?', line)
            if not match:
                continue
            start, end = [milliseconds(t) + round(delay * 1000) for t in match.groups()]
            if end > 0 and lines[n+1:]:
                blocks.append(f'{len(blocks)+1}\n{stamp(start)} --> {stamp(end)}\n' + '\n'.join(lines[n+1:]))
            break
    if not blocks:
        raise ValueError('Justeringen efterlader ingen undertekster. Vælg en anden timing.')
    return ('\n\n'.join(blocks) + '\n').encode('utf-8')


class Timing(BaseModel):
    delay: float = Field(ge=-300, le=300, allow_inf_nan=False)
    revision: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


def register(backend):
    @backend.app.post('/api/movies/{mid}/subtitles/{index}/timing')
    def save(mid: str, index: int, data: Timing, u=Depends(backend.admin)):
        with subtitle_upload.LOCK:
            row, meta = backend.movie(mid)
            current = meta.get('subtitle_overrides', {}).get(str(index))
            if current != data.revision:
                raise HTTPException(409, 'Underteksten er ændret. Åbn filmen igen før du gemmer.')
            try:
                enriched = sidecars.metadata(meta, row['path'])
                _, subtitle = tracks.select(enriched, subtitle_index=index)
                if subtitle['delivery'] != 'text':
                    raise ValueError('Kun tekstbaserede undertekster kan få gemt timing.')
                source = backend.subtitle_source(row, mid, subtitle)
                vtt = tracks.webvtt(source, 0 if subtitle.get('external') else index, backend.DATA/'subtitles')
                content = shift_vtt(vtt.read_text(encoding='utf-8'), data.delay)
                if len(content) > 16 * 1024**2:
                    raise ValueError('Undertekstfilen er for stor.')
                revision = hashlib.sha256(content).hexdigest()
                path = saved_path(backend.DATA, mid, index, revision)
                path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(content)
                try:
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
                with backend.db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    latest = conn.execute('SELECT metadata FROM movies WHERE id=? AND path=?',(mid,row['path'])).fetchone()
                    if not latest:
                        raise HTTPException(409, 'Filmen er ændret eller slettet.')
                    updated = json.loads(latest['metadata'])
                    if updated.get('subtitle_overrides', {}).get(str(index)) != current:
                        raise HTTPException(409, 'Underteksten er ændret. Åbn filmen igen.')
                    updated.setdefault('subtitle_overrides', {})[str(index)] = revision
                    conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(updated),mid))
                return {'revision': revision}
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from None
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                raise HTTPException(503, 'Timingen kunne ikke gemmes. Prøv igen om lidt.') from None
