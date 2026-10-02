"""Short-lived playback presence, separate from transcoder process lifetime."""
import copy
import secrets
import threading
import time
from typing import Literal

from fastapi import Depends, HTTPException, Response
from pydantic import BaseModel, Field

LOCK = threading.RLock()
LIVE = {}
TTL = 120


class Status(BaseModel):
    position: float = Field(ge=0, le=1e8, allow_inf_nan=False)
    state: Literal['playing', 'paused', 'buffering', 'ended', 'error'] = 'playing'
    subtitle_track: int | None = Field(default=None, ge=0)
    audio_ordinal: int | None = Field(default=None, ge=0)
    subtitle_ordinal: int | None = Field(default=None, ge=0)


def prune():
    now = time.time()
    for key in list(LIVE):
        if now - LIVE[key]['touch'] > TTL:
            del LIVE[key]


def track_summary(track):
    if not track:
        return None
    return {k: track.get(k) for k in ('index', 'codec', 'language', 'title', 'channels', 'layout')}


def begin(result, row, meta, user, data, audio, subtitle, *, native=False, audio_copy=False):
    key = secrets.token_hex(16)
    mode = 'Direct Play' if native else result['mode']
    from app.tracks import displayed
    available = displayed(meta)
    subs = [t for t in available.get('subtitles', []) if not t.get('external')]
    if native and subtitle and subtitle.get('external'):
        subs.append(subtitle)
    entry = {
        'id': key, 'user_id': user['id'], 'user': user['name'], 'movie_id': row['id'],
        'title': row['title'], 'poster': f"/api/movies/{row['id']}/poster",
        'duration': meta.get('duration', 0), 'position': min(data.start, meta.get('duration', 0)),
        'state': 'starting', 'client': 'Windows-app' if native else 'AirPlay' if data.airplay else 'Browser',
        'mode': mode, 'height': result.get('height', meta.get('height')),
        'mbps': result.get('mbps', round(meta.get('bitrate', 0) / 1e6, 1)),
        'video': {'source': meta.get('video', 'unknown'), 'output': 'h264' if mode == 'Transcoding' else meta.get('video', 'unknown'), 'transcoded': mode == 'Transcoding', 'tonemapped': bool(meta.get('hdr') and mode == 'Transcoding')},
        'audio': track_summary(audio), 'audio_transcoded': bool(audio and mode != 'Direct Play' and not audio_copy),
        'subtitle': track_summary(subtitle),
        'subtitle_delivery': 'local' if native and subtitle else result.get('subtitle_delivery'),
        'encoder': 'Original · afspilles lokalt' if native else result.get('encoder', 'Original'),
        'reason': result.get('reason', ''), 'touch': time.time(), 'native': native,
        'session': result.get('session'), '_audio': available.get('audio', []), '_subs': subs,
        '_all_subs': available.get('subtitles', []),
    }
    with LOCK:
        prune()
        LIVE[key] = entry
    return {**result, 'playback_id': key}


def remove_session(session):
    with LOCK:
        for key in list(LIVE):
            if LIVE[key]['session'] == session:
                del LIVE[key]


def bind_tv(key, ticket, login):
    from app.media import key as digest
    with LOCK:
        item = LIVE.get(key)
        if item:
            item.update(client='LG TV', state='connected', limited_status=True,
                        _ticket=digest(ticket), _login=digest(login))


def tv_touch(ticket, *, stop=False):
    from app.media import key as digest
    with LOCK:
        for key in list(LIVE):
            if LIVE[key].get('_ticket') == digest(ticket):
                if stop:
                    del LIVE[key]
                else:
                    LIVE[key]['touch'] = time.time()


def tv_progress(login, mid, position):
    from app.media import key as digest
    with LOCK:
        candidates = [x for x in LIVE.values() if x.get('_login') == digest(login) and x['movie_id'] == mid]
        # Older TV clients do not identify the playback in progress reports.
        # Never assign one device's position to multiple concurrent streams.
        if len(candidates) == 1:
            candidates[0].update(position=min(position, candidates[0]['duration']), touch=time.time())


def register(main):
    @main.app.get('/api/admin/active-streams')
    def listing(response: Response, u=Depends(main.admin)):
        response.headers['Cache-Control'] = 'no-store'
        with LOCK:
            prune()
            return {'streams': [copy.deepcopy({k: v for k, v in item.items() if not k.startswith('_') and k not in ('session', 'user_id', 'native')}) for item in LIVE.values()]}

    @main.app.post('/api/playbacks/{key}/heartbeat')
    def heartbeat(key: str, data: Status, u=Depends(main.user)):
        with LOCK:
            prune()
            item = LIVE.get(key)
            if not item or item['user_id'] != u['id']:
                raise HTTPException(404)
            if data.state == 'ended':
                del LIVE[key]
                return {'ok': True}
            updates = {}
            if item['native']:
                for name, ordinal in [('audio', data.audio_ordinal), ('subtitle', data.subtitle_ordinal)]:
                    if ordinal is None:
                        continue
                    rows = item['_audio' if name == 'audio' else '_subs']
                    if ordinal > len(rows):
                        raise HTTPException(400, 'Ukendt spor.')
                    updates[name] = track_summary(rows[ordinal-1]) if ordinal else None
                if 'subtitle' in updates:
                    updates['subtitle_delivery'] = 'local' if updates['subtitle'] else None
            elif 'subtitle_track' in data.model_fields_set and item['subtitle_delivery'] not in ('burn', 'hls'):
                chosen = next((t for t in item['_all_subs'] if t['index'] == data.subtitle_track and t.get('delivery') == 'text'), None)
                if data.subtitle_track is not None and chosen is None:
                    raise HTTPException(400, 'Ukendt tekstspor.')
                updates.update(subtitle=track_summary(chosen), subtitle_delivery='text' if chosen else None)
            item.update(updates, position=min(data.position, item['duration']), state=data.state, touch=time.time())
        return {'ok': True}

    @main.app.post('/api/playbacks/{key}/stop')
    def stop(key: str, u=Depends(main.user)):
        with LOCK:
            item = LIVE.get(key)
            if item and item['user_id'] != u['id']:
                raise HTTPException(404)
            LIVE.pop(key, None)
        return {'ok': True}
