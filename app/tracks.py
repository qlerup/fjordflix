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


def language(value):
    value = str(value or '').strip().lower().replace('_', '-').split('-')[0]
    return {'dan':'da', 'dansk':'da', 'eng':'en', 'english':'en', 'fra':'fr', 'fre':'fr',
            'français':'fr', 'swe':'sv', 'nor':'no', 'nob':'no', 'deu':'de', 'ger':'de', 'spa':'es'}.get(value, value)


def defaults(meta, preferred, audio_index=None):
    available = displayed(meta)
    audio = available.get('audio', [])
    preferred = language(preferred)
    matching = [t for t in audio if preferred and language(t.get('language')) == preferred]
    chosen = next((t for t in audio if t['index'] == audio_index), None) if audio_index is not None else None
    if chosen is None:
        candidates = matching or audio
        chosen = next((t for t in candidates if t.get('default')), None) or next(iter(candidates), None)
    subtitle = None
    if preferred and (not chosen or language(chosen.get('language')) != preferred):
        candidates = [t for t in available.get('subtitles', []) if language(t.get('language')) == preferred and t.get('delivery') in ('text', 'burn')]
        # Full subtitles before forced-only/SDH; prefer text when equivalent so
        # browsers do not need a video transcode merely for subtitles.
        candidates.sort(key=lambda t: (bool(t.get('forced')), bool(t.get('hearing_impaired')), t.get('delivery') != 'text', not t.get('default', False)))
        subtitle = next(iter(candidates), None)
    return {'audio_track': chosen['index'] if chosen else None, 'subtitle_track': subtitle['index'] if subtitle else None}


def apply_defaults(meta, data, user):
    if not user.get('language'):
        return data
    audio_index = data.audio_track
    if 'audio_track' in data.model_fields_set and audio_index is None:
        # An explicit null audio choice means the file's default track.
        audio = displayed(meta).get('audio', [])
        chosen = next((t for t in audio if t.get('default')), None) or next(iter(audio), None)
        audio_index = chosen['index'] if chosen else None
    choices = defaults(meta, user['language'], audio_index)
    # Explicit null means "Off", not "please choose for me".
    return data.model_copy(update={k:v for k,v in choices.items() if k not in data.model_fields_set})


def displayed(meta):
    """Apply per-file labels without changing the original stream metadata."""
    available = meta.get('tracks', {})
    overrides = meta.get('audio_language_overrides', {})
    external = meta.get('external_subtitles', [])
    embedded = [t for t in available.get('subtitles', []) if not t.get('external')]
    return {**available, 'subtitles':embedded + external, 'audio': [
        {**track, 'source_language': track.get('language', 'und'),
         'language': overrides.get(str(track['index']), track.get('language', 'und'))}
        for track in available.get('audio', [])]}


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
    available = displayed(meta)
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
