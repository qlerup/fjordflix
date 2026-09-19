"""Explicit OpenSubtitles searches and locally saved text subtitles."""
import json
import re
import secrets
import struct
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

BASE = 'https://api.opensubtitles.com/api/v1'
LIMIT = 2 * 1024**2
OFFSET = 1_000_000_000
LANGUAGES = {'da','en','sv','no','nb','de','fr','es'}


def movie_hash(path):
    with Path(path).open('rb') as stream:
        size = stream.seek(0, 2)
        if size < 131072:
            return None
        stream.seek(0)
        first = stream.read(65536)
        stream.seek(-65536, 2)
        last = stream.read(65536)
    return f'{(size + sum(struct.unpack("<8192Q", first)) + sum(struct.unpack("<8192Q", last))) & ((1 << 64) - 1):016x}'


def normalize_srt(raw):
    if not raw or len(raw) > LIMIT:
        raise ValueError('Undertekstfilen er tom eller for stor.')
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp1252')
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    timing = re.compile(r'^\d{2,3}:\d{2}:\d{2},\d{3} --> \d{2,3}:\d{2}:\d{2},\d{3}(?: .*)?$')
    blocks = []
    for block in re.split(r'\n\s*\n', text.strip()):
        lines = block.splitlines()
        if lines and lines[0].strip().isdigit(): lines.pop(0)
        if len(lines) < 2 or not timing.fullmatch(lines[0].strip()):
            raise ValueError('Tjenesten leverede ikke en gyldig SRT-undertekst.')
        blocks.append(f'{len(blocks)+1}\n' + '\n'.join(lines))
    return '\n\n'.join(blocks) + '\n'


def subtitle_path(data, mid, index):
    if not re.fullmatch(r'[a-f0-9]{32}', mid) or not isinstance(index, int) or not OFFSET < index <= OFFSET * 2:
        raise ValueError('Ugyldigt undertekstspor.')
    return Path(data) / 'subtitles' / 'downloaded' / f'{mid}-{index}.srt'


class Credentials(BaseModel):
    api_key: str = Field(min_length=1, max_length=256)
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=512)


class Download(BaseModel):
    choice: str = Field(min_length=20, max_length=100)


class OpenSubtitles:
    def __init__(self, main):
        self.main = main
        self.lock = threading.RLock()
        self.download_lock = threading.Lock()
        self.session = None
        self.choices = {}

    def credentials(self):
        with self.main.db() as conn:
            row = conn.execute("SELECT value FROM catalog_settings WHERE name='opensubtitles'").fetchone()
        return json.loads(row[0]) if row and row[0] else {}

    def status(self):
        value = self.credentials()
        return {'configured':bool(value), 'username':value.get('username','')}

    def request(self, path, method='GET', body=None, params=None, credentials=None, token='', base=BASE):
        credentials = credentials or self.credentials()
        if not credentials:
            raise ValueError('En administrator skal først tilslutte OpenSubtitles under Din server.')
        headers = {'Api-Key':credentials['api_key'], 'User-Agent':'FjordFlix v1.0', 'Accept':'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        try:
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                response = client.request(method, base + path, headers=headers, json=body, params=sorted((params or {}).items()))
            if response.status_code in (401,403):
                raise ValueError('OpenSubtitles afviste adgangen. Kontrollér API-nøgle, brugernavn og adgangskode.')
            if response.status_code in (406,429):
                raise ValueError('OpenSubtitles-kvoten er brugt, eller der er for mange forespørgsler. Prøv senere.')
            response.raise_for_status()
            result = response.json()
            if not isinstance(result,dict): raise ValueError('Uventet svar fra OpenSubtitles.')
            return result
        except (httpx.HTTPError, json.JSONDecodeError):
            raise ValueError('OpenSubtitles kunne ikke kontaktes. Prøv igen senere.') from None

    def login(self, value):
        result = self.request('/login','POST', {'username':value['username'],'password':value['password']}, credentials=value)
        token = result.get('token')
        host = str(result.get('base_url','api.opensubtitles.com')).removeprefix('https://').rstrip('/')
        if not isinstance(token,str) or not token or host not in ('api.opensubtitles.com','vip-api.opensubtitles.com'):
            raise ValueError('OpenSubtitles returnerede et ugyldigt login-svar.')
        return {'token':token, 'base':'https://' + host + '/api/v1','expires':time.time()+3600*12}

    def save(self, value):
        value['api_key'] = value['api_key'].strip()
        value['username'] = value['username'].strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]+',value['api_key']) or not value['username']:
            raise ValueError('Indtast en gyldig API-nøgle og et brugernavn.')
        with self.lock:
            session = self.login(value)
            with self.main.db() as conn:
                conn.execute("INSERT OR REPLACE INTO catalog_settings VALUES ('opensubtitles',?)",(json.dumps(value),))
            self.session = session
        return self.status()

    def authenticated(self, path, method='GET', body=None, params=None):
        with self.lock:
            value = self.credentials()
            if not value: raise ValueError('Tilslut OpenSubtitles under Din server først.')
            if not self.session or self.session['expires'] < time.time(): self.session = self.login(value)
            session = dict(self.session)
        return self.request(path,method,body,params,credentials=value,token=session['token'],base=session['base'])

    def search(self, mid, language):
        if language not in LANGUAGES: raise ValueError('Vælg et understøttet sprog.')
        row, meta = self.main.movie(mid)
        info = meta.get('catalog',{})
        params = {'languages':language, 'machine_translated':'exclude', 'ai_translated':'exclude', 'order_by':'download_count', 'order_direction':'desc'}
        fingerprint = movie_hash(row['path'])
        if fingerprint: params['moviehash'] = fingerprint
        if info.get('media_type') == 'tv':
            params.update(type='episode',season_number=info.get('season',1),episode_number=info.get('episode',1))
            if info.get('tmdb_id'): params['parent_tmdb_id'] = info['tmdb_id']
            else: params['query'] = info.get('series_title') or row['title']
        elif info.get('tmdb_id'):
            params.update(type='movie',tmdb_id=info['tmdb_id'])
        else:
            params.update(type='movie',query=row['title'])
        result = self.authenticated('/subtitles',params=params)
        found = []
        saved = {t['index'] for t in meta.get('external_subtitles',[])}
        with self.lock:
            self.choices = {key:value for key,value in self.choices.items() if value['expires'] > time.time()}
            for item in result.get('data',[])[:60]:
                attr = item.get('attributes',{})
                if attr.get('language') != language: continue
                for file in attr.get('files',[])[:5]:
                    fid = file.get('file_id')
                    if not isinstance(fid,int) or not 0 < fid <= OFFSET: continue
                    choice = secrets.token_urlsafe(24)
                    entry = {'mid':mid,'file_id':fid,'language':language,'release':str(attr.get('release') or file.get('file_name') or '')[:300],
                             'hearing_impaired':bool(attr.get('hearing_impaired')), 'forced':bool(attr.get('foreign_parts_only')),
                             'hash_match':bool(attr.get('moviehash_match')), 'expires':time.time()+900}
                    self.choices[choice] = entry
                    found.append({k:v for k,v in {**entry,'choice':choice,'downloaded':OFFSET+fid in saved}.items() if k not in ('mid','expires','file_id')})
            while len(self.choices) > 2000: self.choices.pop(next(iter(self.choices)))
        found.sort(key=lambda x:not x['hash_match'])
        return {'results':found, 'message':'Vælg samme udgave som din film. Et titelmatch garanterer ikke korrekt timing.'}

    def fetch_file(self, link):
        # Only the provider's download hosts; never forward credentials to them.
        try:
            with httpx.Client(timeout=30, follow_redirects=False) as client:
                for _ in range(4):
                    url = urlparse(link)
                    if url.scheme != 'https' or url.hostname not in ('dl.opensubtitles.com','www.opensubtitles.com','api.opensubtitles.com','vip-api.opensubtitles.com') or url.username or url.password or url.port not in (None,443):
                        raise ValueError('OpenSubtitles returnerede en ukendt downloadadresse.')
                    with client.stream('GET',link) as response:
                        if response.is_redirect:
                            from urllib.parse import urljoin
                            link = urljoin(link,response.headers.get('location','')); continue
                        response.raise_for_status()
                        content = bytearray()
                        for block in response.iter_bytes():
                            content.extend(block)
                            if len(content)>LIMIT: raise ValueError('Undertekstfilen er for stor.')
                        return normalize_srt(bytes(content))
            raise ValueError('For mange omdirigeringer ved download.')
        except (httpx.HTTPError, UnicodeError):
            raise ValueError('Undertekstfilen kunne ikke hentes eller læses.') from None

    def download(self, mid, choice):
        with self.download_lock:
            with self.lock: entry = self.choices.get(choice)
            if not entry or entry['mid'] != mid or entry['expires'] < time.time():
                raise ValueError('Søgeresultatet er udløbet. Søg efter undertekster igen.')
            _, meta = self.main.movie(mid)
            if len(meta.get('external_subtitles', [])) >= 100 and not any(t['index'] == OFFSET + entry['file_id'] for t in meta.get('external_subtitles', [])):
                raise ValueError('Denne film har allerede 100 hentede undertekstspor.')
            index = OFFSET + entry['file_id']
            path = subtitle_path(self.main.DATA,mid,index)
            if any(t['index']==index for t in meta.get('external_subtitles',[])) and path.is_file():
                return {'index':index,'cached':True}
            result = self.authenticated('/download','POST',{'file_id':entry['file_id'],'sub_format':'srt'})
            content = self.fetch_file(result.get('link',''))
            track = {'index':index,'codec':'subrip','delivery':'text','language':entry['language'],
                     'title':'OpenSubtitles · '+entry['release'], 'external':True,
                     'forced':entry['forced'],'hearing_impaired':entry['hearing_impaired'],'default':False}
            path.parent.mkdir(parents=True,exist_ok=True)
            temporary = path.with_suffix('.'+secrets.token_hex(8)+'.tmp')
            try:
                temporary.write_text(content,encoding='utf-8')
                with self.main.db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    row = conn.execute('SELECT metadata FROM movies WHERE id=?',(mid,)).fetchone()
                    if row is None: raise ValueError('Filmen blev slettet under download.')
                    current = json.loads(row['metadata'])
                    current['external_subtitles'] = [t for t in current.get('external_subtitles',[]) if t['index']!=index]+[track]
                    temporary.replace(path)
                    conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(current),mid))
            finally:
                temporary.unlink(missing_ok=True)
            return {'index':index,'cached':False,'remaining':result.get('remaining')}


def register(main):
    service = OpenSubtitles(main)
    def call(fn,*args):
        try: return fn(*args)
        except ValueError as exc: raise HTTPException(400,str(exc)) from None
        except OSError: raise HTTPException(503,'Undertekstfilen kunne ikke læses eller gemmes på serveren.') from None

    @main.app.get('/api/admin/opensubtitles')
    def status(u=Depends(main.admin)): return service.status()

    @main.app.put('/api/admin/opensubtitles')
    def settings(data: Credentials,u=Depends(main.admin)): return call(service.save,data.model_dump())

    @main.app.delete('/api/admin/opensubtitles')
    def disconnect(u=Depends(main.admin)):
        with service.lock, main.db() as conn:
            conn.execute("DELETE FROM catalog_settings WHERE name='opensubtitles'")
            service.session = None; service.choices.clear()
        return service.status()

    @main.app.get('/api/movies/{mid}/subtitle-search')
    def search(mid: str,language: str='da',u=Depends(main.admin)): return call(service.search,mid,language)

    @main.app.post('/api/movies/{mid}/subtitle-download')
    def download(mid: str,data: Download,u=Depends(main.admin)): return call(service.download,mid,data.choice)
    return service
