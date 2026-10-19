"""Admin exports of existing subtitle tracks, without changing source media."""
from pathlib import Path
import re
import subprocess
import tempfile

from fastapi import Depends, HTTPException
from fastapi.responses import FileResponse
from app import sidecars, tracks


def extract(source, index, codec, cache):
    # Keep styled text and image subtitles in their original format. Other text
    # is converted to the widely supported SRT format; no OCR is performed.
    extension, encoder = ('ass', 'copy') if codec in {'ass', 'ssa'} else (
        ('sup', 'copy') if codec == 'hdmv_pgs_subtitle' else (
        ('mks', 'copy') if codec in tracks.BITMAP else ('srt', 'srt')))
    output = tracks.cache_path(source, index, cache).with_suffix('.' + extension)
    if output.is_file():
        return output
    if not tracks.EXTRACTIONS.acquire(blocking=False):
        raise RuntimeError('Serveren klargør andre undertekster. Prøv igen om lidt.')
    try:
        with tempfile.TemporaryDirectory(prefix='export-', dir=output.parent) as folder:
            temporary = Path(folder) / output.name
            result = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
                '-i', str(source), '-map', f'0:{index}', '-c:s', encoder, '-y', str(temporary)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            if result.returncode or not temporary.is_file():
                raise RuntimeError('Undertekstsporet kunne ikke udtrækkes.')
            if temporary.stat().st_size > 128 * 1024**2:
                raise RuntimeError('Undertekstsporet er for stort til download.')
            temporary.replace(output)
    finally:
        tracks.EXTRACTIONS.release()
    return output


def register(backend):
    @backend.app.get('/api/movies/{mid}/subtitles/{index}/download')
    def download(mid: str, index: int, u=Depends(backend.admin)):
        row, meta = backend.movie(mid)
        meta = sidecars.metadata(meta, row['path'])
        try:
            _, subtitle = tracks.select(meta, subtitle_index=index)
            source = backend.subtitle_source(row, mid, subtitle)
            path = Path(source) if subtitle.get('external') else extract(
                source, index, subtitle['codec'], backend.DATA / 'subtitles' / 'exports')
            if not path.is_file():
                raise HTTPException(404, 'Undertekstfilen findes ikke længere.')
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except (OSError, subprocess.TimeoutExpired, RuntimeError):
            raise HTTPException(503, 'Underteksterne kunne ikke klargøres. Prøv igen om lidt.') from None
        title = re.sub(r'[\\/\x00-\x1f\x7f:*?"<>|]', '_', row['title'])[:120] or 'undertekster'
        language = re.sub(r'[^a-zA-Z0-9_-]', '', subtitle.get('language') or 'und')[:20]
        filename = f'{title}.{language}.{index}{path.suffix}'
        return FileResponse(path, filename=filename, media_type='application/octet-stream',
                            headers={'Cache-Control': 'private, no-store'})
