"""Local, opt-in media requests for both local and FjordHub identities."""
import secrets
import time
from typing import Literal

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator


class Permission(BaseModel):
    enabled: bool = Field(strict=True)


class Wish(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    kind: Literal['movie', 'series'] = 'movie'
    note: str = Field(default='', max_length=2000)

    @field_validator('title', 'note')
    @classmethod
    def trim(cls, value, info):
        value = value.strip()
        if info.field_name == 'title' and not value:
            raise ValueError('Skriv en titel.')
        return value


class Decision(BaseModel):
    status: Literal['new', 'fulfilled', 'declined']
    reply: str = Field(default='', max_length=2000)


class Wishes:
    def __init__(self, main):
        self.main = main
        with main.db() as conn:
            conn.executescript('''
            CREATE TABLE IF NOT EXISTS wish_permissions(subject TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS wishes(
                id TEXT PRIMARY KEY, subject TEXT NOT NULL, sender TEXT NOT NULL,
                title TEXT NOT NULL, title_key TEXT NOT NULL, kind TEXT NOT NULL,
                note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', reply TEXT NOT NULL DEFAULT '',
                created REAL NOT NULL, updated REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS wishes_subject_created ON wishes(subject, created DESC);
            CREATE INDEX IF NOT EXISTS wishes_created ON wishes(created DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS wishes_open_unique ON wishes(subject,kind,title_key) WHERE status='new';
            ''')

    def subject(self, user):
        return 'hub:' + str(user['hub_id']) if user.get('hub_id') is not None else 'local:' + user['id']

    def allowed(self, user, conn=None):
        if user.get('admin'):
            return True
        if conn is None:
            with self.main.db() as conn:
                return self.allowed(user, conn)
        row = conn.execute('SELECT enabled FROM wish_permissions WHERE subject=?', (self.subject(user),)).fetchone()
        return bool(row and row['enabled'])

    def profile(self, user):
        return {**user, 'can_request': self.allowed(user)} if user else None

    def annotate_users(self, users):
        prefix = 'hub:' if self.main.hub.managed() else 'local:'
        with self.main.db() as conn:
            permissions = dict(conn.execute('SELECT subject,enabled FROM wish_permissions'))
        return [{**u, 'can_request': bool(u['admin'] or permissions.get(prefix + str(u['id'])))} for u in users]

    def permission(self, uid, data):
        if self.main.hub.managed():
            exists = any(str(u['id']) == uid for u in self.main.hub.users())
            subject = 'hub:' + uid
        else:
            with self.main.db() as conn:
                exists = conn.execute('SELECT 1 FROM users WHERE id=? AND hub_id IS NULL', (uid,)).fetchone()
            subject = 'local:' + uid
        if not exists:
            raise HTTPException(404, 'Brugeren findes ikke.')
        with self.main.db() as conn:
            conn.execute('INSERT INTO wish_permissions(subject,enabled) VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET enabled=excluded.enabled', (subject, data.enabled))
        return {'ok': True, 'enabled': data.enabled}

    def listing(self, user, page=1):
        if not self.allowed(user):
            raise HTTPException(403, 'Administratoren har ikke givet dig adgang til ønsker.')
        where, values = ('', []) if user.get('admin') else ('WHERE subject=?', [self.subject(user)])
        with self.main.db() as conn:
            rows = conn.execute(f'SELECT id,sender,title,kind,note,status,reply,created,updated FROM wishes {where} ORDER BY created DESC,id DESC LIMIT 51 OFFSET ?', [*values, (page-1)*50]).fetchall()
        return {'items': [dict(row) for row in rows[:50]], 'has_more': len(rows) > 50, 'admin': bool(user.get('admin'))}

    def create(self, user, data):
        with self.main.db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if not self.allowed(user, conn):
                raise HTTPException(403, 'Administratoren har ikke givet dig adgang til ønsker.')
            subject = self.subject(user)
            key = data.title.casefold()
            if conn.execute("SELECT 1 FROM wishes WHERE subject=? AND kind=? AND title_key=? AND status='new'", (subject, data.kind, key)).fetchone():
                raise HTTPException(409, 'Du har allerede sendt dette ønske.')
            if conn.execute("SELECT COUNT(*) FROM wishes WHERE subject=? AND status='new'", (subject,)).fetchone()[0] >= 20:
                raise HTTPException(409, 'Du har allerede 20 ubesvarede ønsker. Vent på administratorens svar.')
            ident, now = secrets.token_hex(16), time.time()
            conn.execute('INSERT INTO wishes(id,subject,sender,title,title_key,kind,note,created,updated) VALUES (?,?,?,?,?,?,?,?,?)',
                         (ident, subject, user['name'], data.title, key, data.kind, data.note, now, now))
        return {'ok': True, 'id': ident}

    def decide(self, ident, data):
        with self.main.db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT * FROM wishes WHERE id=?', (ident,)).fetchone()
            if not row:
                raise HTTPException(404, 'Ønsket findes ikke.')
            # Reopening must not violate the unique pending-request invariant.
            if data.status == 'new' and conn.execute("SELECT 1 FROM wishes WHERE subject=? AND kind=? AND title_key=? AND status='new' AND id<>?", (row['subject'], row['kind'], row['title_key'], ident)).fetchone():
                raise HTTPException(409, 'Brugeren har allerede et åbent ønske om denne titel.')
            conn.execute('UPDATE wishes SET status=?,reply=?,updated=? WHERE id=?', (data.status, data.reply.strip(), time.time(), ident))
        return {'ok': True}


def register(main):
    service = Wishes(main)

    @main.app.put('/api/admin/users/{uid}/wishes')
    def permission(uid: str, data: Permission, u=Depends(main.admin)):
        return service.permission(uid, data)

    @main.app.get('/api/wishes')
    def listing(page: int = Query(1, ge=1, le=100000), u=Depends(main.user)):
        return service.listing(u, page)

    @main.app.post('/api/wishes', status_code=201)
    def create(data: Wish, u=Depends(main.user)):
        return service.create(u, data)

    @main.app.put('/api/admin/wishes/{ident}')
    def decide(ident: str, data: Decision, u=Depends(main.admin)):
        return service.decide(ident, data)

    return service
