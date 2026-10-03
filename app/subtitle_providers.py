"""One active subtitle provider for manual searches and new library imports."""
import json
import threading
import time
from typing import Literal

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from app import tracks
from app.subdl import SubDL
from app.opensubtitles import LANGUAGES


class Settings(BaseModel):
    provider: Literal['opensubtitles','subdl']
    automatic: bool = False
    language: str = 'da'
    fallback_language: str = 'en'
    api_key: str = Field(default='',max_length=256)
    username: str = Field(default='',max_length=200)
    password: str = Field(default='',max_length=512)


class Providers:
    def __init__(self, main, opensubtitles):
        self.main = main
        self.providers = {'opensubtitles':opensubtitles,'subdl':SubDL(main)}
        # Switching the provider waits for any current search/download. Old
        # choices are invalidated, so an inactive provider cannot be charged.
        self.lock = threading.RLock()

    def config(self):
        with self.main.db() as conn:
            row = conn.execute("SELECT value FROM catalog_settings WHERE name='subtitle_provider'").fetchone()
        return json.loads(row[0]) if row else {
            'provider':'opensubtitles','automatic':False,'language':'da','fallback_language':'en'}

    def status(self):
        config = self.config()
        states = {key:service.status() for key,service in self.providers.items()}
        return {**config,'configured':states[config['provider']]['configured'],'providers':states}

    def save(self, data):
        if data.language not in LANGUAGES or data.fallback_language not in LANGUAGES | {''}:
            raise ValueError('Vælg et understøttet undertekstsprog.')
        with self.lock:
            provider = self.providers[data.provider]
            if data.api_key or data.username or data.password:
                if data.provider=='opensubtitles':
                    if not data.api_key or not data.username or not data.password:
                        raise ValueError('Udfyld API-nøgle, brugernavn og adgangskode for OpenSubtitles.')
                provider.save({'api_key':data.api_key,'username':data.username,'password':data.password})
            elif not provider.status()['configured']:
                raise ValueError('Indtast API-nøglen til den valgte udbyder først.')
            config = data.model_dump(exclude={'api_key','username','password'})
            with self.main.db() as conn:
                conn.execute("INSERT OR REPLACE INTO catalog_settings VALUES ('subtitle_provider',?)",(json.dumps(config),))
            for service in self.providers.values(): service.choices.clear()
            return self.status()

    def legacy_save(self, value):
        with self.lock:
            self.providers['opensubtitles'].save(value)
            config = self.config()
            self.save(Settings(**{**config, 'provider':'opensubtitles'}))
            return self.providers['opensubtitles'].status()

    def disconnect(self, provider=None):
        with self.lock:
            provider = provider or self.config()['provider']
            service = self.providers[provider]
            with service.lock, self.main.db() as conn:
                conn.execute('DELETE FROM catalog_settings WHERE name=?',(provider,))
                service.session = None
                service.choices.clear()
            return self.status()

    def search(self, mid, language):
        with self.lock:
            name = self.config()['provider']
            return {**self.providers[name].search(mid,language),'provider':name}

    def download(self, mid, choice):
        with self.lock:
            return self.providers[self.config()['provider']].download(mid,choice)

    def automatic(self, mid, manual=False):
        with self.lock:
            config = self.config()
            service = self.providers[config['provider']]
            if manual:
                self.main.movie(mid)
                if not service.status()['configured']:
                    raise ValueError('Tilslut en undertekstudbyder under Indstillinger → Undertekster først.')
            elif not config['automatic'] or not service.status()['configured']: return
            state = {'provider':config['provider'],'checked_at':time.time(),'status':'not_found'}
            try:
                _, meta = self.main.movie(mid)
                info = meta.get('catalog',{})
                # A filename-only guess is too weak for unattended downloads.
                if not info.get('tmdb_id'):
                    state.update(status='needs_match',message='Filmdata skal matches før automatisk hentning. Brug Find undertekster.')
                else:
                    for language in dict.fromkeys([config['language'],config['fallback_language']]):
                        if not language: continue
                        available = tracks.displayed(meta).get('subtitles',[])
                        existing = next((t for t in available if tracks.language(t.get('language'))==tracks.language(language)
                                         and t.get('delivery')=='text' and not t.get('forced')),None)
                        if existing:
                            state.update(status='available',language=language,index=existing['index'])
                            break
                        found = service.search(mid,language)['results']
                        candidates = [item for item in found if not item.get('forced')]
                        candidates.sort(key=lambda item:(not item.get('hash_match'),not item.get('release_match'),bool(item.get('hearing_impaired'))))
                        if candidates:
                            result = service.download(mid,candidates[0]['choice'])
                            state.update(status='downloaded',language=language,index=result['index'])
                            break
            except (ValueError,OSError,HTTPException):
                # Import remains successful. Never persist exception URLs/API keys.
                state.update(status='error',message='Underteksten kunne ikke hentes. Kontrollér udbyderens forbindelse/kvote, eller brug Find undertekster.')
            with self.main.db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                row = conn.execute('SELECT metadata FROM movies WHERE id=?',(mid,)).fetchone()
                if row:
                    meta = json.loads(row['metadata']); meta['subtitle_fetch'] = state
                    conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(meta),mid))
            return state

    def register(self, call):
        @self.main.app.post('/api/movies/{mid}/subtitle-fetch')
        def fetch(mid: str,u=Depends(self.main.admin)): return call(self.automatic,mid,True)

        @self.main.app.get('/api/admin/subtitles')
        def status(u=Depends(self.main.admin)): return self.status()

        @self.main.app.put('/api/admin/subtitles')
        def save(data: Settings,u=Depends(self.main.admin)): return call(self.save,data)

        @self.main.app.delete('/api/admin/subtitles')
        def disconnect(u=Depends(self.main.admin)): return self.disconnect()
