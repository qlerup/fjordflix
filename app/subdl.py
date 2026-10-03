"""SubDL API adapter; download targets are bound to server-side search choices."""
import hashlib
import io
import json
import re
import secrets
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse, urljoin

import httpx
from app.opensubtitles import OpenSubtitles, LANGUAGES, LIMIT, OFFSET, normalize_srt


class SubDL(OpenSubtitles):
    name = 'SubDL'

    def credentials(self):
        with self.main.db() as conn:
            row = conn.execute("SELECT value FROM catalog_settings WHERE name='subdl'").fetchone()
        return json.loads(row[0]) if row else {}

    def status(self):
        return {'configured':bool(self.credentials())}

    def request_api(self, path, params=None, key=None):
        key = key or self.credentials().get('api_key')
        if not key:
            raise ValueError('Tilslut SubDL under Undertekster først.')
        try:
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                response = client.get('https://api.subdl.com/api/v1/'+path,
                                      params={**(params or {}),'api_key':key})
            if response.status_code in (401,403):
                raise ValueError('SubDL afviste API-nøglen.')
            if response.status_code in (402,429):
                raise ValueError('SubDL-kvoten er opbrugt. Prøv igen senere.')
            response.raise_for_status()
            result = response.json()
            if not isinstance(result,dict) or result.get('status') is False or result.get('error'):
                raise ValueError('SubDL afviste forespørgslen. Kontrollér API-nøgle og kontokvote.')
            return result
        except (httpx.HTTPError, json.JSONDecodeError):
            # HTTP exception strings can contain the API key in the query URL.
            raise ValueError('SubDL kunne ikke kontaktes. Prøv igen senere.') from None

    def save(self, value):
        key = value['api_key'].strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,256}',key):
            raise ValueError('Indtast en gyldig SubDL API-nøgle.')
        self.request_api('me',key=key)
        with self.lock, self.main.db() as conn:
            conn.execute("INSERT OR REPLACE INTO catalog_settings VALUES ('subdl',?)",(json.dumps({'api_key':key}),))
            self.choices.clear()
        return self.status()

    def track_index(self, entry):
        # Separate namespace from existing OpenSubtitles tracks, within JS's
        # exact integer range. Identity is the validated provider file path.
        return 2*OFFSET + int(hashlib.sha256(entry['link'].encode()).hexdigest()[:12],16) + 1

    @staticmethod
    def download_url(link):
        link = urljoin('https://dl.subdl.com',str(link))
        url = urlparse(link)
        if (url.scheme!='https' or url.hostname!='dl.subdl.com' or url.username or url.password
                or url.port not in (None,443) or url.query or url.fragment
                or not re.fullmatch(r'/subtitle/[A-Za-z0-9_-]+(?:\.zip|/[A-Za-z0-9_-]+)',url.path)):
            raise ValueError('SubDL returnerede en ukendt downloadadresse.')
        return link

    def search(self, mid, language):
        if language not in LANGUAGES:
            raise ValueError('Vælg et understøttet sprog.')
        row, meta = self.main.movie(mid)
        info = meta.get('catalog',{})
        code = {'nb':'NO'}.get(language,language.upper())
        params = {'languages':code,'type':'tv' if info.get('media_type')=='tv' else 'movie',
                  'subs_per_page':30,'unpack':1,'hi':1,'releases':1,'client':'custom_integration'}
        if info.get('tmdb_id'): params['tmdb_id'] = info['tmdb_id']
        else: params['film_name'] = info.get('series_title') or row['title']
        if params['type']=='tv':
            params.update(season_number=info.get('season',1),episode_number=info.get('episode',1))
        result = self.request_api('subtitles',params)
        # SubDL may broaden a search. Its subtitles belong to the first result;
        # never automatically attach a different title to an explicit TMDB ID.
        matches = result.get('results') or []
        if params.get('tmdb_id') and (not isinstance(matches,list) or not matches
                or not isinstance(matches[0],dict) or str(matches[0].get('tmdb_id'))!=str(params['tmdb_id'])):
            return {'results':[],'provider':'subdl','message':'SubDL fandt ikke et sikkert match på filmens TMDB-ID.'}
        subtitles = result.get('subtitles') or []
        if not isinstance(subtitles,list): raise ValueError('SubDL returnerede et ugyldigt søgeresultat.')
        saved = {t['index'] for t in meta.get('external_subtitles',[])}
        found = []
        with self.lock:
            self.choices = {k:v for k,v in self.choices.items() if v['expires']>time.time()}
            for item in subtitles[:30]:
                if not isinstance(item,dict): continue
                files = item.get('unpack_files') or [item]
                if not isinstance(files,list): continue
                for file in files[:100]:
                    if not isinstance(file,dict): continue
                    if file.get('format') and file['format'].lower()!='srt': continue
                    lang = str(file.get('language') or item.get('language') or code).upper()
                    if lang not in (code,{'DA':'DANISH','EN':'ENGLISH','NO':'NORWEGIAN','SV':'SWEDISH',
                                         'DE':'GERMAN','FR':'FRENCH','ES':'SPANISH'}.get(code)): continue
                    if params['type']=='tv':
                        try:
                            if int(file.get('season',item.get('season',-1)))!=int(params['season_number']): continue
                            if int(file.get('episode',item.get('episode',-1)))!=int(params['episode_number']): continue
                        except (TypeError,ValueError): continue
                        if file is item and item.get('full_season'): continue
                    try: link = self.download_url(file.get('url',''))
                    except ValueError: continue
                    release = str(file.get('release_name') or item.get('release_name') or file.get('name') or '')[:300]
                    exact = Path(row['path']).stem.casefold()==Path(release).stem.casefold()
                    entry = {'mid':mid,'link':link,'language':language,'release':release,
                             'forced':bool(file.get('forced',False)), 'hearing_impaired':bool(file.get('hi',item.get('hi',False))),
                             'hash_match':False,'release_match':exact,'expires':time.time()+900}
                    choice = secrets.token_urlsafe(24)
                    self.choices[choice] = entry
                    found.append({k:v for k,v in {**entry,'choice':choice,'downloaded':self.track_index(entry) in saved}.items()
                                  if k not in ('mid','link','expires')})
            while len(self.choices)>2000: self.choices.pop(next(iter(self.choices)))
        found.sort(key=lambda x:not x['release_match'])
        return {'results':found,'provider':'subdl','message':'Vælg samme udgave som filmen. Kontrollér timing efter download.'}

    def content(self, entry):
        link = self.download_url(entry['link'])
        try:
            with httpx.Client(timeout=30,follow_redirects=False) as client:
                with client.stream('GET',link) as response:
                    if response.status_code in (402,403,429):
                        raise ValueError('SubDL afviste download. Kontrollér kontoens downloadkvote.')
                    response.raise_for_status()
                    raw = bytearray()
                    for chunk in response.iter_bytes():
                        raw.extend(chunk)
                        if len(raw)>LIMIT: raise ValueError('Undertekstfilen er for stor.')
            if link.endswith('.zip'):
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    files = [f for f in archive.infolist() if not f.is_dir() and f.filename.lower().endswith('.srt')]
                    if len(files)!=1 or files[0].file_size>LIMIT:
                        raise ValueError('SubDL-pakken skal indeholde præcis én SRT-fil. Vælg et enkelt afsnit eller en anden udgave.')
                    # Read in memory; never extract provider-controlled paths.
                    with archive.open(files[0]) as stream: raw = stream.read(LIMIT+1)
            return normalize_srt(bytes(raw)), None
        except (httpx.HTTPError,zipfile.BadZipFile,RuntimeError,NotImplementedError,UnicodeError):
            raise ValueError('SubDL-underteksten kunne ikke hentes eller læses.') from None
