"""Retire locally generated samples from installations predating their removal.

Old versions did not store a demo flag. Deliberately require the original title,
technical signature and managed filename, and exclude uploads/library sources.
Run on every startup so interrupted or temporarily blocked cleanup is retried.
"""
import json
import logging
import re
from pathlib import Path

LOG = logging.getLogger(__name__)
RETIRED = {
    'Nordlys · 4K testfilm': (3840, 2160, 12),
    'Fjordens ro': (1920, 1080, 30),
    'Det sidste sollys': (1920, 1080, 60),
    'Langt fra jorden': (3840, 2160, 120),
    'Bitstorm · 4K · 120 Mbit/s': (3840, 2160, 60),
}


def remove_test_movies(db, data, media):
    data = Path(data)
    roots = {Path(media).resolve(), (data / 'media').resolve()}
    removed = 0
    with db() as conn:
        rows = conn.execute('SELECT * FROM movies').fetchall()
        linked = {row[0] for row in conn.execute('SELECT movie_id FROM library_files')}
        for row in rows:
            mid = row['id']
            if row['title'] not in RETIRED or not re.fullmatch(r'[a-f0-9]{32}', mid) or mid in linked:
                continue
            try:
                meta = json.loads(row['metadata'])
                if not isinstance(meta, dict) or 'original_title' in meta or 'library_source' in meta:
                    continue
                width, height, duration = RETIRED[row['title']]
                if (meta.get('width'), meta.get('height'), meta.get('video'), meta.get('audio')) != (width, height, 'h264', 'aac'):
                    continue
                if abs(float(meta.get('duration', 0)) - duration) > 0.2 or meta.get('pix_fmt') != 'yuv420p':
                    continue
                path = Path(row['path'])
                if path.name != f'{mid}.mp4' or path.is_symlink() or path.resolve().parent not in roots:
                    continue
                if any(other['id'] != mid and Path(other['path']).resolve() == path.resolve() for other in rows):
                    continue
                if path.exists() and (not path.is_file() or path.stat().st_size != meta.get('size')):
                    continue
                artifacts = [path]
                for suffix in ('', '-frame', '-backdrop', '-episode'):
                    artifacts.append(data / 'posters' / f'{mid}{suffix}.jpg')
                # Explicit per-movie downloads only; never remove shared caches.
                subtitle_dir = data / 'subtitles' / 'downloaded'
                if subtitle_dir.is_dir():
                    artifacts.extend(p for p in subtitle_dir.glob(f'{mid}-*.srt')
                                     if re.fullmatch(rf'{mid}-\d+\.srt', p.name))
                # Do not follow redirected artwork/subtitle directories.
                if any(p != path and not p.resolve().is_relative_to(data.resolve()) for p in artifacts):
                    continue
                for artifact in artifacts:
                    artifact.unlink(missing_ok=True)
                conn.execute('DELETE FROM progress WHERE movie_id=?', (mid,))
                conn.execute('DELETE FROM media_grants WHERE movie=?', (mid,))
                conn.execute('DELETE FROM movies WHERE id=?', (mid,))
                conn.commit()
                removed += 1
            except (OSError, ValueError, TypeError):
                # Keep the row until all files are gone, allowing a later retry.
                LOG.warning('Could not retire legacy sample %s; will retry at startup', mid, exc_info=True)
    if removed:
        LOG.info('Removed %s retired sample movies', removed)
    return removed
