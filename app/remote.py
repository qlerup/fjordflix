"""Ephemeral screen pairing. Credentials travel in POST bodies / WS frames, never URLs."""
import asyncio
import base64
import hashlib
import json
import math
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

import qrcode
from qrcode.image.svg import SvgPathImage
from fastapi import Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOMS = {}
PAIR_SECONDS = 180
SESSION_SECONDS = 8 * 3600


class Pair(BaseModel):
    screen: str = Field(max_length=64)
    token: str = Field(max_length=128)


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def command(data):
    if not isinstance(data, dict):
        return None
    kind = data.get('type')
    if kind in ('click', 'back', 'play', 'quality'):
        return {'type': kind}
    if kind == 'search' and isinstance(data.get('text'), str):
        return {'type': kind, 'text': data['text'][:160]}
    if kind in ('move', 'scroll', 'seek', 'volume'):
        fields = {'move': ('dx', 'dy'), 'scroll': ('dy',), 'seek': ('delta',), 'volume': ('delta',)}[kind]
        result = {'type': kind}
        for field in fields:
            value = data.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                return None
            limit = 800 if kind in ('move', 'scroll') else 10 if kind == 'seek' else 0.1
            result[field] = max(-limit, min(limit, value))
        return result
    return None


async def tell(socket, message):
    if socket:
        try:
            await asyncio.wait_for(socket.send_json(message), timeout=2)
        except (RuntimeError, WebSocketDisconnect, OSError, asyncio.TimeoutError):
            pass


async def revoke(sid):
    room = ROOMS.pop(sid, None)
    if room:
        for socket in (room.get('tv'), room.get('phone')):
            if socket:
                try:
                    await socket.close(code=4001, reason='Parringen er afsluttet')
                except (RuntimeError, WebSocketDisconnect, OSError):
                    pass


def attach_remote(app, user, db, digest, validate_session):
    async def alive(room):
        if time.time() > room['expires']:
            return False
        try:
            await asyncio.to_thread(validate_session, room['login'])
            return True
        except HTTPException:
            return False

    @app.get('/remote')
    def remote_page():
        return FileResponse(Path(__file__).parent / 'static' / 'remote.html', headers={'Cache-Control': 'no-store'})

    @app.post('/api/remote/screens')
    async def create(request: Request, u=Depends(user)):
        for sid, room in list(ROOMS.items()):
            if not await alive(room) or (not room['tv'] and time.time() - room['created'] > 30):
                await revoke(sid)
        if len(ROOMS) >= 64 or sum(r['user'] == u['id'] for r in ROOMS.values()) >= 4:
            raise HTTPException(429, 'Du kan højst have fire skærme tilsluttet. Afbryd en skærm først.')
        sid, token = secrets.token_urlsafe(18), secrets.token_urlsafe(32)
        base = os.getenv('REMOTE_PUBLIC_URL', '').rstrip('/') or str(request.base_url).rstrip('/')
        parsed = urlparse(base)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.path:
            raise HTTPException(500, 'Serverens fjernbetjeningsadresse er ikke gyldig.')
        room = {'user': u['id'], 'login': digest(request.cookies['fjordflix_session']), 'name': f"{u['name']} · TV", 'pair': hashed(token), 'pair_expires': time.time() + PAIR_SECONDS, 'expires': time.time() + SESSION_SECONDS, 'created': time.time(), 'remote': None, 'tv': None, 'phone': None}
        ROOMS[sid] = room
        link = f'{base}/remote#{sid}:{token}'
        qr = qrcode.make(link, image_factory=SvgPathImage, box_size=8, border=4)
        svg = base64.b64encode(qr.to_string()).decode()
        return {'screen': sid, 'qr': f'data:image/svg+xml;base64,{svg}', 'link': link, 'name': room['name'], 'expires_in': PAIR_SECONDS, 'local_only': parsed.hostname in ('localhost', '127.0.0.1', '::1')}

    @app.delete('/api/remote/screens/{sid}')
    async def remove(sid: str, u=Depends(user)):
        room = ROOMS.get(sid)
        if room and room['user'] != u['id']:
            raise HTTPException(403)
        await revoke(sid)
        return {'ok': True}

    @app.post('/api/remote/pair')
    async def pair(data: Pair):
        room = ROOMS.get(data.screen)
        if not room or not room['pair'] or time.time() > room['pair_expires'] or not secrets.compare_digest(room['pair'], hashed(data.token)):
            raise HTTPException(410, 'QR-koden er udløbet eller allerede brugt. Vis en ny kode på skærmen.')
        if not await alive(room) or not room['tv']:
            raise HTTPException(409, 'Skærmen er ikke længere tilsluttet. Åbn fjernbetjeningen på skærmen igen.')
        if not room['pair'] or not secrets.compare_digest(room['pair'], hashed(data.token)):
            raise HTTPException(410, 'QR-koden er allerede brugt.')
        key = secrets.token_urlsafe(32)
        # No await between validation and consumption: only one phone can claim the code.
        room['pair'] = None
        room['remote'] = hashed(key)
        return {'screen': data.screen, 'key': key, 'name': room['name']}

    @app.websocket('/api/remote/ws/{sid}/{role}')
    async def socket(websocket: WebSocket, sid: str, role: str):
        # Both clients connect to their own server origin; QR credential is sent after upgrade.
        origin = websocket.headers.get('origin')
        if not origin or urlparse(origin).netloc != websocket.headers.get('host'):
            await websocket.close(code=1008)
            return
        room = ROOMS.get(sid)
        if not room or role not in ('tv', 'phone') or not await alive(room):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        connected = False
        try:
            if role == 'tv':
                if digest(websocket.cookies.get('fjordflix_session', '')) != room['login'] or room['tv']:
                    await websocket.close(code=1008)
                    return
            else:
                raw = await asyncio.wait_for(websocket.receive_text(), 5)
                if len(raw) > 512:
                    await websocket.close(code=1008)
                    return
                auth = json.loads(raw)
                if not isinstance(auth, dict) or not isinstance(auth.get('key'), str) or not room['remote'] or not secrets.compare_digest(room['remote'], hashed(auth['key'])) or room['phone'] or not room['tv']:
                    await websocket.close(code=1008)
                    return
            room[role] = websocket
            connected = True
            await tell(websocket, {'type': 'ready', 'name': room['name']})
            if role == 'phone':
                await tell(room['tv'], {'type': 'paired'})
            count, window, checked = 0, time.monotonic(), 0
            while ROOMS.get(sid) is room:
                now = time.monotonic()
                if now - checked > 2:
                    if not await alive(room):
                        await revoke(sid)
                        return
                    checked = now
                try:
                    raw = await asyncio.wait_for(websocket.receive_text(), timeout=20)
                except asyncio.TimeoutError:
                    continue
                if len(raw) > 2048:
                    await websocket.close(code=1009)
                    break
                data = json.loads(raw)
                if not isinstance(data, dict):
                    continue
                if data.get('type') == 'ping':
                    await tell(websocket, {'type': 'pong'})
                    continue
                if role != 'phone':
                    continue
                if now - window > 1:
                    count, window = 0, now
                count += 1
                if count > 90:
                    continue
                event = command(data)
                if event and room['tv']:
                    await tell(room['tv'], event)
        except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError, RuntimeError):
            pass
        finally:
            if connected and ROOMS.get(sid) is room and room[role] is websocket:
                room[role] = None
                if role == 'tv':
                    await revoke(sid)
                else:
                    await tell(room['tv'], {'type': 'phone_offline'})
