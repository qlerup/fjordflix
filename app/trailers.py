"""Bounded, temporary YouTube trailer cache, independent of movie playback."""
import re
import logging
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from fastapi import HTTPException

TTL = 86400
MAX_BYTES = 150 * 1024 * 1024
MAX_FILES = 20
_lock = threading.Lock()
_jobs = {}
_slots = threading.BoundedSemaphore(2)


def valid(key):
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', key):
        raise HTTPException(400, 'Ugyldig trailer.')
    return key


def file(data, key):
    path = Path(data) / 'trailers' / (valid(key) + '.mp4')
    if not path.is_file() or time.time() - path.stat().st_mtime > TTL:
        raise HTTPException(404, 'Traileren er ikke klar. Start den igen.')
    return path


def convert(source, target):
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source),
                    '-map', '0:v:0', '-map', '0:a:0?', '-t', '600',
                    '-vf', 'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
                    '-profile:v', 'main', '-level', '3.1', '-r', '30',
                    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
                    '-movflags', '+faststart', '-fs', str(MAX_BYTES), str(target)],
                   check=True, timeout=240, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def download(key, folder):
    from deno import find_deno_bin
    # Only catalog-selected YouTube IDs enter this command. No user URLs/cookies.
    subprocess.run([sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-playlist',
                    '--js-runtimes', 'deno:' + str(find_deno_bin()),
                    '--no-progress', '--no-warnings', '--socket-timeout', '15', '--retries', '1',
                    '--fragment-retries', '1', '--max-filesize', str(MAX_BYTES),
                    '--match-filter', 'duration <= 600 & !is_live', '--merge-output-format', 'mp4',
                    '-f', 'bv[height<=720]+ba/b[height<=720]',
                    '-o', str(folder / 'source.%(ext)s'),
                    'https://www.youtube.com/watch?v=' + valid(key)],
                   check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    candidates = [p for p in folder.glob('source.*') if p.suffix in ('.mp4', '.webm', '.mkv')]
    if len(candidates) != 1 or candidates[0].stat().st_size > MAX_BYTES:
        raise ValueError('No bounded trailer file')
    return candidates[0]


def _work(data, key, job_key):
    folder = Path(data) / 'trailers'
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='prepare-', dir=folder) as temporary:
            work = Path(temporary)
            source = download(key, work)
            target = work / 'trailer.mp4'
            convert(source, target)
            if not target.is_file() or not 0 < target.stat().st_size <= MAX_BYTES:
                raise ValueError('Invalid converted trailer')
            target.replace(folder / (key + '.mp4'))
        with _lock:
            _jobs.pop(job_key, None)
    except Exception as error:
        logging.getLogger(__name__).warning('Trailer %s preparation failed (%s)', key, type(error).__name__)
        with _lock:
            _jobs[job_key] = {'status': 'error', 'time': time.time()}
    finally:
        _slots.release()


def prepare(data, key):
    valid(key)
    folder = Path(data) / 'trailers'
    job_key = (str(folder.resolve()), key)
    with _lock:
        now = time.time()
        # Keep failure backoff short and the in-memory state bounded.
        for name, job in list(_jobs.items()):
            if job['status'] == 'error' and now - job['time'] > 60:
                del _jobs[name]
        try:
            path = file(data, key)
            path.touch()  # Active/recent trailers stay in the LRU cache.
            return {'status': 'ready'}
        except HTTPException:
            pass
        if job_key in _jobs:
            return {'status': _jobs[job_key]['status']}
        if not _slots.acquire(blocking=False):
            raise HTTPException(429, 'Serveren klargør andre trailere. Prøv igen om lidt.')
        try:
            folder.mkdir(parents=True, exist_ok=True)
            files = sorted(folder.glob('*.mp4'), key=lambda p: p.stat().st_mtime, reverse=True)
            for index, path in enumerate(files):
                age = now - path.stat().st_mtime
                if (index >= MAX_FILES - 2 and age > 120) or age > TTL:
                    try:
                        path.unlink()
                    except OSError:
                        pass  # A player can still have the file open on Windows.
            pending = sum(job['status'] == 'preparing' and name[0] == job_key[0] for name, job in _jobs.items())
            if len(list(folder.glob('*.mp4'))) + pending >= MAX_FILES:
                raise HTTPException(429, 'Trailercachen er optaget. Prøv igen om lidt.')
            _jobs[job_key] = {'status': 'preparing', 'time': now}
            threading.Thread(target=_work, args=(data, key, job_key), daemon=True).start()
        except Exception:
            _jobs.pop(job_key, None)
            _slots.release()
            raise
        return {'status': 'preparing'}
