"""Optional TMDB enrichment. Never replace technical playback metadata."""
import os
import json
import time
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
from difflib import SequenceMatcher
from datetime import date

import httpx

_db = None
_data = None
_credits_lock = threading.Lock()


def credits(info):
    """Persist one shared cast list per TMDB title, including series episodes."""
    with _credits_lock:
        return _credits(info)


def danish_character(value):
    """Translate generic credit labels while preserving character names."""
    labels = {'self': 'Sig selv', 'himself': 'Sig selv', 'herself': 'Sig selv',
              'themselves': 'Sig selv', 'host': 'Vært', 'presenter': 'Vært',
              'narrator': 'Fortæller', 'voice': 'Stemme',
              'self - host': 'Sig selv – vært', 'self - presenter': 'Sig selv – vært',
              'self - narrator': 'Sig selv – fortæller'}
    annotations = {'voice': 'stemme', 'archive footage': 'arkivoptagelser',
                   'uncredited': 'ukrediteret'}
    def translate(role):
        role = role.strip()
        base = re.split(r'\s*\(', role, maxsplit=1)[0].strip()
        translated = labels.get(base.casefold(), base)
        suffix = role[len(base):]
        suffix = re.sub(r'\((voice|archive footage|uncredited)\)',
                        lambda match: '(' + annotations[match[1].casefold()] + ')',
                        suffix, flags=re.I)
        return translated + suffix
    return ', '.join(translate(role) for role in str(value or '').split(','))


def local_portraits(cast):
    def portrait(person):
        person = dict(person)
        person['character'] = danish_character(person.get('character'))
        profile = person.get('profile_path')
        person['profile_url'] = None
        if not _data or not isinstance(profile, str) or not re.fullmatch(r'/[A-Za-z0-9]+\.jpg', profile):
            return person
        folder = _data / 'people'
        try:
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / profile[1:]
            if path.exists() or download_image(profile, path, 'w185'):
                person['profile_url'] = '/api/people/' + profile[1:]
        except (httpx.HTTPError, OSError, ValueError):
            pass
        return person
    with ThreadPoolExecutor(max_workers=4) as pool:
        return {'cast': list(pool.map(portrait, cast))}


def _credits(info):
    mid = info.get('tmdb_id')
    kind = 'tv' if info.get('media_type') == 'tv' else 'movie'
    if not isinstance(mid, int) or mid <= 0:
        return {'cast': []}
    key = f'credits:{kind}:{mid}'
    cached = None
    if _db:
        with _db() as conn:
            row = conn.execute('SELECT value FROM catalog_settings WHERE name=?', (key,)).fetchone()
        if row:
            cached = json.loads(row[0])
            return local_portraits(cached['cast'])
    token, _ = credential()
    if not token:
        return {'cast': cached['cast'] if cached else []}
    params = {'language': 'da-DK'}
    headers = {}
    if re.fullmatch(r'[a-fA-F0-9]{32}', token):
        params['api_key'] = token
    else:
        headers['Authorization'] = 'Bearer ' + token
    endpoint = 'aggregate_credits' if kind == 'tv' else 'credits'
    try:
        response = httpx.get(f'https://api.themoviedb.org/3/{kind}/{mid}/{endpoint}',
                             params=params, headers=headers, timeout=8, follow_redirects=False)
        response.raise_for_status()
        cast = []
        for person in response.json().get('cast', [])[:24]:
            profile = person.get('profile_path')
            roles = person.get('roles', [])
            cast.append({'name': str(person.get('name') or '')[:200],
                         'character': str(person.get('character') or ', '.join(r.get('character', '') for r in roles))[:300],
                         'profile_path': profile
                         if isinstance(profile, str) and re.fullmatch(r'/[A-Za-z0-9]+\.jpg', profile) else None})
    except (httpx.HTTPError, ValueError):
        if cached:
            return {'cast': cached['cast']}
        raise ValueError('Skuespillere kunne ikke hentes fra TMDB lige nu.') from None
    if _db:
        with _db() as conn:
            conn.execute('INSERT OR REPLACE INTO catalog_settings VALUES (?,?)',
                         (key, json.dumps({'fetched': time.time(), 'cast': cast})))
    return local_portraits(cast)


def init(db, data_dir=None):
    global _db, _data
    with db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS catalog_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    _db = db
    _data = Path(data_dir) if data_dir is not None else None


def credential():
    if _db:
        with _db() as conn:
            row = conn.execute("SELECT value FROM catalog_settings WHERE name='tmdb'").fetchone()
        if row is not None:
            return row[0], 'settings'
    return os.getenv('TMDB_READ_ACCESS_TOKEN', '').strip(), 'environment'


def status():
    value, source = credential()
    return {'configured': bool(value), 'source': source if value else 'none'}


def save(value):
    value = value.strip()
    if not value or len(value) > 4096 or not re.fullmatch(r'[A-Za-z0-9._-]+', value):
        raise ValueError('Indsæt en gyldig TMDB API-nøgle eller API Read Access Token.')
    with _db() as conn:
        conn.execute("INSERT OR REPLACE INTO catalog_settings VALUES ('tmdb', ?)", (value,))


def disable():
    # Explicitly disable even when an older environment credential remains configured.
    with _db() as conn:
        conn.execute("INSERT OR REPLACE INTO catalog_settings VALUES ('tmdb', '')")


def clean_title(value):
    value = re.sub(r'\.(?:mkv|mp4|m4v|avi|mov|webm|ts)$', '', value, flags=re.I)
    value = value.replace('.', ' ').replace('_', ' ')
    # A leading year can be the title (1917); a future number can be part of
    # one (Blade Runner 2049). Resolution suffixes such as 1080p are not years.
    year = next((match for match in re.finditer(r'\b(?:19|20)\d{2}\b', value)
                 if any(c.isalnum() for c in value[:match.start()])
                 and int(match.group()) <= date.today().year + 1), None)
    release = year.group() if year else None
    if year:
        value = value[:year.start()]
    parts = re.split(r'\b(?:\d{3,4}[pi]|4k|8k|uhd|bluray|blu-ray|bdrip|brrip|dvdrip|remux|web[ -]?dl|webrip|hdtv|[xh][ -]?26[45]|hevc|av1)\b', value, maxsplit=1, flags=re.I)
    value = parts[0]
    if len(parts) > 1:
        # Language/release tags immediately before quality are not title words.
        # Keep ordinary names like "The Danish Girl" intact.
        value = re.sub(r'(?:[\s()\[\]-]+(?:danish|dansk|nordic|multi|english|eng|dublado|dubbed|subbed|subs))+[\s()\[\]-]*$', '', value, flags=re.I)
    return value.strip(' ()[]-'), release


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if c.isalnum())


def identify(title):
    """Local recognition works without TMDB, including specials (season zero)."""
    match = re.search(r'(?<![a-z0-9])s(\d{1,3})[ ._-]*e(\d{1,4})(?!\d)', title, re.I)
    if not match:
        match = re.search(r'(?<![a-z0-9])(\d{1,3})x(\d{1,4})(?!\d)', title, re.I)
    if not match:
        match = re.search(r'(?<![a-z0-9])e(\d{1,4})(?![a-z0-9])', title, re.I)
        if not match:
            return {'media_type': 'movie'}
        season, episode = 1, int(match[1])
    else:
        season, episode = int(match[1]), int(match[2])
    name, year = clean_title(title[:match.start()])
    if not name or episode < 1:
        return {'media_type': 'movie'}
    return {'media_type': 'tv', 'series_title': name, 'series_year': year or '',
            'season': season, 'episode': episode, 'episode_title': '',
            'title': f'{name} · S{season:02d}E{episode:02d}'}


def file_title(path):
    """Use the containing show folder for episode-only library filenames."""
    title = path.stem.replace('_', ' ').replace('.', ' ')
    if re.match(r'^e\d{1,4}(?![a-z0-9])', title, re.I):
        parent = path.parent
        season = re.fullmatch(r'(?:season|sæson|s)[ ._-]*(\d{1,3})', parent.name, re.I)
        if season:
            parent = parent.parent
            title = f'S{int(season[1]):02d}' + title
        title = parent.name.replace('_', ' ').replace('.', ' ') + ' ' + title
    return title


def series_key(info):
    if info.get('media_type') != 'tv':
        return None
    if info.get('tmdb_id'):
        return f"tmdb:{info['tmdb_id']}"
    return 'local:' + normalized(info.get('series_title', '')) + ':' + str(info.get('series_year', ''))


def resolve_series_aliases(items):
    """Join local episodes to a unique matched series, keeping remakes separate."""
    aliases = {}
    for item in items:
        info = item['catalog']
        if info.get('media_type') != 'tv' or not info.get('tmdb_id'):
            continue
        names = [info]
        if not info.get('manual'):
            names.append(identify(item.get('original_title') or item['title']))
        for name in names:
            if name.get('media_type') == 'tv':
                alias = series_key({**name, 'tmdb_id': None})
                aliases.setdefault(alias, set()).add(item['series_key'])
    for item in items:
        choices = aliases.get(item['series_key'], set())
        if len(choices) == 1:
            item['series_key'] = next(iter(choices))


def choose_match(results, title, year, media_type='movie'):
    ranked = []
    for item in results:
        if item.get('adult') or not isinstance(item.get('id'), int):
            continue
        if year and str(item.get('first_air_date' if media_type == 'tv' else 'release_date', ''))[:4] != year:
            continue
        score = max(SequenceMatcher(None, normalized(title), normalized(item.get(k) or '')).ratio()
                    for k in (('name', 'original_name') if media_type == 'tv' else ('title', 'original_title')))
        ranked.append((score, item))
    ranked.sort(key=lambda x: x[0], reverse=True)
    # A single eligible search result needs no manual disambiguation. Filename
    # spellings such as "Troejen" can fall below the title similarity threshold.
    if len(ranked) == 1:
        return ranked[0][1]
    if not ranked or ranked[0][0] < .92:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < .08:
        return None
    return ranked[0][1]


def lookup(title, tmdb_id=None):
    identified = identify(title)
    kind = identified['media_type']
    token, _ = credential()
    if not token:
        return {**identified, 'status': 'disabled'}
    query, year = (identified['series_title'], identified['series_year']) if kind == 'tv' else clean_title(title)
    if not query:
        return {**identified, 'status': 'unmatched'}
    with httpx.Client(timeout=8, follow_redirects=False) as client:
        def get(path, **params):
            headers = {}
            if re.fullmatch(r'[a-fA-F0-9]{32}', token):
                params['api_key'] = token
            else:
                headers['Authorization'] = 'Bearer ' + token
            response = client.get('https://api.themoviedb.org/3/' + path,
                                  headers=headers,
                                  params={'language': 'da-DK', **params})
            response.raise_for_status()
            return response.json()
        params = {'query': query, 'include_adult': 'false'}
        if year:
            params['first_air_date_year' if kind == 'tv' else 'primary_release_year'] = year
        results = [] if tmdb_id is not None else get(f'search/{kind}', **params).get('results', [])
        match = {'id': tmdb_id} if tmdb_id is not None else choose_match(results, query, year, kind)
        if not match:
            candidates = []
            for item in results[:20]:
                if item.get('adult') or not isinstance(item.get('id'), int):
                    continue
                poster = item.get('poster_path')
                candidates.append({'id': item['id'], 'title': item.get('name' if kind == 'tv' else 'title') or '',
                                   'year': str(item.get('first_air_date' if kind == 'tv' else 'release_date') or '')[:4],
                                   'overview': str(item.get('overview') or '')[:600],
                                   'poster_url': f'https://image.tmdb.org/t/p/w185{poster}'
                                   if isinstance(poster, str) and re.fullmatch(r'/[A-Za-z0-9]+\.jpg', poster) else None})
            return {**identified, 'status': 'unmatched', 'candidates': candidates}
        detail = get(f"{kind}/{match['id']}")
        if not detail.get('overview'):
            try:
                english = get(f"{kind}/{match['id']}", language='en-US')
                detail['overview'] = english.get('overview', '')
            except httpx.HTTPError:
                pass
        result = {**identified, 'status': 'matched', 'tmdb_id': match['id'], 'title': detail.get('title') or query,
                'overview': detail.get('overview', ''), 'release_date': detail.get('release_date', ''),
                'genres': [g['name'] for g in detail.get('genres', [])],
                'rating': detail.get('vote_average'), 'votes': detail.get('vote_count', 0),
                'poster_path': detail.get('poster_path'), 'backdrop_path': detail.get('backdrop_path')}
        if kind == 'tv':
            result.update(series_title=detail.get('name') or query,
                          series_year=str(detail.get('first_air_date', ''))[:4],
                          series_overview=detail.get('overview', ''), episode_status='missing')
            path = f"tv/{match['id']}/season/{identified['season']}/episode/{identified['episode']}"
            try:
                ep = get(path)
                if not ep.get('overview'):
                    try:
                        ep['overview'] = get(path, language='en-US').get('overview', '')
                    except httpx.HTTPError:
                        pass
                result.update(episode_title=ep.get('name', ''), overview=ep.get('overview', ''),
                              release_date=ep.get('air_date', ''), episode_status='matched',
                              episode_path=ep.get('still_path'))
            except httpx.HTTPError:
                # Keep the series grouping/artwork even when an episode is absent from TMDB.
                result['overview'] = ''
            code = f"S{identified['season']:02d}E{identified['episode']:02d}"
            result['title'] = f"{result['series_title']} · {code}" + (f" · {result['episode_title']}" if result['episode_title'] else '')
        return result


def download_image(remote_path, destination, size):
    if not isinstance(remote_path, str) or not re.fullmatch(r'/[A-Za-z0-9]+\.jpg', remote_path):
        return False
    # Fixed CDN, no redirects, no credentials; bound downloads and only accept JPEGs.
    with httpx.stream('GET', f'https://image.tmdb.org/t/p/{size}{remote_path}', timeout=8,
                      follow_redirects=False) as response:
        response.raise_for_status()
        data = bytearray()
        for chunk in response.iter_bytes():
            data.extend(chunk)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError('Image too large')
    if not data.startswith(b'\xff\xd8\xff'):
        return False
    temporary = destination.with_suffix('.tmp')
    try:
        temporary.write_bytes(data)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def enrich(title, mid, data_dir, tmdb_id=None):
    try:
        result = lookup(title, tmdb_id=tmdb_id) if tmdb_id is not None else lookup(title)
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        reason = 'unauthorized' if code in (401, 403) else 'rate_limited' if code == 429 else 'provider_error'
        return {**identify(title), 'status': 'error', 'error_code': reason}
    except httpx.TimeoutException:
        return {**identify(title), 'status': 'error', 'error_code': 'timeout'}
    except httpx.RequestError:
        return {**identify(title), 'status': 'error', 'error_code': 'network'}
    except Exception:
        # External metadata is optional; malformed provider data must not reject video uploads.
        return {**identify(title), 'status': 'error'}
    if result['status'] == 'matched':
        try:
            credits(result)
        except (httpx.HTTPError, OSError, ValueError):
            # Optional credits must never prevent indexing or playback.
            pass
        images = [('poster_path', '', 'w500'), ('backdrop_path', '-backdrop', 'w1280')]
        if result.get('media_type') == 'tv':
            images.append(('episode_path', '-episode', 'w300'))
        for field, suffix, size in images:
            try:
                result[field.replace('_path', '_cached')] = download_image(
                    result.pop(field, None), data_dir / 'posters' / f'{mid}{suffix}.jpg', size)
            except (httpx.HTTPError, OSError, ValueError):
                result[field.replace('_path', '_cached')] = False
    return result


def message(info):
    if info.get('error_code'):
        return {
            'unauthorized': 'TMDB afviste API-nøglen. Kontrollér den under Filmoplysninger · TMDB.',
            'rate_limited': 'TMDB modtog for mange opslag. Vent lidt og prøv igen.',
            'timeout': 'TMDB svarede ikke inden tidsfristen. Prøv igen.',
            'network': 'Serveren kunne ikke oprette forbindelse til TMDB. Kontrollér serverens internetforbindelse.',
            'provider_error': 'TMDB returnerede en serverfejl. Prøv igen senere.',
        }.get(info['error_code'], 'TMDB-opslaget fejlede. Prøv igen.')
    if info.get('status') == 'matched':
        if not info.get('poster_cached') or not info.get('backdrop_cached'):
            return 'Oplysninger hentet fra TMDB, men plakat eller banner mangler. Prøv igen.'
        return 'Oplysninger, plakat og banner er hentet fra TMDB.'
    return {
        'disabled': 'TMDB-opslaget var slået fra. Gem API-nøglen under Filmoplysninger · TMDB, og prøv igen.',
        'unmatched': 'Intet entydigt match i TMDB. Prøv med seriens eller filmens originale titel og årstal.',
        'error': 'TMDB-opslaget fejlede. Prøv igen for at få en aktuel fejlstatus.',
    }.get(info.get('status'), 'Der er endnu ikke hentet oplysninger fra TMDB.')
