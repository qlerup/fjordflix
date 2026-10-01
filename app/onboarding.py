"""One optional, persistent provider guide owned by the first administrator."""
import json
from typing import Literal

from fastapi import Depends, HTTPException
from pydantic import BaseModel

from app import catalog


class Choice(BaseModel):
    step: Literal['tmdb', 'subtitles', 'all']
    action: Literal['done', 'skip']


def register(main):
    def configured():
        return {'tmdb': catalog.status()['configured'],
                'subtitles': main.subtitle_provider.status()['configured']}

    def update(user, choice=None):
        ready = configured()
        with main.db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute("SELECT value FROM catalog_settings WHERE name='onboarding_v1'").fetchone()
            state = json.loads(row[0]) if row else {
                'owner': user['id'], 'steps': {key: 'done' if value else 'pending' for key, value in ready.items()}}
            if state['owner'] != user['id']:
                if choice:
                    raise HTTPException(403, 'Guiden tilhører serverens første administrator.')
                return {'pending': False, 'steps': {}, 'configured': ready}
            for key, value in ready.items():
                if value and state['steps'][key] == 'pending':
                    state['steps'][key] = 'done'
            if choice:
                if choice.step == 'all':
                    if choice.action != 'skip':
                        raise HTTPException(400, 'Vælg et opsætningstrin.')
                    for key in state['steps']:
                        if state['steps'][key] == 'pending':
                            state['steps'][key] = 'skipped'
                elif choice.action == 'done':
                    if not ready[choice.step]:
                        raise HTTPException(409, 'Gem opsætningen først, eller vælg Gør det senere.')
                    state['steps'][choice.step] = 'done'
                else:
                    state['steps'][choice.step] = 'skipped'
            conn.execute("INSERT OR REPLACE INTO catalog_settings VALUES ('onboarding_v1', ?)", (json.dumps(state),))
        return {'pending': 'pending' in state['steps'].values(), 'steps': state['steps'], 'configured': ready}

    @main.app.get('/api/admin/onboarding')
    def status(u=Depends(main.admin)):
        return update(u)

    @main.app.post('/api/admin/onboarding')
    def choose(data: Choice, u=Depends(main.admin)):
        return update(u, data)
