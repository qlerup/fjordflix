"""Phone approval and atomic Xbox token handoff use only a disposable database."""
import base64
import re
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from app import tv_pairing
from test_tv import tv_client, main


@pytest.fixture
def pairing(tv_client):
    with main.db() as conn:
        conn.execute('DELETE FROM sessions WHERE token IN (SELECT proof_session FROM tv_login_pairs)')
        conn.execute('DELETE FROM tv_login_pairs')
        conn.execute('DELETE FROM tv_login_rates')
    yield tv_client
    with main.db() as conn:
        conn.execute('DELETE FROM sessions WHERE token IN (SELECT proof_session FROM tv_login_pairs)')
        conn.execute('DELETE FROM tv_login_pairs')
        conn.execute('DELETE FROM tv_login_rates')


def start(client):
    response = client.post('/tv-api/pair/start', json={}, headers={'Origin':'null'})
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    return response.json()


def approve(client, pair, credentials, **kwargs):
    return client.post('/tv-api/pair/approve', json={'user_code':pair['user_code'], **credentials},
                       headers={'Origin':'https://web.test'}, **kwargs)


def poll(client, pair):
    return client.post('/tv-api/pair/poll', json={'device_code':pair['device_code']})


def rows(table):
    with main.db() as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM ' + table)]


def test_code_separation_phone_approval_and_one_use_device_claim(pairing):
    client, credentials, _ = pairing
    pair = start(client)
    assert re.fullmatch('['+tv_pairing.CODE_ALPHABET+']{4}-['+tv_pairing.CODE_ALPHABET+']{4}',pair['user_code'])
    assert len(pair['device_code']) == 43 and pair['expires_in'] == 300 and pair['interval'] == 3
    assert pair['verification_uri'] == 'https://web.test/tv-login'
    assert pair['verification_uri_complete'] == pair['verification_uri'] + '#code=' + pair['user_code']
    svg = base64.b64decode(pair['qr_data_url'].split(',',1)[1]).decode()
    assert '<svg' in svg and pair['device_code'] not in svg
    assert pair['device_code'] not in pair['verification_uri_complete']
    stored = rows('tv_login_pairs')[0]
    assert stored['device_hash'] == tv_pairing.hashed(pair['device_code'])
    assert stored['user_hash'] == tv_pairing.hashed(pair['user_code'].replace('-',''))
    assert stored['proof_session'] is None
    for _ in range(25):
        assert poll(client,pair).json() == {'status':'pending'}
    assert main.ATTEMPTS == {}  # Polling cannot lock out password logins.
    approval = approve(client,{**pair,'user_code':pair['user_code'].lower()},credentials)
    assert approval.status_code == 200 and approval.json() == {'status':'approved'}
    assert 'set-cookie' not in approval.headers and 'token' not in approval.text
    assert not client.cookies.get('fjordflix_session')
    approved = rows('tv_login_pairs')[0]
    proof = approved['proof_session']
    assert re.fullmatch('[a-f0-9]{64}',proof)
    session = next(row for row in rows('sessions') if row['token']==proof)
    assert session['expires'] <= approved['expires']
    assert poll(client,{'device_code':secrets.token_urlsafe(32)}).status_code == 410
    assert approve(client,pair,credentials).status_code == 409
    response = poll(client,pair)
    assert response.status_code == 200
    result = response.json()
    assert result['status']=='approved' and result['expires_in']==7*86400
    assert len(result['token']) == 43 and 'set-cookie' not in response.headers
    assert rows('tv_login_pairs') == []
    assert not any(row['token']==proof for row in rows('sessions'))
    assert client.get('/tv-api/state',headers={'Authorization':'Bearer '+result['token']}).json()['user']['name']==credentials['name']
    assert poll(client,pair).status_code == 410
    assert approve(client,pair,credentials).status_code == 410


@pytest.mark.parametrize('origin',[None,'null','https://evil.test','http://web.test','https://web.test:444'])
def test_approval_requires_exact_trusted_origin_and_explicit_credentials(pairing,origin):
    client,credentials,_ = pairing
    pair=start(client)
    assert client.post('/api/login',json=credentials).status_code == 200
    headers={} if origin is None else {'Origin':origin}
    response=client.post('/tv-api/pair/approve',json={'user_code':pair['user_code'],**credentials},headers=headers)
    assert response.status_code == 403
    assert client.post('/tv-api/pair/approve',json={'user_code':pair['user_code']},
                       headers={'Origin':'https://web.test'}).status_code == 422
    assert poll(client,pair).json()=={'status':'pending'}


def test_configured_web_origin_and_wrong_password(pairing):
    client,credentials,_=pairing
    main.media.save_config('https://video.test','https://phone.test',main.db)
    pair=start(client)
    assert pair['verification_uri']=='https://phone.test/tv-login'
    wrong=client.post('/tv-api/pair/approve',json={'user_code':pair['user_code'],**credentials,'password':'wrong'},
                      headers={'Origin':'https://phone.test'})
    assert wrong.status_code==401 and poll(client,pair).json()=={'status':'pending'}
    good=client.post('/tv-api/pair/approve',json={'user_code':pair['user_code'],**credentials},
                     headers={'Origin':'https://phone.test'})
    assert good.status_code==200 and 'set-cookie' not in good.headers


@pytest.mark.parametrize('approved',[False,True])
@pytest.mark.parametrize('action',['cancel','expire'])
def test_cancel_and_expiry_revoke_unclaimed_proof(pairing,approved,action):
    client,credentials,_=pairing
    pair=start(client)
    if approved:
        assert approve(client,pair,credentials).status_code==200
    proof=rows('tv_login_pairs')[0]['proof_session']
    if action=='cancel':
        for _ in range(2):
            assert client.post('/tv-api/pair/cancel',json={'device_code':pair['device_code']}).json()=={'ok':True}
    else:
        with main.db() as conn:
            conn.execute('UPDATE tv_login_pairs SET expires=0')
    assert poll(client,pair).status_code==410
    assert rows('tv_login_pairs')==[]
    assert not any(row['token']==proof for row in rows('sessions'))


def test_create_approve_rate_limits_and_pair_bound(pairing,monkeypatch):
    client,credentials,_=pairing
    for _ in range(10): start(client)
    assert client.post('/tv-api/pair/start',json={}).status_code==429
    assert len(rows('tv_login_pairs'))==10
    for _ in range(20):
        assert approve(client,{'user_code':'AAAA-AAAA'},credentials).status_code==410
    assert approve(client,{'user_code':'AAAA-AAAA'},credentials).status_code==429
    with main.db() as conn: conn.execute('DELETE FROM tv_login_rates')
    monkeypatch.setattr(tv_pairing,'MAX_PAIRS',10)
    assert client.post('/tv-api/pair/start',json={}).status_code==429


def test_simultaneous_poll_claims_only_one_session(pairing,monkeypatch):
    client,credentials,_=pairing
    pair=start(client)
    assert approve(client,pair,credentials).status_code==200
    original=main.session_user
    barrier=threading.Barrier(2)
    def delayed(token):
        user=original(token)
        barrier.wait(timeout=5)
        return user
    monkeypatch.setattr(main,'session_user',delayed)
    # Reuse the already-created ASGI client without entering its lifespan.
    with ThreadPoolExecutor(2) as workers:
        results=list(workers.map(lambda _:poll(client,pair),range(2)))
    assert sorted(r.status_code for r in results)==[200,410]
    assert rows('tv_login_pairs')==[]
    with main.db() as conn:
        uid=conn.execute('SELECT id FROM users WHERE name=?',(credentials['name'],)).fetchone()[0]
        assert conn.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?',(uid,)).fetchone()[0]==1


def test_cancel_during_login_cleans_new_session(pairing,monkeypatch):
    client,credentials,_=pairing
    pair=start(client)
    original=main.login
    def login_then_cancel(data,response,request):
        original(data,response,request)
        assert client.post('/tv-api/pair/cancel',json={'device_code':pair['device_code']}).status_code==200
    monkeypatch.setattr(main,'login',login_then_cancel)
    assert approve(client,pair,credentials).status_code==410
    assert rows('tv_login_pairs')==[]
    with main.db() as conn:
        uid=conn.execute('SELECT id FROM users WHERE name=?',(credentials['name'],)).fetchone()[0]
        assert conn.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?',(uid,)).fetchone()[0]==0


def test_simultaneous_approval_has_one_proof_and_no_orphan_session(pairing,monkeypatch):
    client,credentials,_=pairing
    pair=start(client)
    original=main.login
    barrier=threading.Barrier(2)
    def delayed(data,response,request):
        original(data,response,request)
        barrier.wait(timeout=5)
    monkeypatch.setattr(main,'login',delayed)
    with ThreadPoolExecutor(2) as workers:
        results=list(workers.map(lambda _:approve(client,pair,credentials),range(2)))
    assert sorted(r.status_code for r in results)==[200,410]
    assert len(rows('tv_login_pairs'))==1
    with main.db() as conn:
        uid=conn.execute('SELECT id FROM users WHERE name=?',(credentials['name'],)).fetchone()[0]
        sessions=conn.execute('SELECT token FROM sessions WHERE user_id=?',(uid,)).fetchall()
    assert [s['token'] for s in sessions]==[rows('tv_login_pairs')[0]['proof_session']]


def test_hub_revocation_before_claim_prevents_session_issue(pairing,monkeypatch):
    client,_,_=pairing
    monkeypatch.setattr(main.hub,'managed',lambda:True)
    profile={'id':82541,'username':'Phone Hub User','role':'user','must_change_password':False}
    monkeypatch.setattr(main.hub,'call',lambda *a,**kw:{'user':profile})
    monkeypatch.setattr(main.hub,'current',lambda *a,**kw:profile)
    pair=start(client)
    assert approve(client,pair,{'name':profile['username'],'password':'test-hub-password'}).status_code==200
    def revoked(*a,**kw): raise main.HTTPException(403,'Access revoked')
    monkeypatch.setattr(main.hub,'current',revoked)
    assert poll(client,pair).status_code==410
    assert rows('tv_login_pairs')==[]


def test_feature_signal_and_invalid_device_values(pairing):
    client,_,_=pairing
    assert 'phone-login-v1' in client.get('/tv-api/info').json()['features']
    for value in ('','bad','../file',None):
        assert client.post('/tv-api/pair/poll',json={'device_code':value}).status_code==422
    assert client.post('/tv-api/pair/cancel',json={'device_code':secrets.token_urlsafe(32)}).json()=={'ok':True}
