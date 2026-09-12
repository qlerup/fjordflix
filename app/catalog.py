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


def choose_match(results, title, year):
    ranked = []
    for item in results:
        if item.get('adult') or not isinstance(item.get('id'), int):
            continue
        if year and str(item.get('release_date', ''))[:4] != year:
            continue
        score = max(SequenceMatcher(None, normalized(title), normalized(item.get(k) or '')).ratio()
                    for k in ('title', 'original_title'))
        ranked.append((score, item))
    ranked.sort(key=lambda x: x[0], reverse=True)
    if not ranked or ranked[0][0] < .92:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < .08:
        return None
    return ranked[0][1]


def lookup(title):
    token, _ = credential()
    if not token:
        return {'status': 'disabled'}
    query, year = clean_title(title)
    # Episode filenames should not be matched against unrelated films.
    if not query or re.search(r'\bS\d{1,2}E\d{1,3}\b', title, re.I):
        return {'status': 'unmatched'}
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
            params['primary_release_year'] = year
        match = choose_match(get('search/movie', **params).get('results', []), query, year)
        if not match:
            return {'status': 'unmatched'}
        detail = get(f"movie/{match['id']}")
        if not detail.get('overview'):
            english = get(f"movie/{match['id']}", language='en-US')
            detail['overview'] = english.get('overview', '')
        return {'status': 'matched', 'tmdb_id': match['id'], 'title': detail.get('title') or query,
                'overview': detail.get('overview', ''), 'release_date': detail.get('release_date', ''),
                'genres': [g['name'] for g in detail.get('genres', [])],
                'rating': detail.get('vote_average'), 'votes': detail.get('vote_count', 0),
                'poster_path': detail.get('poster_path'), 'backdrop_path': detail.get('backdrop_path')}


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


def enrich(title, mid, data_dir):
    try:
        result = lookup(title)
    except Exception:
        # External metadata is optional; malformed provider data must not reject video uploads.
        return {'status': 'error'}
    if result['status'] == 'matched':
        for field, suffix, size in [('poster_path', '', 'w500'), ('backdrop_path', '-backdrop', 'w1280')]:
            try:
                result[field.replace('_path', '_cached')] = download_image(
                    result.pop(field, None), data_dir / 'posters' / f'{mid}{suffix}.jpg', size)
            except (httpx.HTTPError, OSError, ValueError):
                result[field.replace('_path', '_cached')] = False
    return result
