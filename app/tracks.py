"""Embedded media tracks and browser subtitle extraction."""
import hashlib
import json
import subprocess
import tempfile
import threading
from pathlib import Path

TEXT = {'subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'}
BITMAP = {'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'}
EXTRACTIONS = threading.BoundedSemaphore(2)


def describe(streams):
    result = {'version': 1, 'audio': [], 'subtitles': []}
    for stream in streams:
        kind = stream.get('codec_type')
        if kind not in ('audio', 'subtitle'):
            continue
        tags = {k.lower(): v for k, v in stream.get('tags', {}).items()}
        disposition = stream.get('disposition', {})
        codec = stream.get('codec_name', 'unknown')
        track = {'index': stream['index'], 'codec': codec,
                 'language': str(tags.get('language', 'und'))[:40], 'title': str(tags.get('title', ''))[:200],
                 'default': bool(disposition.get('default')), 'forced': bool(disposition.get('forced')),
                 'hearing_impaired': bool(disposition.get('hearing_impaired'))}
        if kind == 'audio':
            track.update(channels=stream.get('channels'), layout=stream.get('channel_layout', ''), profile=stream.get('profile', ''))
            result['audio'].append(track)
        else:
            track['delivery'] = 'text' if codec in TEXT else 'burn' if codec in BITMAP else 'unsupported'
            result['subtitles'].append(track)
    return result


def scan(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                             '-show_streams', '-of', 'json', str(path)], capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError('Filens lydspor og undertekster kunne ikke læses.')
    return describe(json.loads(result.stdout)['streams'])


def select(meta, audio_index=None, subtitle_index=None):
    available = meta.get('tracks', {})
    audio = available.get('audio', [])
    chosen_audio = next((t for t in audio if t['index'] == audio_index), None) if audio_index is not None else (
        next((t for t in audio if t['default']), None) or next(iter(audio), None))
    chosen_subtitle = next((t for t in available.get('subtitles', []) if t['index'] == subtitle_index), None)
    if audio_index is not None and chosen_audio is None:
        raise ValueError('Det valgte lydspor findes ikke i filen.')
    if subtitle_index is not None and chosen_subtitle is None:
        raise ValueError('Det valgte undertekstspor findes ikke i filen.')
    if chosen_subtitle and chosen_subtitle['delivery'] == 'unsupported':
        raise ValueError('Dette undertekstformat understøttes endnu ikke.')
    return chosen_audio, chosen_subtitle


def webvtt(path, index, cache):
    path = Path(path)
    stat = path.stat()
    key = hashlib.sha256(f'{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}:{index}'.encode()).hexdigest()
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    output = cache / f'{key}.vtt'
    if output.exists():
        return output
    if not EXTRACTIONS.acquire(blocking=False):
        raise RuntimeError('Serveren klargør andre undertekster. Prøv igen om lidt.')
    try:
        with tempfile.TemporaryDirectory(prefix='extract-', dir=cache) as folder:
            temp = Path(folder) / 'subtitles.vtt'
            result = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
                '-i', str(path), '-map', f'0:{index}', '-c:s', 'webvtt', '-f', 'webvtt', '-y', str(temp)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            if result.returncode or not temp.exists():
                raise ValueError('Underteksterne kunne ikke konverteres til browseren.')
            if temp.stat().st_size > 16 * 1024**2:
                raise ValueError('Undertekstsporet er for stort.')
            temp.replace(output)
    finally:
        EXTRACTIONS.release()
    return output
