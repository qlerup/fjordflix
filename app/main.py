import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from app import hub, media, demos

DATA = Path(os.getenv('DATA_DIR', './data'))
MEDIA = Path(os.getenv('MEDIA_DIR', str(DATA / 'media')))
MEDIA.mkdir(parents=True, exist_ok=True)
for folder in ('media', 'posters', 'streams'):
    (DATA / folder).mkdir(parents=True, exist_ok=True)
PASSWORDS = PasswordHasher()
JOBS = {}
LOCK = threading.RLock()
GPU = False
ATTEMPTS = {}


def db():
    conn = sqlite3.connect(DATA / 'fjordflix.db', timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


with db() as conn:
    conn.executescript('''
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, password TEXT, admin INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires REAL);
    CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY, created REAL);
    CREATE TABLE IF NOT EXISTS movies(id TEXT PRIMARY KEY, title TEXT, path TEXT, metadata TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS progress(user_id TEXT, movie_id TEXT, position REAL, favorite INTEGER DEFAULT 0, PRIMARY KEY(user_id,movie_id));
    ''')
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(users)')}
    if 'hub_id' not in columns:
        conn.execute('ALTER TABLE users ADD COLUMN hub_id INTEGER')
        conn.execute('ALTER TABLE users ADD COLUMN hub_username TEXT')
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_hub_id ON users(hub_id) WHERE hub_id IS NOT NULL')


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


media.init(db)


def stop_job(key):
    with LOCK:
        job = JOBS.pop(key, None)
        if job:
            if job['process'].poll() is None:
                job['process'].terminate()
                try:
                    job['process'].wait(timeout=5)
                except subprocess.TimeoutExpired:
                    job['process'].kill()
                    job['process'].wait()
            job['log'].close()
            shutil.rmtree(job['folder'], ignore_errors=True)


@asynccontextmanager
async def lifespan(app):
    global GPU
    if os.getenv('TRANSCODE_DEVICE', 'auto') != 'cpu':
        try:
            check = await asyncio.to_thread(subprocess.run, ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=640x360:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], capture_output=True, timeout=15)
            GPU = check.returncode == 0
        except subprocess.TimeoutExpired:
            GPU = False
    else:
        GPU = False
    for old in (DATA / 'streams').iterdir():
        if old.is_dir():
            shutil.rmtree(old)
    async def cleanup():
        while True:
            await asyncio.sleep(30)
            with LOCK:
                expired = [key for key, job in JOBS.items() if time.time() - job['touch'] > 120]
            for key in expired:
                await asyncio.to_thread(stop_job, key)
            with db() as conn:
                conn.execute('DELETE FROM sessions WHERE expires < ?', (time.time(),))
    task = asyncio.create_task(cleanup())
    yield
    task.cancel()
    for key in list(JOBS):
        stop_job(key)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware('http')
async def security(request, call_next):
    direct, web_origin = media.config()
    is_media = request.url.path.startswith('/media/')
    is_probe = request.url.path == '/media/connection-check'
    if is_media:
        if (not is_probe and (not direct or request.headers.get('host', '').lower() != urlparse(direct).netloc.lower())) or request.headers.get('cf-ray') or request.headers.get('cf-connecting-ip'):
            return Response('Video skal hentes via den direkte videoadresse uden Cloudflare.', status_code=403)
        if not is_probe and request.headers.get('origin') not in (None, web_origin):
            return Response('Ugyldig video-oprindelse.', status_code=403)
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            return Response(status_code=405)
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if (origin and urlparse(origin).netloc != request.headers.get('host')) or request.headers.get('sec-fetch-site') == 'cross-site':
            return Response('Ugyldig oprindelse', status_code=403)
    response = Response(status_code=204) if is_media and request.method == 'OPTIONS' else await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: {direct}; connect-src 'self' {direct}; worker-src 'self' blob:; frame-ancestors 'none'"
    if request.url.path.startswith('/api') or is_media or request.url.path in ('/', '/remote'):
        response.headers['Cache-Control'] = 'no-store'
    if is_media:
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Access-Control-Allow-Origin'] = web_origin
        response.headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Range'
        response.headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges'
        response.headers['Vary'] = 'Origin'
    return response


def session_user(token):
    with db() as conn:
        row = conn.execute('SELECT u.id,u.name,u.admin,u.hub_id,u.hub_username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', (token, time.time())).fetchone()
    if not row:
        raise HTTPException(401, 'Log ind for at fortsætte.')
    if hub.managed():
        if row['hub_id'] is None:
            raise HTTPException(401, 'Log ind med din FjordHub-bruger.')
        try:
            profile = hub.current(row['hub_id'])
        except HTTPException as exc:
            if exc.status_code in (401,403):
                with db() as conn:
                    conn.execute('DELETE FROM sessions WHERE user_id=?', (row['id'],))
            raise
        return {'id':row['id'], 'name':profile['username'], 'admin':profile.get('role') == 'admin'}
    if row['hub_id'] is not None:
        raise HTTPException(401, 'Denne bruger kræver en FjordHub-forbindelse.')
    return {'id':row['id'], 'name':row['name'], 'admin':row['admin']}


def user(request: Request):
    return session_user(digest(request.cookies.get('fjordflix_session', '')))


def sync_hub_user(profile):
    hub_id, username = hub.identity(profile)
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute('SELECT id FROM users WHERE hub_id=?', (hub_id,)).fetchone()
        uid = existing['id'] if existing else secrets.token_hex(16)
        if existing:
            conn.execute('UPDATE users SET hub_username=?,admin=? WHERE id=?', (username, profile.get('role') == 'admin', uid))
        else:
            # Never merge into a local account just because a username matches.
            conn.execute('INSERT INTO users(id,name,password,admin,hub_id,hub_username) VALUES (?,?,?,?,?,?)', (uid, f'@hub:{hub_id}:{uid}', 'fjordhub-managed', profile.get('role') == 'admin', hub_id, username))
    return uid


def admin(u=Depends(user)):
    if not u['admin']:
        raise HTTPException(403, 'Kun administratoren har adgang.')
    return u


class Credentials(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=10, max_length=128)
    invite: str = ''


class LoginCredentials(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=128)


def session(response, uid):
    token = secrets.token_urlsafe(32)
    with db() as conn:
        conn.execute('INSERT INTO sessions VALUES (?,?,?)', (digest(token), uid, time.time() + 86400 * 7))
    response.set_cookie('fjordflix_session', token, httponly=True, samesite='lax', max_age=86400 * 7, secure=os.getenv('SECURE_COOKIES') == '1')


def throttle(request):
    ip = request.client.host
    now = time.time()
    with LOCK:
        recent = [t for t in ATTEMPTS.get(ip, []) if now - t < 300]
        if len(recent) >= 20:
            raise HTTPException(429, 'For mange forsøg. Vent fem minutter.')
        ATTEMPTS[ip] = recent + [now]


@app.get('/api/health')
def health():
    return {'ok': True}


@app.get('/api/state')
def state(request: Request):
    with db() as conn:
        setup = not hub.managed() and conn.execute('SELECT COUNT(*) FROM users WHERE hub_id IS NULL').fetchone()[0] == 0
    try:
        current = user(request)
    except HTTPException as exc:
        if exc.status_code not in (401,403):
            raise
        current = None
    return {'setup': setup, 'user': current, 'gpu': GPU, 'managed': hub.managed()}


@app.post('/api/setup')
def setup(data: Credentials, response: Response, request: Request):
    hub.local_only()
    throttle(request)
    uid = secrets.token_hex(16)
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if conn.execute('SELECT COUNT(*) FROM users WHERE hub_id IS NULL').fetchone()[0]:
            raise HTTPException(409, 'Serveren er allerede opsat.')
        name = data.name.strip()
        if len(name) < 2:
            raise HTTPException(400, 'Navnet skal være mindst to tegn.')
        conn.execute('INSERT INTO users(id,name,password,admin) VALUES (?,?,?,1)', (uid, name, PASSWORDS.hash(data.password)))
    session(response, uid)
    return {'ok': True}


@app.post('/api/login')
def login(data: LoginCredentials, response: Response, request: Request):
    throttle(request)
    if hub.managed():
        result = hub.call('/api/hub/apps/authenticate', {'username':data.name.strip(), 'password':data.password})
        profile = result.get('user')
        if not isinstance(profile, dict):
            raise HTTPException(503, 'FjordHub returnerede en ugyldig bruger.')
        if profile.get('must_change_password'):
            raise HTTPException(403, 'Skift først din midlertidige adgangskode i FjordHub.')
        profile = hub.current(hub.identity(profile)[0], force=True)
        session(response, sync_hub_user(profile))
        return {'ok': True}
    with db() as conn:
        row = conn.execute('SELECT * FROM users WHERE name=? AND hub_id IS NULL', (data.name.strip(),)).fetchone()
    try:
        if not row:
            PASSWORDS.hash(data.password)
            raise HTTPException(401, 'Forkert brugernavn eller adgangskode.')
        PASSWORDS.verify(row['password'], data.password)
    except VerificationError:
        raise HTTPException(401, 'Forkert brugernavn eller adgangskode.')
    session(response, row['id'])
    return {'ok': True}


@app.get('/hub-login')
def hub_login(token: str = ''):
    if not hub.managed():
        raise HTTPException(404)
    if not token or len(token)>256:
        raise HTTPException(400, 'SSO-token mangler eller er ugyldigt.')
    result = hub.call('/api/hub/sso-verify', {'token':token}, method='GET')
    profile = hub.current(hub.identity(result)[0], force=True)
    response = RedirectResponse('/', status_code=303, headers={'Cache-Control':'no-store'})
    session(response, sync_hub_user(profile))
    return response


@app.post('/api/register')
def register(data: Credentials, response: Response, request: Request):
    hub.local_only()
    throttle(request)
    uid = secrets.token_hex(16)
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        invite = conn.execute('SELECT * FROM invites WHERE token=? AND created>?', (digest(data.invite), time.time() - 86400 * 7)).fetchone()
        if not invite:
            raise HTTPException(400, 'Invitationen er ugyldig eller udløbet.')
        if len(data.name.strip()) < 2:
            raise HTTPException(400, 'Navnet skal være mindst to tegn.')
        try:
            conn.execute('INSERT INTO users(id,name,password,admin) VALUES (?,?,?,0)', (uid, data.name.strip(), PASSWORDS.hash(data.password)))
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'Brugernavnet er allerede i brug.')
        conn.execute('DELETE FROM invites WHERE token=?', (digest(data.invite),))
    session(response, uid)
    return {'ok': True}


@app.post('/api/logout')
def logout(request: Request, response: Response, u=Depends(user)):
    with db() as conn:
        conn.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies.get('fjordflix_session', '')),))
    response.delete_cookie('fjordflix_session')
    return {'ok': True}


@app.post('/api/invites')
def invite(u=Depends(admin)):
    hub.local_only()
    token = secrets.token_urlsafe(24)
    with db() as conn:
        conn.execute('INSERT INTO invites VALUES (?,?)', (digest(token), time.time()))
    return {'token': token}


@app.get('/api/admin')
def dashboard(u=Depends(admin)):
    if hub.managed():
        users = [{'id':str(x['id']), 'name':x['username'], 'admin':x.get('role') == 'admin'} for x in hub.users()]
    else:
        with db() as conn:
            users = [dict(x) for x in conn.execute('SELECT id,name,admin FROM users WHERE hub_id IS NULL')]
    disk = shutil.disk_usage(DATA)
    with LOCK:
        active = len(JOBS)
    return {'users': users, 'gpu': GPU, 'streams': active, 'free_gb': round(disk.free / 1024**3, 1), 'max_streams': int(os.getenv('MAX_TRANSCODES', 3))}


@app.get('/api/admin/media')
def media_settings(request: Request, u=Depends(admin)):
    direct, web = media.config()
    hub_url = ''
    if hub.managed():
        try:
            hub_url = hub.call('/api/hub/apps/config', method='GET').get('external_url', '')
        except HTTPException:
            pass
    return {'media_url':direct, 'web_url':web or hub_url or str(request.base_url).rstrip('/'), 'hub_url':hub_url, 'enabled':bool(direct)}


class MediaSettings(BaseModel):
    web_url: str = Field(max_length=300)
    media_url: str = Field(default='', max_length=300)


@app.put('/api/admin/media')
def save_media_settings(data: MediaSettings, u=Depends(admin)):
    try:
        media.save_config(data.media_url, data.web_url, db)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    return {'ok':True}


def probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', str(path)], capture_output=True, timeout=60)
    if result.returncode:
        raise HTTPException(400, 'Filen kunne ikke læses som en video.')
    info = json.loads(result.stdout)
    video = next((s for s in info['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')), None)
    audio = next((s for s in info['streams'] if s['codec_type'] == 'audio'), {})
    if not video or not video.get('width'):
        raise HTTPException(400, 'Filen indeholder ikke et videospor.')
    duration = float(info['format'].get('duration', 0))
    return {'width': video['width'], 'height': video['height'], 'video': video['codec_name'], 'audio': audio.get('codec_name'), 'duration': duration, 'bitrate': int(info['format'].get('bit_rate', 0)), 'hdr': video.get('color_transfer') in ('smpte2084', 'arib-std-b67'), 'pix_fmt': video.get('pix_fmt', ''), 'format': info['format'].get('format_name', ''), 'size': path.stat().st_size}


def index_movie(path, title, mid):
    meta = probe(path)
    subprocess.run(['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-ss', str(min(2, meta['duration'] / 3)), '-i', str(path), '-frames:v', '1', '-vf', 'scale=960:-2', '-y', str(DATA / 'posters' / f'{mid}.jpg')], capture_output=True, timeout=60)
    with db() as conn:
        conn.execute('INSERT INTO movies VALUES (?,?,?,?,?)', (mid, title[:160], str(path), json.dumps(meta), time.time()))
    return mid


@app.put('/api/upload')
async def upload(request: Request, filename: str, u=Depends(admin)):
    suffix = Path(filename).suffix.lower()
    if suffix not in ('.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.ts'):
        raise HTTPException(400, 'Vælg en MP4, MKV, MOV, WebM, M4V, AVI eller TS-fil.')
    mid = secrets.token_hex(16)
    path = MEDIA / f'{mid}{suffix}'
    size = 0
    try:
        with path.open('wb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 100 * 1024**3:
                    raise HTTPException(413, 'Betaen tillader højst 100 GB pr. film.')
                if shutil.disk_usage(MEDIA).free < len(chunk) + 512 * 1024**2:
                    raise HTTPException(507, 'Serveren mangler ledig diskplads.')
                await asyncio.to_thread(output.write, chunk)
        await asyncio.to_thread(index_movie, path, Path(filename).stem.replace('_', ' ').replace('.', ' '), mid)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return {'id': mid}


DEMO_LOCK = threading.Lock()
DEMO_PACK_LOCK = threading.Lock()
DEMO_PACK = {'running': False, 'completed': 0, 'error': ''}
STRESS_DEMO = {'running': False, 'id': None, 'error': ''}


def generate_stress_demo():
    path = None
    try:
        with db() as conn:
            existing = conn.execute('SELECT id FROM movies WHERE title=?', (demos.STRESS_TITLE,)).fetchone()
        if existing:
            mid = existing['id']
        else:
            if shutil.disk_usage(MEDIA).free < 2 * 1024**3:
                raise RuntimeError('Der skal være mindst 2 GB ledig plads.')
            mid = secrets.token_hex(16)
            path = MEDIA / f'{mid}.mp4'
            demos.generate_stress(path, GPU)
            meta = probe(path)
            if not 110_000_000 <= meta['bitrate'] <= 130_000_000:
                raise RuntimeError('Testfilmen ramte ikke den ønskede bitrate. Prøv igen.')
            index_movie(path, demos.STRESS_TITLE, mid)
        with DEMO_PACK_LOCK:
            STRESS_DEMO['id'] = mid
    except Exception as exc:
        if path:
            path.unlink(missing_ok=True)
        with DEMO_PACK_LOCK:
            STRESS_DEMO['error'] = str(exc) if isinstance(exc, RuntimeError) else 'Testfilmen kunne ikke genereres. Tjek serverens plads og GPU, og prøv igen.'
    finally:
        with DEMO_PACK_LOCK:
            STRESS_DEMO['running'] = False


@app.get('/api/demo-stress')
def stress_demo_status(u=Depends(admin)):
    with DEMO_PACK_LOCK:
        return dict(STRESS_DEMO)


@app.post('/api/demo-stress')
def stress_demo_start(u=Depends(admin)):
    with DEMO_PACK_LOCK:
        if not STRESS_DEMO['running']:
            STRESS_DEMO.update(running=True, id=None, error='')
            threading.Thread(target=generate_stress_demo, daemon=True).start()
        return dict(STRESS_DEMO)


def generate_demo_pack():
    try:
        for number, spec in enumerate(demos.CATALOG):
            with db() as conn:
                exists = conn.execute('SELECT id FROM movies WHERE title=?', (spec[1],)).fetchone()
            if not exists:
                mid = secrets.token_hex(16)
                path = MEDIA / f'{mid}.mp4'
                try:
                    if shutil.disk_usage(MEDIA).free < 1024**3:
                        raise RuntimeError('Der skal være mindst 1 GB ledig plads til testfilmene.')
                    demos.generate(spec, path, GPU)
                    index_movie(path, spec[1], mid)
                except Exception:
                    path.unlink(missing_ok=True)
                    raise
            with DEMO_PACK_LOCK:
                DEMO_PACK['completed'] = number + 1
    except Exception:
        with DEMO_PACK_LOCK:
            DEMO_PACK['error'] = 'Testfilmene kunne ikke færdiggøres. Tjek ledig plads og prøv igen.'
    finally:
        with DEMO_PACK_LOCK:
            DEMO_PACK['running'] = False


@app.get('/api/demo-pack')
def demo_pack_status(u=Depends(admin)):
    with DEMO_PACK_LOCK:
        return dict(DEMO_PACK)


@app.post('/api/demo-pack')
def demo_pack_start(u=Depends(admin)):
    with DEMO_PACK_LOCK:
        if not DEMO_PACK['running']:
            DEMO_PACK.update(running=True, completed=0, error='')
            threading.Thread(target=generate_demo_pack, daemon=True).start()
        return dict(DEMO_PACK)


@app.post('/api/demo')
def demo(u=Depends(admin)):
    with DEMO_LOCK:
        with db() as conn:
            existing = conn.execute("SELECT id FROM movies WHERE title='Nordlys · 4K testfilm'").fetchone()
        if existing:
            return {'id': existing['id']}
        mid = secrets.token_hex(16)
        path = MEDIA / f'{mid}.mp4'
        command = ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '12', '-c:v', 'h264_nvenc' if GPU else 'libx264', '-preset', 'fast' if GPU else 'ultrafast', '-b:v', '35M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', str(path)]
        result = subprocess.run(command, capture_output=True, timeout=180)
        if result.returncode:
            path.unlink(missing_ok=True)
            raise HTTPException(500, 'Testfilmen kunne ikke genereres.')
        index_movie(path, 'Nordlys · 4K testfilm', mid)
        return {'id': mid}


@app.get('/api/movies')
def movies(u=Depends(user)):
    with db() as conn:
        rows = conn.execute('SELECT m.*,COALESCE(p.position,0) position,COALESCE(p.favorite,0) favorite FROM movies m LEFT JOIN progress p ON p.movie_id=m.id AND p.user_id=? ORDER BY m.created DESC', (u['id'],)).fetchall()
    return [dict(id=r['id'], title=r['title'], **json.loads(r['metadata']), position=r['position'], favorite=bool(r['favorite'])) for r in rows]


def movie(mid):
    with db() as conn:
        row = conn.execute('SELECT * FROM movies WHERE id=?', (mid,)).fetchone()
    if not row:
        raise HTTPException(404, 'Filmen findes ikke.')
    return dict(row), json.loads(row['metadata'])


@app.get('/api/movies/{mid}/poster')
def poster(mid: str, u=Depends(user)):
    movie(mid)
    path = DATA / 'posters' / f'{mid}.jpg'
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


@app.get('/api/movies/{mid}/file')
def original(mid: str, u=Depends(user)):
    if media.config()[0]:
        raise HTTPException(409, 'Start afspilning for at få en direkte videobillet.')
    return original_file(mid)


def original_file(mid):
    row, meta = movie(mid)
    return FileResponse(row['path'], media_type='video/webm' if 'webm' in meta['format'] else 'video/mp4')


class Progress(BaseModel):
    position: float = Field(ge=0, le=1e8)


@app.post('/api/movies/{mid}/progress')
def progress(mid: str, data: Progress, u=Depends(user)):
    _, meta = movie(mid)
    with db() as conn:
        conn.execute('INSERT INTO progress(user_id,movie_id,position) VALUES (?,?,?) ON CONFLICT(user_id,movie_id) DO UPDATE SET position=excluded.position', (u['id'], mid, min(data.position, meta['duration'])))
    return {'ok': True}


@app.post('/api/movies/{mid}/favorite')
def favorite(mid: str, u=Depends(user)):
    movie(mid)
    with db() as conn:
        conn.execute('INSERT INTO progress(user_id,movie_id,position,favorite) VALUES (?,?,0,1) ON CONFLICT(user_id,movie_id) DO UPDATE SET favorite=1-favorite', (u['id'], mid))
    return {'ok': True}


class Playback(BaseModel):
    quality: str = 'auto'
    direct: bool = False
    h264: bool = False
    bandwidth: float = Field(default=0, ge=0, le=100000)
    start: float = Field(default=0, ge=0, le=1e8)


def decide(meta, data):
    if data.quality not in ('auto', 'original', '1080', '720', '480'):
        raise HTTPException(400, 'Ukendt kvalitet.')
    limit = {'1080': 8, '720': 4, '480': 2}
    quality = data.quality
    if quality == 'auto':
        if data.bandwidth and meta['bitrate'] / 1e6 > data.bandwidth * 0.7:
            quality = '1080' if data.bandwidth >= 12 else ('720' if data.bandwidth >= 6 else '480')
        else:
            quality = 'original'
    if quality == 'original' and data.direct:
        return {'mode': 'Direct Play', 'height': meta['height'], 'mbps': round(meta['bitrate'] / 1e6, 1), 'reason': 'Browseren understøtter originalfilen.'}
    if quality == 'original' and data.h264 and meta['video'] == 'h264' and meta['pix_fmt'] == 'yuv420p' and not meta['hdr']:
        return {'mode': 'Direct Stream', 'height': meta['height'], 'mbps': round(meta['bitrate'] / 1e6, 1), 'reason': 'Videoen bevares. Indpakning og lyd tilpasses afspilleren.'}
    target = min(meta['height'], int(quality) if quality.isdigit() else 1080)
    return {'mode': 'Transcoding', 'height': target, 'mbps': limit.get(quality, 8), 'reason': 'Valgt kvalitet eller format kræver videokonvertering.'}


@app.post('/api/movies/{mid}/plan')
def plan(mid: str, data: Playback, u=Depends(user)):
    _, meta = movie(mid)
    return decide(meta, data)


@app.post('/api/movies/{mid}/play')
def play(mid: str, data: Playback, request: Request, u=Depends(user)):
    row, meta = movie(mid)
    result = decide(meta, data)
    offset = min(data.start, max(0, meta['duration'] - 1))
    if result['mode'] == 'Direct Play':
        return media.issue({**result, 'url': f'/api/movies/{mid}/file', 'session': None, 'offset': 0, 'encoder': 'Original'}, request, mid, db)
    with LOCK:
        if len(JOBS) >= int(os.getenv('MAX_TRANSCODES', 3)):
            raise HTTPException(503, 'Serverens stream-pladser er optaget. Prøv igen om lidt.')
        if shutil.disk_usage(DATA).free < 2 * 1024**3:
            raise HTTPException(507, 'For lidt diskplads til transcoding.')
        sid = secrets.token_hex(16)
        folder = DATA / 'streams' / sid
        folder.mkdir()
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-threads', '4', '-protocol_whitelist', 'file,pipe', '-ss', str(offset), '-i', row['path'], '-map', '0:v:0', '-map', '0:a:0?', '-sn']
        encoder = 'Remux + AAC'
        if result['mode'] == 'Direct Stream':
            cmd += ['-c:v', 'copy']
        else:
            encoder = 'NVIDIA NVENC' if GPU else 'CPU · H.264'
            filters = []
            if meta['hdr']:
                filters += ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv']
            filters += [f"scale=-2:{result['height']}", 'format=yuv420p']
            cmd += ['-vf', ','.join(filters), '-c:v', 'h264_nvenc' if GPU else 'libx264', '-preset', 'fast' if GPU else 'veryfast', '-b:v', f"{result['mbps']}M", '-maxrate', f"{result['mbps']}M", '-bufsize', f"{result['mbps'] * 2}M", '-force_key_frames', 'expr:gte(t,n_forced*2)']
            if GPU:
                # NVENC otherwise forces I-frames without IDR boundaries. HLS then
                # waits for the default GOP (~10s at 24fps), stalling Chrome at its end.
                cmd += ['-forced-idr', '1']
        cmd += ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-max_muxing_queue_size', '2048', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file', '-hls_segment_filename', str(folder / 'segment%05d.ts'), str(folder / 'index.m3u8')]
        log = (folder / 'ffmpeg.log').open('wb')
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log)
        JOBS[sid] = {'process': process, 'folder': folder, 'log': log, 'user': u['id'], 'touch': time.time()}
    for _ in range(200):
        playlist = folder / 'index.m3u8'
        # Prepare several segments before playback, so Chrome does not exhaust
        # the first two seconds while the next playlist update is pending.
        contents = playlist.read_text() if playlist.exists() else ''
        if contents.count('#EXTINF:') >= 3 or '#EXT-X-ENDLIST' in contents:
            return media.issue({**result, 'url': f'/api/streams/{sid}/index.m3u8', 'session': sid, 'offset': offset, 'encoder': encoder}, request, mid, db)
        if process.poll() is not None:
            break
        time.sleep(0.1)
    stop_job(sid)
    raise HTTPException(500, 'Konverteringen kunne ikke starte inden for 20 sekunder. Prøv en lavere kvalitet.')


@app.get('/api/streams/{sid}/{filename}')
def segment(sid: str, filename: str, u=Depends(user)):
    if media.config()[0]:
        raise HTTPException(409, 'Brug den direkte videoadresse.')
    return stream_file(sid, filename, u)


def stream_file(sid, filename, u):
    with LOCK:
        job = JOBS.get(sid)
        if not job or job['user'] != u['id']:
            raise HTTPException(404)
        if not re.fullmatch(r'(index\.m3u8|segment\d+\.ts)', filename):
            raise HTTPException(404)
        job['touch'] = time.time()
        path = job['folder'] / filename
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type='application/vnd.apple.mpegurl' if filename.endswith('m3u8') else 'video/mp2t')


@app.api_route('/media/{ticket}/movies/{mid}/file', methods=['GET', 'HEAD'])
def direct_original(ticket: str, mid: str):
    media.validate(ticket, db, session_user, mid=mid)
    return original_file(mid)


@app.get('/media/connection-check')
def media_connection_probe(request: Request):
    return media.connection_probe(request.headers.get('host', '').lower(), db)


@app.api_route('/media/{ticket}/streams/{sid}/{filename}', methods=['GET', 'HEAD'])
def direct_segment(ticket: str, sid: str, filename: str):
    u = media.validate(ticket, db, session_user, sid=sid)
    return stream_file(sid, filename, u)


class MediaTicket(BaseModel):
    ticket: str = Field(min_length=43, max_length=43)


@app.post('/api/media/heartbeat')
def media_heartbeat(data: MediaTicket, request: Request, u=Depends(user)):
    media.renew(data.ticket, request, db)
    return {'ok': True, 'expires_in': media.TTL}


@app.post('/api/media/revoke')
def media_revoke(data: MediaTicket, request: Request, u=Depends(user)):
    media.renew(data.ticket, request, db, revoke=True)
    return {'ok': True}


@app.post('/api/streams/{sid}/heartbeat')
def heartbeat(sid: str, u=Depends(user)):
    with LOCK:
        job = JOBS.get(sid)
        if not job or job['user'] != u['id']:
            raise HTTPException(404)
        job['touch'] = time.time()
    return {'ok': True}


@app.delete('/api/streams/{sid}')
def stop(sid: str, u=Depends(user)):
    with LOCK:
        job = JOBS.get(sid)
        if job and job['user'] != u['id']:
            raise HTTPException(403)
    stop_job(sid)
    return {'ok': True}


from app.remote import attach_remote

attach_remote(app, user, db, digest, session_user)
app.mount('/static', StaticFiles(directory=Path(__file__).parent / 'static'), name='static')


@app.get('/')
def index():
    return FileResponse(Path(__file__).parent / 'static' / 'index.html')
