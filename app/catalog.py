"""Optional TMDB enrichment. Never replace technical playback metadata."""
import os
import re
import unicodedata
from difflib import SequenceMatcher

import httpx

_db = None


def init(db):
    global _db
    with db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS catalog_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    _db = db


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
    value = value.replace('.', ' ').replace('_', ' ')
    # A year at the start may itself be the title (e.g. 1917).
    year = re.search(r'\b(?:19|20)\d{2}\b', value[1:])
    release = year.group() if year else None
    if year:
        value = value[:year.start() + 1]
    value = re.split(r'\b(?:2160p|1080p|720p|480p|4k|bluray|blu-ray|web-dl|webrip|hdtv|x264|x265|h264|h265)\b', value, flags=re.I)[0]
    return value.strip(' ()[]-'), release


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if c.isalnum())


def identify(title):
    """Local recognition works without TMDB, including specials (season zero)."""
    match = re.search(r'(?<![a-z0-9])s(\d{1,3})[ ._-]*e(\d{1,4})(?!\d)', title, re.I)
    if not match:
        match = re.search(r'(?<![a-z0-9])(\d{1,3})x(\d{1,4})(?!\d)', title, re.I)
    if not match:
        return {'media_type': 'movie'}
    name, year = clean_title(title[:match.start()])
    if not name or int(match[2]) < 1:
        return {'media_type': 'movie'}
    season, episode = int(match[1]), int(match[2])
    return {'media_type': 'tv', 'series_title': name, 'series_year': year or '',
            'season': season, 'episode': episode, 'episode_title': '',
            'title': f'{name} · S{season:02d}E{episode:02d}'}


def series_key(info):
    if info.get('media_type') != 'tv':
        return None
    if info.get('tmdb_id'):
        return f"tmdb:{info['tmdb_id']}"
    return 'local:' + normalized(info.get('series_title', '')) + ':' + str(info.get('series_year', ''))


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
