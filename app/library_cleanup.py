"""Remove library records and private caches only after a complete storage scan."""
import re
import secrets
import stat
from pathlib import Path


def prune(host, root, source_id=None):
    root = Path(root).resolve()
    device = root.stat().st_dev
    if not root.is_dir():
        return 0
    # Enumerate before deleting anything. Permission/I/O failures abort the pass.
    import os
    def failed(error):
        raise error
    present = set()
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=failed):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        present.update(str(Path(directory) / name) for name in files)
    with host.db() as conn:
        rows = conn.execute('SELECT m.* FROM movies m LEFT JOIN library_files f ON f.movie_id=m.id '
                            'WHERE f.source_id=?' if source_id else
                            'SELECT m.* FROM movies m LEFT JOIN library_files f ON f.movie_id=m.id '
                            'WHERE f.movie_id IS NULL', (source_id,) if source_id else ()).fetchall()
        rows = [r for r in rows if Path(r['path']).is_absolute()
                and Path(r['path']).is_relative_to(root)]
        previous = conn.execute('SELECT device FROM library_scan_roots WHERE path=?', (str(root),)).fetchone()
        # Establish/re-establish storage identity only with an existing indexed file,
        # or an empty catalog. An unmounted directory must not become a new baseline.
        surviving = any(r['path'] in present for r in rows)
        if previous is None or previous['device'] != str(device):
            if surviving or not rows:
                conn.execute('INSERT OR REPLACE INTO library_scan_roots VALUES (?,?)', (str(root), str(device)))
            else:
                return 0
    removed = 0
    for row in rows:
        if row['path'] in present:
            continue
        mid = row['id']
        if not re.fullmatch(r'[a-f0-9]{32}', mid):
            continue
        staged = []
        try:
            with host.LOCK, host.db() as conn:
                if any(job.get('movie_id') == mid for job in host.JOBS.values()):
                    continue
                if root.stat().st_dev != device:
                    raise OSError('Library storage changed during scan')
                try:
                    Path(row['path']).stat()
                    continue  # Reappeared or changed type; never remove its catalog entry.
                except FileNotFoundError:
                    pass
                conn.execute('BEGIN IMMEDIATE')
                current = conn.execute('SELECT path,metadata FROM movies WHERE id=?', (mid,)).fetchone()
                if current is None or current['path'] != row['path'] or current['metadata'] != row['metadata']:
                    continue
                paths = [host.DATA / 'posters' / f'{mid}{suffix}.jpg'
                         for suffix in ('', '-backdrop', '-episode', '-frame')]
                paths += list((host.DATA / 'subtitles' / 'downloaded').glob(f'{mid}-*.srt'))
                for path in paths:
                    # Only app-owned generated files, never source media or shared portraits.
                    if not path.resolve().is_relative_to(host.DATA.resolve()) or path.is_symlink():
                        continue
                    try:
                        info = path.stat()
                    except FileNotFoundError:
                        continue
                    if not stat.S_ISREG(info.st_mode):
                        continue
                    temporary = path.with_name('.deleted-' + secrets.token_hex(16))
                    path.rename(temporary)
                    staged.append((path, temporary))
                conn.execute('DELETE FROM progress WHERE movie_id=?', (mid,))
                conn.execute('DELETE FROM media_grants WHERE movie=?', (mid,))
                conn.execute('DELETE FROM library_files WHERE movie_id=?', (mid,))
                conn.execute('DELETE FROM movies WHERE id=?', (mid,))
            removed += 1
        except Exception:
            for original, temporary in reversed(staged):
                temporary.rename(original)
            raise
        for original, temporary in staged:
            temporary.unlink(missing_ok=True)
    return removed
