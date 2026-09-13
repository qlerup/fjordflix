"""Manual library metadata and artwork, independent of video playback state."""
import json
import subprocess
import tempfile
import time
from datetime import date
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


class LibraryEdit(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    media_type: Literal['movie', 'tv']
    overview: str = Field(default='', max_length=10000)
    genres: list[str] = Field(default_factory=list, max_length=20)
    release_date: str = Field(default='', max_length=10)
    rating: float | None = Field(default=None, ge=0, le=10)
    series_title: str = Field(default='', max_length=160)
    series_year: str = Field(default='', pattern=r'^(?:\d{4})?$')
    series_overview: str = Field(default='', max_length=10000)
    episode_title: str = Field(default='', max_length=160)
    season: int | None = Field(default=None, ge=0, le=999, strict=True)
    episode: int | None = Field(default=None, ge=1, le=9999, strict=True)
    audio_language_overrides: dict[str, str] | None = None


def edited_metadata(meta, edit):
    data = edit.model_dump()
    overrides = data.pop('audio_language_overrides')
    if overrides is not None:
        valid = {str(t['index']) for t in meta.get('tracks', {}).get('audio', [])}
        overrides = {key: value.strip() for key, value in overrides.items() if value.strip()}
        if any(key not in valid or len(value) > 80 for key, value in overrides.items()):
            raise ValueError('Vælg et gyldigt lydspor. Visningsteksten må højst være 80 tegn.')
        meta = {**meta, 'audio_language_overrides': overrides}
    data['title'] = data['title'].strip()
    data['series_title'] = data['series_title'].strip()
    if not data['title']:
        raise ValueError('Titlen må ikke være tom.')
    if edit.release_date:
        date.fromisoformat(edit.release_date)
    if any(len(g) > 80 for g in edit.genres):
        raise ValueError('En genre må højst være 80 tegn.')
    if edit.media_type == 'tv' and (not data['series_title'] or edit.season is None or edit.episode is None):
        raise ValueError('Serier kræver serienavn, sæson og afsnitsnummer.')
    old = meta.get('catalog', {})
    info = {**old, **data, 'manual': True, 'updated_at': time.time()}
    if old.get('media_type') != edit.media_type or old.get('series_title', '') != data['series_title'] or old.get('series_year', '') != edit.series_year:
        info.pop('tmdb_id', None)
    if edit.media_type == 'movie':
        for key in ('series_title', 'series_year', 'series_overview', 'season', 'episode', 'episode_title', 'episode_status'):
            info.pop(key, None)
    return {**meta, 'catalog': info}


def save_artwork(data, destination):
    """Decode/re-encode local images; never store SVG or arbitrary HTML as artwork."""
    jpeg = data.startswith(b'\xff\xd8\xff')
    png = data.startswith(b'\x89PNG\r\n\x1a\n')
    webp = data[:4] == b'RIFF' and data[8:12] == b'WEBP'
    if not (jpeg or png or webp):
        raise ValueError('Vælg et JPEG-, PNG- eller WebP-billede.')
    with tempfile.TemporaryDirectory(prefix='art-', dir=destination.parent) as folder:
        source = Path(folder) / 'source'
        output = Path(folder) / 'art.jpg'
        source.write_bytes(data)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                                '-show_streams', '-of', 'json', str(source)], capture_output=True, timeout=15)
        streams = json.loads(probe.stdout or b'{}').get('streams', [])
        stream = next((s for s in streams if s.get('codec_type') == 'video'), {})
        width, height = stream.get('width', 0), stream.get('height', 0)
        if probe.returncode or not width or not height or width * height > 16000000:
            raise ValueError('Billedet kunne ikke læses eller er større end 16 megapixel.')
        result = subprocess.run(['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', str(source),
                                 '-frames:v', '1', '-vf', "scale='min(1920,iw)':-2", '-y', str(output)],
                                capture_output=True, timeout=20)
        if result.returncode or not output.exists():
            raise ValueError('Billedet kunne ikke behandles.')
        output.replace(destination)
