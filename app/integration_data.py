"""Read-only data for FjordHub's explicitly scoped external integrations."""
import json
import copy
import os
import re
import secrets
from contextlib import closing
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Response
from fastapi.responses import FileResponse

from app import active_streams


def authorize(x_hub_key: str = Header(default='')):
    expected = os.getenv('FJORDHUB_API_KEY', '')
    if (not expected or os.getenv('FJORDHUB_APP_ID', 'fjordflix') != 'fjordflix'
            or not secrets.compare_digest(expected.encode(), x_hub_key.encode())):
        raise HTTPException(401, 'Invalid FjordHub key')


def poster_path(main, mid):
    if not re.fullmatch(r'[a-f0-9]{32}', mid):
        raise HTTPException(404)
    with closing(main.db()) as conn:
        if not conn.execute('SELECT 1 FROM movies WHERE id=?', (mid,)).fetchone():
            raise HTTPException(404)
    path = main.DATA / 'posters' / f'{mid}.jpg'
    if not path.is_file():
        raise HTTPException(404)
    return path


def snapshot(main):
    # Select only public display fields; never send media paths or credentials.
    with closing(main.db()) as conn:
        rows = conn.execute('SELECT id,title,metadata FROM movies ORDER BY created DESC, id DESC LIMIT 10').fetchall()
        total = conn.execute('SELECT count(*) FROM movies').fetchone()[0]
    items = []
    for row in rows:
        if not re.fullmatch(r'[a-f0-9]{32}', row['id']):
            continue
        try:
            meta = json.loads(row['metadata'] or '{}')
        except (ValueError, TypeError):
            meta = {}
        info = meta.get('catalog', {}) if isinstance(meta, dict) else {}
        if not isinstance(info, dict):
            info = {}
        item = {k: info[k] for k in ('overview', 'release_date', 'genres', 'rating', 'media_type',
                                     'series_title', 'season', 'episode') if k in info}
        items.append({'id': row['id'], 'title': row['title'], **item})
        if len(items) == 10:
            break
    stream_fields = ('id', 'movie_id', 'title', 'user', 'client', 'state', 'mode', 'position',
                     'duration', 'height', 'mbps', 'encoder', 'video', 'audio', 'subtitle')
    with active_streams.LOCK:
        active_streams.prune()
        streams = [copy.deepcopy({k: entry[k] for k in stream_fields if k in entry})
                   for entry in list(active_streams.LIVE.values())[:100]]
    return {'ok': True, 'generated_at': datetime.now(timezone.utc).isoformat(),
            'library_count': total, 'items': items, 'streams': streams}


def register(main):
    @main.app.get('/api/hub/integration-data', dependencies=[Depends(authorize)])
    def data(response: Response):
        response.headers['Cache-Control'] = 'no-store'
        return snapshot(main)

    @main.app.get('/api/hub/integration-data/posters/{mid}', dependencies=[Depends(authorize)])
    def poster(mid: str):
        return FileResponse(poster_path(main, mid), media_type='image/jpeg',
                            headers={'Cache-Control': 'no-store'})
