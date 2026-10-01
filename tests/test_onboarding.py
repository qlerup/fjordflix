import json
import sqlite3

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import catalog, main


@pytest.fixture
def guide(tmp_path, monkeypatch):
    def db():
        conn = sqlite3.connect(tmp_path / 'guide.db')
        conn.row_factory = sqlite3.Row
        return conn
    monkeypatch.setattr(main, 'db', db)
    monkeypatch.setattr(catalog, '_db', None)
    catalog.init(db)
    monkeypatch.delenv('TMDB_READ_ACCESS_TOKEN', raising=False)
    monkeypatch.setattr(main.media, 'config', lambda: ('', ''))
    provider = {'configured': False}
    monkeypatch.setattr(main.subtitle_provider, 'status', lambda: provider)
    identity = {'id': 'first-admin', 'admin': True}
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: dict(identity))
    return TestClient(main.app), identity, provider, db


def test_first_admin_claims_and_skip_survives_reload(guide):
    client, identity, _, db = guide
    first = client.get('/api/admin/onboarding').json()
    assert first['steps'] == {'tmdb': 'pending', 'subtitles': 'pending'}
    identity['id'] = 'second-admin'
    assert client.get('/api/admin/onboarding').json()['pending'] is False
    assert client.post('/api/admin/onboarding', json={'step': 'all', 'action': 'skip'}).status_code == 403
    identity['id'] = 'first-admin'
    assert client.post('/api/admin/onboarding', json={'step': 'tmdb', 'action': 'skip'}).json()['pending']
    assert client.get('/api/admin/onboarding').json()['steps']['tmdb'] == 'skipped'
    assert not client.post('/api/admin/onboarding', json={'step': 'subtitles', 'action': 'skip'}).json()['pending']
    with db() as conn:
        value = json.loads(conn.execute("SELECT value FROM catalog_settings WHERE name='onboarding_v1'").fetchone()[0])
    assert set(value['steps'].values()) == {'skipped'}
    assert client.get('/api/admin/onboarding').json()['pending'] is False
    assert catalog.status()['configured'] is False


def test_existing_provider_setup_and_successful_completion(guide):
    client, _, provider, _ = guide
    catalog.save('secret-api-token')
    response = client.get('/api/admin/onboarding')
    assert response.json()['steps'] == {'tmdb': 'done', 'subtitles': 'pending'}
    assert 'secret-api-token' not in response.text
    assert client.post('/api/admin/onboarding', json={'step': 'subtitles', 'action': 'done'}).status_code == 409
    provider['configured'] = True
    assert not client.post('/api/admin/onboarding', json={'step': 'subtitles', 'action': 'done'}).json()['pending']


def test_skip_everything_and_no_guide_when_already_configured(guide):
    client, _, provider, _ = guide
    catalog.save('existing-token')
    provider['configured'] = True
    assert client.get('/api/admin/onboarding').json()['pending'] is False
    assert client.post('/api/admin/onboarding', json={'step': 'all', 'action': 'skip'}).json()['pending'] is False
    assert catalog.credential()[0] == 'existing-token'


def test_non_admin_cannot_claim_or_complete_and_csrf_is_rejected(guide):
    client, identity, _, db = guide
    identity['admin'] = False
    assert client.get('/api/admin/onboarding').status_code == 403
    assert client.post('/api/admin/onboarding', json={'step': 'all', 'action': 'skip'}).status_code == 403
    with db() as conn:
        assert conn.execute('SELECT COUNT(*) FROM catalog_settings').fetchone()[0] == 0
    identity['admin'] = True
    identity['hub_id'] = 42
    assert client.get('/api/admin/onboarding').json()['pending']
    assert client.post('/api/admin/onboarding', json={'step': 'all', 'action': 'skip'},
                       headers={'Origin': 'https://other.example'}).status_code == 403
    assert client.post('/api/admin/onboarding', json={'step': 'unknown', 'action': 'skip'}).status_code == 422


def test_anonymous_cannot_claim(guide, monkeypatch):
    client, _, _, _ = guide
    def anonymous():
        raise HTTPException(401, 'Login required')
    monkeypatch.setitem(main.app.dependency_overrides, main.user, anonymous)
    assert client.get('/api/admin/onboarding').status_code == 401
