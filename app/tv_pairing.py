"""Short-lived phone approval; only the waiting Xbox can claim a TV session."""
import base64
import hashlib
import re
import secrets
import time
from contextlib import closing, contextmanager
from http.cookies import SimpleCookie
from pathlib import Path

import qrcode
from qrcode.image.svg import SvgPathImage
from fastapi import HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

PAIR_SECONDS = 300
SESSION_SECONDS = 7 * 86400
POLL_INTERVAL = 3
MAX_PAIRS = 256
MAX_RATE_KEYS = 2048
CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


class DeviceCode(BaseModel):
    device_code: str = Field(pattern=r'^[A-Za-z0-9_-]{43}$')


class Approval(BaseModel):
    user_code: str = Field(min_length=8, max_length=9)
    name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=128)


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def normalize_code(value):
    code = value.upper().replace('-', '')
    if not re.fullmatch('[' + CODE_ALPHABET + ']{8}', code):
        raise HTTPException(410, 'Koden er ugyldig eller udløbet. Vis en ny kode på Xbox.')
    return code


def attach_pairing(tv, main, page_app=None):
    """Attach to the built-in TV API or its legacy bridge using the same backend."""
    @contextmanager
    def transaction():
        with closing(main.db()) as conn:
            with conn:
                conn.execute('BEGIN IMMEDIATE')
                yield conn

    with transaction() as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS tv_login_pairs (
            device_hash TEXT PRIMARY KEY, user_hash TEXT UNIQUE NOT NULL,
            created REAL NOT NULL, expires REAL NOT NULL, proof_session TEXT)''')
        conn.execute('CREATE INDEX IF NOT EXISTS tv_login_pairs_expiry ON tv_login_pairs(expires)')
        conn.execute('''CREATE TABLE IF NOT EXISTS tv_login_rates (
            key TEXT PRIMARY KEY, expires REAL NOT NULL, attempts INTEGER NOT NULL)''')

    def cleanup(conn, now):
        conn.execute('DELETE FROM sessions WHERE token IN (SELECT proof_session FROM tv_login_pairs WHERE expires<=?)', (now,))
        conn.execute('DELETE FROM tv_login_pairs WHERE expires<=?', (now,))
        conn.execute('DELETE FROM tv_login_rates WHERE expires<=?', (now,))

    def rate_limit(request, action, limit):
        # Polling never spends the password-login attempt budget.
        key = hashed(action + ':' + (request.client.host if request.client else 'unknown'))
        now, limited = time.time(), False
        with transaction() as conn:
            cleanup(conn, now)
            row = conn.execute('SELECT attempts FROM tv_login_rates WHERE key=?', (key,)).fetchone()
            if row:
                limited = row['attempts'] >= limit
                if not limited:
                    conn.execute('UPDATE tv_login_rates SET attempts=attempts+1 WHERE key=?', (key,))
            elif conn.execute('SELECT COUNT(*) FROM tv_login_rates').fetchone()[0] >= MAX_RATE_KEYS:
                limited = True
            else:
                conn.execute('INSERT INTO tv_login_rates VALUES (?,?,1)', (key, now + PAIR_SECONDS))
        if limited:
            raise HTTPException(429, 'For mange forsøg. Vent fem minutter.', headers={'Retry-After':str(PAIR_SECONDS)})

    def verification_base(request):
        _, configured = main.media.config()
        return configured or str(request.base_url).rstrip('/')

    def approval_origin(request):
        # Approval belongs to the phone's same-origin page; browser cookies
        # are never accepted as authentication for this handoff.
        origin = request.headers.get('origin')
        if not origin or origin not in {str(request.base_url).rstrip('/'), verification_base(request)}:
            raise HTTPException(403, 'Åbn login-siden fra QR-koden på din Xbox.')

    def remove_pair(conn, device_hash):
        row = conn.execute('SELECT proof_session FROM tv_login_pairs WHERE device_hash=?', (device_hash,)).fetchone()
        if row and row['proof_session']:
            conn.execute('DELETE FROM sessions WHERE token=?', (row['proof_session'],))
        conn.execute('DELETE FROM tv_login_pairs WHERE device_hash=?', (device_hash,))

    @tv.post('/tv-api/pair/start')
    def start(request: Request):
        rate_limit(request, 'create', 10)
        now = time.time()
        device_code = secrets.token_urlsafe(32)
        code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        with transaction() as conn:
            cleanup(conn, now)
            if conn.execute('SELECT COUNT(*) FROM tv_login_pairs').fetchone()[0] >= MAX_PAIRS:
                raise HTTPException(429, 'Der er mange loginforsøg lige nu. Prøv igen om lidt.')
            while conn.execute('SELECT 1 FROM tv_login_pairs WHERE user_hash=?', (hashed(code),)).fetchone():
                code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
            conn.execute('INSERT INTO tv_login_pairs VALUES (?,?,?,?,NULL)',
                         (hashed(device_code), hashed(code), now, now + PAIR_SECONDS))
        user_code = code[:4] + '-' + code[4:]
        verification_uri = verification_base(request) + '/tv-login'
        link = verification_uri + '#code=' + user_code
        qr = qrcode.make(link, image_factory=SvgPathImage, box_size=8, border=4)
        return {'device_code':device_code, 'user_code':user_code,
                'verification_uri':verification_uri, 'verification_uri_complete':link,
                'qr_data_url':'data:image/svg+xml;base64,' + base64.b64encode(qr.to_string()).decode(),
                'expires_in':PAIR_SECONDS, 'interval':POLL_INTERVAL}

    @tv.post('/tv-api/pair/approve')
    def approve(data: Approval, request: Request):
        approval_origin(request)
        rate_limit(request, 'approve', 20)
        user_hash = hashed(normalize_code(data.user_code))
        with transaction() as conn:
            row = conn.execute('SELECT * FROM tv_login_pairs WHERE user_hash=? AND expires>?',
                               (user_hash, time.time())).fetchone()
        if not row:
            raise HTTPException(410, 'Koden er ugyldig eller udløbet. Vis en ny kode på Xbox.')
        if row['proof_session']:
            raise HTTPException(409, 'Koden er allerede godkendt. Fortsæt på Xbox.')
        # Reuse local/Hub credential checks and throttling. This private response
        # and its Set-Cookie never reach the phone; only the digest is retained.
        private_response = Response()
        main.login(main.LoginCredentials(name=data.name, password=data.password), private_response, request)
        cookie = SimpleCookie()
        cookie.load(private_response.headers['set-cookie'])
        proof = main.digest(cookie['fjordflix_session'].value)
        claimed = False
        try:
            with transaction() as conn:
                changed = conn.execute('''UPDATE tv_login_pairs SET proof_session=?
                    WHERE device_hash=? AND proof_session IS NULL AND expires>?''',
                    (proof, row['device_hash'], time.time())).rowcount == 1
                if changed:
                    conn.execute('UPDATE sessions SET expires=MIN(expires,?) WHERE token=?', (row['expires'], proof))
            claimed = changed
            if not claimed:
                raise HTTPException(410, 'Koden er udløbet eller allerede brugt. Vis en ny kode på Xbox.')
        finally:
            if not claimed:
                with transaction() as conn:
                    conn.execute('DELETE FROM sessions WHERE token=?', (proof,))
        return {'status':'approved'}

    @tv.post('/tv-api/pair/poll')
    def poll(data: DeviceCode):
        device_hash = hashed(data.device_code)
        with transaction() as conn:
            cleanup(conn, time.time())
            row = conn.execute('SELECT * FROM tv_login_pairs WHERE device_hash=?', (device_hash,)).fetchone()
        if not row:
            raise HTTPException(410, 'QR-koden er udløbet eller allerede brugt. Vis en ny kode på Xbox.')
        proof = row['proof_session']
        if not proof:
            return {'status':'pending'}
        try:
            user = main.session_user(proof)
            if main.hub.managed():
                main.hub.current(user['hub_id'], force=True)
        except HTTPException as error:
            if error.status_code in (401,403):
                with transaction() as conn:
                    remove_pair(conn, device_hash)
                raise HTTPException(410, 'Login er ikke længere gyldigt. Vis en ny kode på Xbox.') from error
            raise
        token, now = secrets.token_urlsafe(32), time.time()
        with transaction() as conn:
            # Recheck after Hub validation: cancel/expiry/another poll may win.
            current = conn.execute('''SELECT p.expires FROM tv_login_pairs p
                JOIN sessions s ON s.token=p.proof_session
                WHERE p.device_hash=? AND p.proof_session=? AND p.expires>?
                  AND s.expires>? AND s.user_id=?''',
                (device_hash, proof, now, now, user['id'])).fetchone()
            if not current:
                raise HTTPException(410, 'QR-koden er udløbet eller allerede brugt. Vis en ny kode på Xbox.')
            conn.execute('INSERT INTO sessions VALUES (?,?,?)', (main.digest(token), user['id'], now + SESSION_SECONDS))
            remove_pair(conn, device_hash)
        return {'status':'approved', 'token':token, 'expires_in':SESSION_SECONDS}

    @tv.post('/tv-api/pair/cancel')
    def cancel(data: DeviceCode):
        with transaction() as conn:
            cleanup(conn, time.time())
            remove_pair(conn, hashed(data.device_code))
        return {'ok':True}

    pages = page_app or main.app

    @pages.get('/tv-login')
    def phone_page():
        return FileResponse(Path(__file__).parent / 'static' / 'tv-login.html',
                            headers={'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'})
