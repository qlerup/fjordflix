from unittest.mock import patch
import httpx
import pytest
from fastapi.testclient import TestClient
from test_integration import main
from app import hub


@pytest.fixture
def managed(monkeypatch):
    monkeypatch.setenv('FJORDHUB_URL','http://fjordhub.test')
    monkeypatch.setenv('FJORDHUB_API_KEY','test-app-key')
    monkeypatch.setenv('FJORDHUB_APP_ID','fjordflix')
    hub._cache['expires'] = 0
    people = [{'id':101,'username':'Hub Alice','role':'admin','hub_role':'user','must_change_password':False}]
    def call(path,payload=None,method='POST'):
        if path.endswith('/users'):
            return {'ok':True,'items':people.copy()}
        if path.endswith('/authenticate'):
            if payload['password'] != 'sixsix':
                raise main.HTTPException(401,'Wrong login')
            return {'ok':True,'user':people[0]}
        if path.endswith('/sso-verify') and payload.get('token') == 'single-use':
            return {'ok':True,**people[0]}
        raise main.HTTPException(401,'Invalid SSO')
    with patch.object(hub,'call',side_effect=call):
        yield people
    hub._cache['expires'] = 0


def test_managed_auth_roles_revocation_and_history(managed):
    with TestClient(main.app) as client:
        assert client.get('/api/state').json()['setup'] is False
        assert client.get('/api/state').json()['managed'] is True
        credentials={'name':'Hub Alice','password':'sixsix'}
        assert client.post('/api/setup',json={**credentials,'password':'long-test-password'}).status_code == 403
        assert client.post('/api/register',json={**credentials,'password':'long-test-password','invite':'anything'}).status_code == 403
        assert client.post('/api/login',json=credentials).status_code == 200
        assert client.cookies.get('fjordflix_session')
        assert not client.cookies.get('session')
        assert client.get('/api/admin').status_code == 200
        assert client.post('/api/invites').status_code == 403
        uid=client.get('/api/state').json()['user']['id']
        with main.db() as conn:
            assert conn.execute('SELECT password FROM users WHERE id=?',(uid,)).fetchone()[0]=='fjordhub-managed'
            # Stored progress belongs to a stable Hub ID even when names change.
            conn.execute('INSERT OR REPLACE INTO progress VALUES (?,?,?,?)',(uid,'history-fixture',12,1))
        managed[0].update(username='Renamed Alice',role='user',hub_role='admin')
        hub._cache['expires']=0
        assert client.get('/api/admin').status_code == 403
        assert client.get('/api/state').json()['user']['name']=='Renamed Alice'
        assert client.get('/hub-login?token=single-use',follow_redirects=False).status_code==303
        assert client.get('/api/state').json()['user']['id']==uid
        with main.db() as conn:
            assert conn.execute('SELECT position FROM progress WHERE user_id=? AND movie_id=?',(uid,'history-fixture')).fetchone()[0]==12
        managed.clear();hub._cache['expires']=0
        assert client.get('/api/movies').status_code==401
        with main.db() as conn:
            assert conn.execute('SELECT count(*) FROM sessions WHERE user_id=?',(uid,)).fetchone()[0]==0


def test_managed_outage_and_forced_password_change(managed):
    with TestClient(main.app) as client:
        managed[0]['must_change_password']=True
        assert client.post('/api/login',json={'name':'Hub Alice','password':'sixsix'}).status_code==403
        assert client.get('/hub-login?token=single-use').status_code==403
        managed[0]['must_change_password']=False
        assert client.post('/api/login',json={'name':'Hub Alice','password':'sixsix'}).status_code==200
        hub._cache['expires']=0
        with patch.object(hub,'call',side_effect=main.HTTPException(503,'Unavailable')):
            assert client.get('/api/movies').status_code==503
        assert client.get('/hub-login?token=wrong').status_code==401


def test_partial_configuration_never_enables_setup(monkeypatch):
    monkeypatch.setenv('FJORDHUB_URL','http://hub.test')
    monkeypatch.delenv('FJORDHUB_API_KEY',raising=False)
    with TestClient(main.app) as client:
        assert client.get('/api/state').json()['setup'] is False
        assert client.post('/api/login',json={'name':'anything','password':'anything'}).status_code==503


def test_hub_key_only_goes_to_configured_backend(monkeypatch):
    monkeypatch.setenv('FJORDHUB_URL','http://hub.test')
    monkeypatch.setenv('FJORDHUB_API_KEY','test-app-key')
    response=httpx.Response(200,json={'ok':True,'items':[]})
    with patch.object(httpx.Client,'request',return_value=response) as request:
        assert hub.call('/api/hub/apps/users',method='GET')['ok']
        assert request.call_args.kwargs['headers']=={'X-Hub-Key':'test-app-key'}
        assert request.call_args.kwargs['params']=={'app_id':'fjordflix'}
