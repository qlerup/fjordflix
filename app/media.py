"""Short-lived, scoped media grants. Web login cookies never go to the media origin."""
import hashlib
import logging
import os
import re
import secrets
import time
from urllib.parse import urlsplit

from fastapi import HTTPException

TTL = 120
_db = None

def origin(name, value=None):
    value = (os.getenv(name, '') if value is None else value).strip().rstrip('/')
    if not value:
        return ''
    parsed = urlsplit(value)
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError(f'{name} skal være en http(s)-adresse uden sti, login eller query.')
    if not re.fullmatch(r'[A-Za-z0-9.:-]+', parsed.hostname) or any(c in value for c in (';', '\\', ' ', '\r', '\n', '\t')):
        raise RuntimeError(f'{name} indeholder et ugyldigt domæne.')
    port = parsed.port
    host = parsed.hostname.lower()
    if ':' in host:
        host = f'[{host}]'
    suffix = f':{port}' if port and port != (443 if parsed.scheme == 'https' else 80) else ''
    return f'{parsed.scheme}://{host}{suffix}'

def config():
    saved = {}
    if _db:
        with _db() as conn:
            saved = {r['name']:r['value'] for r in conn.execute('SELECT * FROM media_settings')}
    direct, web = origin('MEDIA_PUBLIC_URL', saved.get('media')), origin('WEB_PUBLIC_URL', saved.get('web'))
    return validate_config(direct, web)

def validate_config(direct, web):
    if direct and (not web or direct == web):
        raise RuntimeError('Direkte video kræver forskellige MEDIA_PUBLIC_URL og WEB_PUBLIC_URL.')
    if direct and web.startswith('https:') and not direct.startswith('https:'):
        raise RuntimeError('En HTTPS-webside kræver HTTPS på den direkte videoadresse.')
    return direct, web

def key(ticket):
    return hashlib.sha256(ticket.encode()).hexdigest()


def prepare_probe(host, nonce, db):
    with db() as conn:
        conn.executemany('INSERT OR REPLACE INTO media_settings VALUES (?,?)',
                         [('probe_host', host), ('probe_nonce', nonce), ('probe_expires', str(time.time()+600))])


def connection_probe(host, db):
    with db() as conn:
        values = {r['name']:r['value'] for r in conn.execute('SELECT * FROM media_settings')}
    if host != values.get('probe_host') or float(values.get('probe_expires', '0')) < time.time():
        raise HTTPException(404, 'Ingen aktiv forbindelsestest.')
    return {'nonce': values['probe_nonce']}

def init(db):
    global _db
    with db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS media_grants (token TEXT PRIMARY KEY, login TEXT NOT NULL, movie TEXT NOT NULL, stream TEXT, expires REAL NOT NULL)')
        conn.execute('CREATE TABLE IF NOT EXISTS media_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    _db = db
    config()

def save_config(direct, web, db):
    direct, web = validate_config(origin('MEDIA_PUBLIC_URL',direct), origin('WEB_PUBLIC_URL',web))
    with db() as conn:
        conn.executemany('INSERT OR REPLACE INTO media_settings VALUES (?,?)', [('media',direct),('web',web)])
        conn.execute('DELETE FROM media_grants')

def issue(result, request, mid, db):
    direct, _ = config()
    if not direct:
        return result
    ticket = secrets.token_urlsafe(32)
    sid = result.get('session')
    with db() as conn:
        conn.execute('DELETE FROM media_grants WHERE expires < ?', (time.time(),))
        conn.execute('INSERT INTO media_grants VALUES (?,?,?,?,?)',
                     (key(ticket), key(request.cookies.get('fjordflix_session', '')), mid, sid, time.time()+TTL))
    path = f'streams/{sid}/index.m3u8' if sid else f'movies/{mid}/file'
    return {**result, 'url': f'{direct}/media/{ticket}/{path}', 'media_ticket': ticket, 'media_expires_in': TTL, 'delivery': 'direct'}

def validate(ticket, db, session_user, *, mid=None, sid=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', ticket):
        raise HTTPException(401, 'Ugyldig videobillet.')
    with db() as conn:
        grant = conn.execute('SELECT * FROM media_grants WHERE token=? AND expires>?', (key(ticket), time.time())).fetchone()
    if not grant:
        raise HTTPException(401, 'Videobilletten er udløbet. Start filmen igen.')
    if mid is not None and (grant['movie'] != mid or grant['stream'] is not None) or sid is not None and grant['stream'] != sid:
        raise HTTPException(403, 'Videobilletten gælder ikke denne film eller stream.')
    return session_user(grant['login'])

def renew(ticket, request, db, revoke=False):
    with db() as conn:
        args = (key(ticket), key(request.cookies.get('fjordflix_session', '')), time.time())
        if revoke:
            conn.execute('DELETE FROM media_grants WHERE token=? AND login=? AND expires>?', args)
        else:
            changed = conn.execute('UPDATE media_grants SET expires=? WHERE token=? AND login=? AND expires>?', (time.time()+TTL, *args)).rowcount
            if not changed:
                raise HTTPException(410, 'Videobilletten er udløbet. Start filmen igen.')

class RedactMediaTickets(logging.Filter):
    def filter(self, record):
        # Uvicorn's request path otherwise exposes bearer tickets in access logs.
        if isinstance(record.args, tuple):
            record.args = tuple(re.sub(r'/media/[A-Za-z0-9_-]{43}/', '/media/[redacted]/', value) if isinstance(value, str) else value for value in record.args)
        return True

logging.getLogger('uvicorn.access').addFilter(RedactMediaTickets())
