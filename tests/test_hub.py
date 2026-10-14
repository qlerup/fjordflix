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
        assert client.get('/api/state').json()['user']['language']=='da'
        managed[0]['language']='fr';hub._cache['expires']=0
        assert client.get('/api/state').json()['user']['language']=='fr'
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
        assert client.get('/api/auth/access').json()['authenticated'] is True
        with main.db() as conn:
            assert conn.execute('SELECT position FROM progress WHERE user_id=? AND movie_id=?',(uid,'history-fixture')).fetchone()[0]==12
        old_cookie=client.cookies.get('fjordflix_session')
        managed.clear();hub._cache['expires']=0
        revoked=client.get('/api/auth/access')
        assert revoked.status_code==401 and revoked.json()['error_code']=='access_revoked'
        # Another browser/session must still receive the logout explanation after invalidation.
        with TestClient(main.app) as other:
            other.cookies.set('fjordflix_session',old_cookie)
            assert other.get('/api/auth/access').json()['error_code']=='access_revoked'
        with main.db() as conn:
            assert conn.execute('SELECT count(*) FROM sessions WHERE user_id=?',(uid,)).fetchone()[0]==0


def test_managed_outage_and_forced_password_change(managed):
    with TestClient(main.app) as client:
        managed[0]['must_change_password']=True
        result = client.post('/api/login',json={'name':'Hub Alice','password':'sixsix'})
        assert result.json()['password_required']
        assert 'set-cookie' not in result.headers
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


def test_required_email_blocks_existing_session_until_saved_without_logging_out(managed):
    with TestClient(main.app) as client:
        assert client.post('/api/login',json={'name':'Hub Alice','password':'sixsix'}).status_code == 200
        cookie = client.cookies.get('fjordflix_session')
        managed[0]['email_required'] = True
        # The fresh opening check sees the flag even while a membership cache exists.
        response = client.get('/api/auth/access?fresh=1')
        assert response.status_code == 403
        assert response.json()['detail']['error_code'] == 'email_update_required'
        assert client.get('/api/movies').status_code == 403
        assert client.cookies.get('fjordflix_session') == cookie
        with main.db() as conn:
            assert conn.execute('SELECT count(*) FROM sessions WHERE token=?',(main.digest(cookie),)).fetchone()[0] == 1
        calls = []
        def update(path,payload=None,method='POST'):
            if path.endswith('/users'): return {'ok':True,'items':managed}
            calls.append((path,payload))
            if payload['email'] == 'invalid': return {'ok':True,'accepted':False,'error':'Invalid email'}
            managed[0].update(email_required=False,email=payload['email'])
            return {'ok':True,'accepted':True,'user':managed[0]}
        with patch.object(hub,'call',side_effect=update):
            assert client.post('/api/auth/email',json={'email':'invalid'}).json()['accepted'] is False
            assert client.get('/api/auth/access?fresh=1').status_code == 403
            assert client.post('/api/auth/email',json={'email':'updated@example.test','id':999},headers={'Origin':'https://evil.test'}).status_code == 403
            assert client.post('/api/auth/email',json={'email':'updated@example.test','id':999}).json()['accepted'] is True
        assert calls[-1] == ('/api/hub/apps/users/101/email', {'email':'updated@example.test'})
        assert client.get('/api/auth/access').json()['authenticated'] is True
        assert client.get('/api/movies').status_code == 200
        assert client.cookies.get('fjordflix_session') == cookie


def test_hub_key_only_goes_to_configured_backend(monkeypatch):
    monkeypatch.setenv('FJORDHUB_URL','http://hub.test')
    monkeypatch.setenv('FJORDHUB_API_KEY','test-app-key')
    response=httpx.Response(200,json={'ok':True,'items':[]})
    with patch.object(httpx.Client,'request',return_value=response) as request:
        assert hub.call('/api/hub/apps/users',method='GET')['ok']
        assert request.call_args.kwargs['headers']=={'X-Hub-Key':'test-app-key'}
        assert request.call_args.kwargs['params']=={'app_id':'fjordflix'}


def test_email_completion_does_not_issue_browser_or_tv_session(managed):
    managed[0]['email_required'] = True
    with TestClient(main.app) as client:
        for url in ('/api/login', '/tv-api/login'):
            result = client.post(url, json={'name':'Hub Alice','password':'sixsix'})
            assert result.status_code == 200
            assert result.json()['email_required']
            assert 'token' not in result.json()
            assert 'set-cookie' not in result.headers
