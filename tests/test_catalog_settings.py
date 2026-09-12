import sqlite3

import pytest
from fastapi.testclient import TestClient
from app import catalog, main


@pytest.fixture
def settings(monkeypatch, tmp_path):
    def db():
        conn = sqlite3.connect(tmp_path / 'settings.db')
        conn.row_factory = sqlite3.Row
        return conn
    monkeypatch.setattr(catalog, '_db', None)
    catalog.init(db)
    monkeypatch.delenv('TMDB_READ_ACCESS_TOKEN', raising=False)
    return db


def test_persistence_replacement_and_disable(settings, monkeypatch):
    monkeypatch.setenv('TMDB_READ_ACCESS_TOKEN', 'environment-token')
    assert catalog.credential() == ('environment-token', 'environment')
    catalog.save('  private-token  ')
    catalog.init(settings)
    assert catalog.credential() == ('private-token', 'settings')
    assert catalog.status() == {'configured': True, 'source': 'settings'}
    catalog.save('replacement-token')
    assert catalog.credential()[0] == 'replacement-token'
    catalog.disable()
    assert catalog.status()['configured'] is False
    assert catalog.credential()[0] == ''


def test_invalid_input_does_not_replace(settings):
    catalog.save('keep-this')
    for value in ('', 'bad\nheader', 'x' * 4097):
        with pytest.raises(ValueError):
            catalog.save(value)
    assert catalog.credential()[0] == 'keep-this'


def test_settings_api_access_and_no_secret(settings, monkeypatch):
    monkeypatch.setattr(main.media, 'config', lambda: ('', ''))
    client = TestClient(main.app)
    assert client.get('/api/admin/metadata').status_code == 401
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': False})
    assert client.get('/api/admin/metadata').status_code == 403
    assert client.put('/api/admin/metadata', json={'token': 'secret'}).status_code == 403
    assert client.delete('/api/admin/metadata').status_code == 403
    monkeypatch.setitem(main.app.dependency_overrides, main.user, lambda: {'admin': True})
    token = 'sensitive-test-token'
    response = client.put('/api/admin/metadata', json={'token': token})
    assert response.status_code == 200 and token not in response.text
    response = client.get('/api/admin/metadata')
    assert response.json() == {'configured': True, 'source': 'settings'}
    assert token not in response.text
    assert response.headers['cache-control'] == 'no-store'
    assert client.put('/api/admin/metadata', json={'token': 'evil'}, headers={'Origin': 'https://evil.example'}).status_code == 403
    assert catalog.credential()[0] == token
    assert client.put('/api/admin/metadata', json={'token': ''}).status_code == 400
    assert client.delete('/api/admin/metadata').json()['configured'] is False
