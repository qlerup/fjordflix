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
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA = Path(os.getenv('DATA_DIR', './data'))
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


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


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
    check = await asyncio.to_thread(subprocess.run, ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=640x360:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], capture_output=True, timeout=15)
    GPU = check.returncode == 0
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
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if (origin and urlparse(origin).netloc != request.headers.get('host')) or request.headers.get('sec-fetch-site') == 'cross-site':
            return Response('Ugyldig oprindelse', status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'"
    if request.url.path.startswith('/api'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def user(request: Request):
    with db() as conn:
        row = conn.execute('SELECT u.id,u.name,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', (digest(request.cookies.get('session', '')), time.time())).fetchone()
    if not row:
        raise HTTPException(401, 'Log ind for at fortsætte.')
    return dict(row)


def admin(u=Depends(user)):
    if not u['admin']:
        raise HTTPException(403, 'Kun administratoren har adgang.')
    return u


class Credentials(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=10, max_length=128)
    invite: str = ''


def session(response, uid):
    token = secrets.token_urlsafe(32)
    with db() as conn:
        conn.execute('INSERT INTO sessions VALUES (?,?,?)', (digest(token), uid, time.time() + 86400 * 7))
    response.set_cookie('session', token, httponly=True, samesite='strict', max_age=86400 * 7, secure=os.getenv('SECURE_COOKIES') == '1')


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
        setup = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
    try:
        current = user(request)
    except HTTPException:
        current = None
    return {'setup': setup, 'user': current, 'gpu': GPU}


@app.post('/api/setup')
def setup(data: Credentials, response: Response, request: Request):
    throttle(request)
    uid = secrets.token_hex(16)
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
            raise HTTPException(409, 'Serveren er allerede opsat.')
        name = data.name.strip()
        if len(name) < 2:
            raise HTTPException(400, 'Navnet skal være mindst to tegn.')
        conn.execute('INSERT INTO users VALUES (?,?,?,1)', (uid, name, PASSWORDS.hash(data.password)))
    session(response, uid)
    return {'ok': True}


@app.post('/api/login')
def login(data: Credentials, response: Response, request: Request):
    throttle(request)
    with db() as conn:
        row = conn.execute('SELECT * FROM users WHERE name=?', (data.name.strip(),)).fetchone()
    try:
        if not row:
            PASSWORDS.hash(data.password)
            raise HTTPException(401, 'Forkert brugernavn eller adgangskode.')
        PASSWORDS.verify(row['password'], data.password)
    except VerificationError:
        raise HTTPException(401, 'Forkert brugernavn eller adgangskode.')
    session(response, row['id'])
    return {'ok': True}


@app.post('/api/register')
def register(data: Credentials, response: Response, request: Request):
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
            conn.execute('INSERT INTO users VALUES (?,?,?,0)', (uid, data.name.strip(), PASSWORDS.hash(data.password)))
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'Brugernavnet er allerede i brug.')
        conn.execute('DELETE FROM invites WHERE token=?', (digest(data.invite),))
    session(response, uid)
    return {'ok': True}


@app.post('/api/logout')
def logout(request: Request, response: Response, u=Depends(user)):
    with db() as conn:
        conn.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies.get('session', '')),))
    response.delete_cookie('session')
    return {'ok': True}


@app.post('/api/invites')
def invite(u=Depends(admin)):
    token = secrets.token_urlsafe(24)
    with db() as conn:
        conn.execute('INSERT INTO invites VALUES (?,?)', (digest(token), time.time()))
    return {'token': token}


@app.get('/api/admin')
def dashboard(u=Depends(admin)):
    with db() as conn:
        users = [dict(x) for x in conn.execute('SELECT id,name,admin FROM users')]
    disk = shutil.disk_usage(DATA)
    with LOCK:
        active = len(JOBS)
    return {'users': users, 'gpu': GPU, 'streams': active, 'free_gb': round(disk.free / 1024**3, 1), 'max_streams': int(os.getenv('MAX_TRANSCODES', 3))}


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
    path = DATA / 'media' / f'{mid}{suffix}'
    size = 0
    try:
        with path.open('wb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 100 * 1024**3:
                    raise HTTPException(413, 'Betaen tillader højst 100 GB pr. film.')
                if shutil.disk_usage(DATA).free < len(chunk) + 512 * 1024**2:
                    raise HTTPException(507, 'Serveren mangler ledig diskplads.')
                await asyncio.to_thread(output.write, chunk)
        await asyncio.to_thread(index_movie, path, Path(filename).stem.replace('_', ' ').replace('.', ' '), mid)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return {'id': mid}


DEMO_LOCK = threading.Lock()


@app.post('/api/demo')
def demo(u=Depends(admin)):
    with DEMO_LOCK:
        with db() as conn:
            existing = conn.execute("SELECT id FROM movies WHERE title='Nordlys · 4K testfilm'").fetchone()
        if existing:
            return {'id': existing['id']}
        mid = secrets.token_hex(16)
        path = DATA / 'media' / f'{mid}.mp4'
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
def play(mid: str, data: Playback, u=Depends(user)):
    row, meta = movie(mid)
    result = decide(meta, data)
    offset = min(data.start, max(0, meta['duration'] - 1))
    if result['mode'] == 'Direct Play':
        return {**result, 'url': f'/api/movies/{mid}/file', 'session': None, 'offset': 0, 'encoder': 'Original'}
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
        cmd += ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-max_muxing_queue_size', '2048', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file', '-hls_segment_filename', str(folder / 'segment%05d.ts'), str(folder / 'index.m3u8')]
        log = (folder / 'ffmpeg.log').open('wb')
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log)
        JOBS[sid] = {'process': process, 'folder': folder, 'log': log, 'user': u['id'], 'touch': time.time()}
    for _ in range(200):
        playlist = folder / 'index.m3u8'
        if playlist.exists():
            return {**result, 'url': f'/api/streams/{sid}/index.m3u8', 'session': sid, 'offset': offset, 'encoder': encoder}
        if process.poll() is not None:
            break
        time.sleep(0.1)
    stop_job(sid)
    raise HTTPException(500, 'Konverteringen kunne ikke starte inden for 20 sekunder. Prøv en lavere kvalitet.')


@app.get('/api/streams/{sid}/{filename}')
def segment(sid: str, filename: str, u=Depends(user)):
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

attach_remote(app, user, db, digest)
app.mount('/static', StaticFiles(directory=Path(__file__).parent / 'static'), name='static')


@app.get('/')
def index():
    return FileResponse(Path(__file__).parent / 'static' / 'index.html')
