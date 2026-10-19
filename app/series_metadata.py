"""Persist a chosen TV identity and refresh each episode without copying its plot."""
import json
import logging
import re
import shutil
import sqlite3
import time
import uuid

from . import catalog

SHARED=('media_type','tmdb_id','series_title','series_year','series_overview','genres','rating','votes')
logger=logging.getLogger(__name__)


def origin(meta,title):
    local=catalog.identify(meta.get('original_title') or title)
    return local if local.get('media_type')=='tv' else meta.get('catalog',{})


def choice_key(info):
    key=catalog.series_key({**info,'tmdb_id':None})
    return 'series-match:'+key if key else None


def selected_id(db,title):
    key=choice_key(catalog.identify(title))
    if key is None:return None
    with db() as conn:
        try:row=conn.execute('SELECT value FROM catalog_settings WHERE name=?',(key,)).fetchone()
        except sqlite3.OperationalError:return None
    try:
        value=json.loads(row[0]) if row else None
        return value if type(value) is int and value>0 else None
    except (TypeError,ValueError):return None


def share(host,mid,before,title,info,selected):
    if info.get('media_type')!='tv' or type(selected) is not int or selected<1:return 0
    source=origin(before,title)
    key=choice_key(source)
    if key is None:return 0
    changed=0
    with host.db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('CREATE TABLE IF NOT EXISTS catalog_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL)')
        conn.execute('INSERT OR REPLACE INTO catalog_settings VALUES (?,?)',(key,json.dumps(selected)))
        for row in conn.execute('SELECT id,title,metadata FROM movies').fetchall():
            if row['id']==mid or not re.fullmatch('[a-f0-9]{32}',row['id']):continue
            meta=json.loads(row['metadata']);old=meta.get('catalog',{})
            local=origin(meta,row['title'])
            if old.get('manual') or local.get('media_type')!='tv':continue
            if choice_key(local)!=key and old.get('tmdb_id')!=selected:continue
            episode={**local,**old}
            season,number=episode.get('season'),episode.get('episode')
            if type(season) is not int or type(number) is not int:continue
            updated={**old,**{k:info[k] for k in SHARED if k in info},
                     'media_type':'tv','tmdb_id':selected,'selected_tmdb_id':selected,
                     'season':season,'episode':number,'status':'matched',
                     'series_refresh_pending':selected,'artwork_updated':time.time()}
            if old.get('tmdb_id')!=selected or old.get('status')!='matched':
                updated.update(episode_title='',overview='',release_date='',episode_status='pending',episode_cached=False)
                (host.DATA/'posters'/f"{row['id']}-episode.jpg").unlink(missing_ok=True)
            updated.pop('last_lookup',None)
            updated.pop('candidates',None)
            updated.pop('lookup_message',None)
            name=updated.get('series_title') or source.get('series_title','')
            code=f'S{season:02d}E{number:02d}'
            updated['lookup_title']=f"{name} {updated.get('series_year','')} {code}".strip()
            updated['title']=f'{name} · {code}'+(f" · {updated['episode_title']}" if updated.get('episode_title') else '')
            for kind,suffix in (('poster',''),('backdrop','-backdrop')):
                image=host.DATA/'posters'/f'{mid}{suffix}.jpg'
                if not info.get(kind+'_cached') or not image.is_file():continue
                destination=host.DATA/'posters'/f"{row['id']}{suffix}.jpg"
                temporary=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
                try:
                    shutil.copyfile(image,temporary);temporary.replace(destination)
                    updated[kind+'_cached']=True
                finally:temporary.unlink(missing_ok=True)
            meta.setdefault('original_title',row['title'])
            meta['catalog']=updated
            conn.execute('UPDATE movies SET title=?,metadata=? WHERE id=?',(updated['title'][:160],json.dumps(meta),row['id']))
            changed+=1
    return changed


def process_one(host):
    """Pending flags survive restarts. Each episode gets its own TMDB lookup."""
    with host.db() as conn:
        rows=conn.execute("SELECT id,metadata FROM movies WHERE metadata LIKE '%\"series_refresh_pending\"%' ORDER BY created,id").fetchall()
    for row in rows:
        meta=json.loads(row['metadata']);info=meta.get('catalog',{})
        pending=info.get('series_refresh_pending')
        if not pending:continue
        try:
            if not info.get('manual') and info.get('selected_tmdb_id')==pending:
                host.refresh_movie_metadata(row['id'])
        except Exception:
            # No remote response bodies/credentials enter persisted metadata.
            logger.warning('Series episode metadata refresh failed')
        finally:
            with host.db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                current=conn.execute('SELECT metadata FROM movies WHERE id=?',(row['id'],)).fetchone()
                if current:
                    saved=json.loads(current['metadata']);details=saved.get('catalog',{})
                    if details.get('series_refresh_pending')==pending:
                        details.pop('series_refresh_pending',None)
                        conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(saved),row['id']))
        return True
    return False
