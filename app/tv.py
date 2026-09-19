"""Cross-origin token API for TV clients; never accepts browser cookies."""
from http.cookies import SimpleCookie
import secrets
import time
import logging
import re
from urllib.parse import urlparse
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from app import media

def attach_tv(app, main):
    tv = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    tv.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['GET', 'HEAD', 'POST', 'DELETE'],
                      allow_headers=['Authorization', 'Content-Type', 'Range'],
                      expose_headers=['Content-Length', 'Content-Range', 'Accept-Ranges'])


    @tv.middleware('http')
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response


    def authorized(request: Request):
        auth = request.headers.get('authorization', '')
        if not re.fullmatch(r'Bearer [A-Za-z0-9_-]{43}', auth):
            raise HTTPException(401, 'Log ind for at fortsætte.')
        token = auth[7:]
        user = main.session_user(main.digest(token))
        # Private Request for existing media helpers; browser cookies are never trusted.
        scope = dict(request.scope)
        scope['headers'] = [(k, v) for k, v in scope['headers'] if k.lower() != b'cookie']
        scope['headers'].append((b'cookie', ('fjordflix_session=' + token).encode('ascii')))
        return user, Request(scope), token


    @tv.get('/tv-api/info')
    def info():
        return {'app': 'fjordflix-tv', 'version': 1}


    @tv.post('/tv-api/login')
    def login(data: main.LoginCredentials, request: Request):
        response = Response()
        main.login(data, response, request)  # Existing Argon2/Hub verification and throttle.
        cookie = SimpleCookie()
        cookie.load(response.headers['set-cookie'])
        return {'token': cookie['fjordflix_session'].value, 'expires_in': 7 * 86400}


    @tv.get('/tv-api/state')
    def state(auth=Depends(authorized)):
        return {'user': auth[0]}


    @tv.post('/tv-api/logout')
    def logout(auth=Depends(authorized)):
        with main.db() as conn:
            conn.execute('DELETE FROM sessions WHERE token=?', (main.digest(auth[2]),))
            conn.execute('DELETE FROM media_grants WHERE login=?', (main.digest(auth[2]),))
        return {'ok': True}


    @tv.get('/tv-api/movies')
    def movies(auth=Depends(authorized)):
        return main.movies(auth[0])


    @tv.get('/tv-api/movies/{mid}/poster')
    def poster(mid: str, auth=Depends(authorized)):
        return main.poster(mid, auth[0])


    @tv.get('/tv-api/movies/{mid}/backdrop')
    def backdrop(mid: str, auth=Depends(authorized)):
        return main.backdrop(mid, auth[0])


    @tv.post('/tv-api/movies/{mid}/favorite')
    def favorite(mid: str, auth=Depends(authorized)):
        return main.favorite(mid, auth[0])


    @tv.post('/tv-api/movies/{mid}/progress')
    def progress(mid: str, data: main.Progress, auth=Depends(authorized)):
        return main.progress(mid, data, auth[0])


    @tv.post('/tv-api/movies/{mid}/play')
    def play(mid: str, data: main.Playback, auth=Depends(authorized)):
        result = main.play(mid, data, auth[1], auth[0])
        ticket = result.get('media_ticket')
        if not ticket:
            ticket = secrets.token_urlsafe(32)
            with main.db() as conn:
                conn.execute('INSERT INTO media_grants(token,login,movie,stream,expires) VALUES (?,?,?,?,?)',
                             (media.key(ticket), main.digest(auth[2]), mid, result['session'], time.time() + media.TTL))
        direct, _ = media.config()
        base = direct or str(auth[1].base_url).rstrip('/')
        path = f"streams/{result['session']}/{result.get('playlist', 'index.m3u8')}" if result['session'] else f'movies/{mid}/file'
        return {**result, 'url': f'{base}/tv-media/{ticket}/{path}', 'media_ticket': ticket,
                'media_expires_in': media.TTL}


    def media_host(request):
        direct, _ = media.config()
        if direct and (request.headers.get('host', '').lower() != urlparse(direct).netloc.lower()
                       or request.headers.get('cf-ray') or request.headers.get('cf-connecting-ip')):
            raise HTTPException(403, 'Video skal hentes via den direkte videoadresse.')


    @tv.api_route('/tv-media/{ticket}/movies/{mid}/file', methods=['GET', 'HEAD'])
    def original(ticket: str, mid: str, request: Request):
        media_host(request)
        media.validate(ticket, main.db, main.session_user, mid=mid)
        return main.original_file(mid)


    @tv.api_route('/tv-media/{ticket}/streams/{sid}/{filename}', methods=['GET', 'HEAD'])
    def segment(ticket: str, sid: str, filename: str, request: Request):
        media_host(request)
        user = media.validate(ticket, main.db, main.session_user, sid=sid)
        return main.stream_file(sid, filename, user)


    @tv.post('/tv-api/media/heartbeat')
    def renew(data: main.MediaTicket, auth=Depends(authorized)):
        return main.media_heartbeat(data, auth[1], auth[0])


    @tv.post('/tv-api/media/revoke')
    def revoke(data: main.MediaTicket, auth=Depends(authorized)):
        return main.media_revoke(data, auth[1], auth[0])


    @tv.post('/tv-api/streams/{sid}/heartbeat')
    def heartbeat(sid: str, auth=Depends(authorized)):
        return main.heartbeat(sid, auth[0])


    @tv.delete('/tv-api/streams/{sid}')
    def stop(sid: str, auth=Depends(authorized)):
        return main.stop(sid, auth[0])


    class RedactTickets(logging.Filter):
        def filter(self, record):
            if isinstance(record.args, tuple):
                record.args = tuple(re.sub(r'/tv-media/[A-Za-z0-9_-]{43}/', '/tv-media/[redacted]/', x)
                                    if isinstance(x, str) else x for x in record.args)
            return True


    logging.getLogger('uvicorn.access').addFilter(RedactTickets())


    class TVMiddleware:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            # Only explicit token/ticket routes bypass browser cookie/CSRF middleware.
            # Startup, shutdown, WebSockets and the web app retain their original stack.
            target = tv if scope['type'] == 'http' and scope['path'].startswith(('/tv-api/', '/tv-media/')) else self.app
            await target(scope, receive, send)

    app.add_middleware(TVMiddleware)
