"""FjordHub is the authority for identity and app roles in managed installations."""
import os
import threading
import time
import httpx
from fastapi import HTTPException

_lock = threading.Lock()
_cache = {'expires': 0, 'users': [], 'config': None}


def managed():
    # A partial configuration must not silently enable local administrator setup.
    return bool(os.getenv('FJORDHUB_URL') or os.getenv('FJORDHUB_API_KEY'))


def call(path, payload=None, method='POST'):
    url = os.getenv('FJORDHUB_URL', '').rstrip('/')
    key = os.getenv('FJORDHUB_API_KEY', '')
    app_id = os.getenv('FJORDHUB_APP_ID', 'fjordflix')
    if not url or not key or app_id != 'fjordflix':
        raise HTTPException(503, 'FjordHub-forbindelsen er ikke korrekt konfigureret.')
    data = {**(payload or {}), 'app_id': app_id}
    try:
        with httpx.Client(timeout=5, trust_env=False) as client:
            response = client.request(method, url+path, headers={'X-Hub-Key': key}, **({'params':data} if method == 'GET' else {'json':data}))
        result = response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, 'FjordHub kan ikke kontaktes. Prøv igen om lidt.')
    if response.status_code in (401,403):
        raise HTTPException(401, 'Forkert login, udløbet SSO eller ingen adgang i FjordHub.')
    if not response.is_success or not isinstance(result, dict) or result.get('ok') is not True:
        raise HTTPException(503, 'FjordHub kunne ikke godkende forespørgslen.')
    return result


def users(force=False):
    config = (os.getenv('FJORDHUB_URL'), os.getenv('FJORDHUB_API_KEY'))
    with _lock:
        if force or _cache['config'] != config or time.monotonic() >= _cache['expires']:
            result = call('/api/hub/apps/users', method='GET')
            if not isinstance(result.get('items'),list):
                raise HTTPException(503, 'FjordHub returnerede en ugyldig brugerliste.')
            _cache.update(users=result['items'], expires=time.monotonic()+5, config=config)
        return list(_cache['users'])


def identity(value):
    try:
        uid = int(value['id'])
        username = str(value['username']).strip()
        if uid < 1 or not username or len(username)>128:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise HTTPException(503, 'FjordHub returnerede en ugyldig bruger.')
    return uid, username


def current(uid, force=False):
    for item in users(force):
        if identity(item)[0] == int(uid):
            if item.get('must_change_password'):
                raise HTTPException(403, 'Skift først din midlertidige adgangskode i FjordHub.')
            return item
    raise HTTPException(401, 'Din bruger har ikke længere adgang til FjordFlix i FjordHub.')


def local_only():
    if managed():
        raise HTTPException(403, 'Brugere, adgang og adgangskoder administreres i FjordHub.')
