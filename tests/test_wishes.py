import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app import main, wishes


@pytest.fixture
def env(tmp_path, monkeypatch):
    def db():
        conn=sqlite3.connect(tmp_path/'test.db')
        conn.row_factory=sqlite3.Row
        return conn
    with db() as conn:
        conn.execute('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,admin INTEGER,hub_id INTEGER)')
        conn.executemany('INSERT INTO users VALUES (?,?,0,NULL)', [('one','Anna'),('two','Bo')])
    monkeypatch.setattr(main,'db',db)
    monkeypatch.setattr(main.hub,'managed',lambda:False)
    monkeypatch.setattr(main.media,'config',lambda:('',''))
    service=wishes.Wishes(main)
    monkeypatch.setattr(main,'wishes_service',service)
    account={'id':'one','name':'Anna','admin':False}
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:account)
    yield SimpleNamespace(client=TestClient(main.app),user=account,service=service,db=db)


def test_opt_in_admin_only_and_revocation(env):
    c=env.client
    assert c.get('/api/wishes').status_code==403
    assert c.post('/api/wishes',json={'title':'En film'}).status_code==403
    assert c.put('/api/admin/users/one/wishes',json={'enabled':True}).status_code==403
    env.user['admin']=True
    assert c.put('/api/admin/users/missing/wishes',json={'enabled':True}).status_code==404
    assert c.put('/api/admin/users/one/wishes',json={'enabled':'false'}).status_code==422
    assert c.put('/api/admin/users/one/wishes',json={'enabled':True}).status_code==200
    env.user['admin']=False
    assert env.service.profile(env.user)['can_request']
    assert c.post('/api/wishes',json={'title':'En film'}).status_code==201
    env.user['admin']=True
    c.put('/api/admin/users/one/wishes',json={'enabled':False})
    env.user['admin']=False
    assert c.get('/api/wishes').status_code==403
    assert c.post('/api/wishes',json={'title':'En anden film'}).status_code==403


def test_private_lists_admin_reply_validation_and_deduplication(env):
    c=env.client
    for uid in ('one','two'):
        env.service.permission(uid,wishes.Permission(enabled=True))
    created=c.post('/api/wishes',json={'title':'  Æble  ','kind':'series','note':'<script>alert(1)</script>'})
    assert created.status_code==201
    ident=created.json()['id']
    assert c.post('/api/wishes',json={'title':'æble','kind':'series'}).status_code==409
    for body in ({'title':'  '},{'title':'x'*241},{'title':'OK','kind':'other'},{'title':'OK','note':'x'*2001}):
        assert c.post('/api/wishes',json=body).status_code==422
    assert c.put('/api/admin/wishes/'+ident,json={'status':'fulfilled'}).status_code==403
    env.user.update(id='two',name='Bo')
    assert c.get('/api/wishes').json()['items']==[]
    env.user['admin']=True
    assert len(c.get('/api/wishes').json()['items'])==1
    assert c.put('/api/admin/wishes/'+ident,json={'status':'fulfilled','reply':'Nu ligger den i biblioteket.'}).status_code==200
    env.user.update(id='one',name='Anna',admin=False)
    record=c.get('/api/wishes').json()['items'][0]
    assert record['title']=='Æble' and record['status']=='fulfilled' and record['reply'].startswith('Nu')
    assert 'subject' not in record
    assert c.get('/api/wishes?page=0').status_code==422


def test_hub_permission_before_first_login_is_local_and_persistent(env,monkeypatch):
    monkeypatch.setattr(main.hub,'managed',lambda:True)
    monkeypatch.setattr(main.hub,'users',lambda:[{'id':42,'username':'Hub Anna','role':'user'}])
    env.user['admin']=True
    assert env.client.put('/api/admin/users/42/wishes',json={'enabled':True}).status_code==200
    hub_user={'id':'new-local-mapping','name':'Hub Anna','hub_id':42,'admin':False}
    reloaded=wishes.Wishes(main)
    assert reloaded.allowed(hub_user)
    assert not reloaded.allowed({'id':'42','name':'Local','admin':False})
    assert reloaded.annotate_users([{'id':'42','name':'Hub Anna','admin':False}])[0]['can_request']


def test_tv_requires_bearer_and_preserves_user_scope(env,monkeypatch):
    env.service.permission('one',wishes.Permission(enabled=True))
    monkeypatch.setattr(main,'session_user',lambda _:env.user)
    c=env.client
    assert c.get('/tv-api/wishes',headers={'Cookie':'fjordflix_session='+'a'*43}).status_code==401
    headers={'Authorization':'Bearer '+'a'*43}
    assert c.get('/tv-api/state',headers=headers).json()['user']['can_request']
    assert c.post('/tv-api/wishes',headers=headers,json={'title':'TV film'}).status_code==201
    assert c.get('/tv-api/wishes',headers=headers).json()['items'][0]['title']=='TV film'
    env.service.permission('one',wishes.Permission(enabled=False))
    assert c.post('/tv-api/wishes',headers=headers,json={'title':'Afvist'}).status_code==403


def test_pending_limit_and_pagination(env):
    env.service.permission('one',wishes.Permission(enabled=True))
    for i in range(20):
        assert env.client.post('/api/wishes',json={'title':str(i)}).status_code==201
    assert env.client.post('/api/wishes',json={'title':'Too many'}).status_code==409
    with env.db() as conn:
        conn.execute("UPDATE wishes SET status='fulfilled'")
    assert env.client.post('/api/wishes',json={'title':'Next'}).status_code==201
    with env.db() as conn:
        conn.executemany("INSERT INTO wishes(id,subject,sender,title,title_key,kind,note,status,created,updated) VALUES (?,'local:one','Anna',?,?,'movie','','fulfilled',0,0)", [(f'old{i}',f'Old {i}',f'old{i}') for i in range(35)])
    first=env.client.get('/api/wishes').json()
    second=env.client.get('/api/wishes?page=2').json()
    assert len(first['items'])==50 and first['has_more']
    assert len(second['items'])==6 and not second['has_more']
    assert not set(x['id'] for x in first['items']) & set(x['id'] for x in second['items'])


def test_admin_can_review_but_cannot_submit_even_with_permission(env, monkeypatch):
    env.service.permission('one', wishes.Permission(enabled=True))
    created = env.client.post('/api/wishes', json={'title': 'Brugerens film'})
    assert created.status_code == 201
    env.user['admin'] = True
    assert env.client.get('/api/wishes').json()['admin']
    assert env.client.post('/api/wishes', json={'title': 'Admin film'}).status_code == 403
    monkeypatch.setattr(main, 'session_user', lambda _: env.user)
    assert env.client.post('/tv-api/wishes', headers={'Authorization': 'Bearer ' + 'a'*43},
                           json={'title': 'Admin TV film'}).status_code == 403
    assert env.client.put('/api/admin/wishes/' + created.json()['id'],
                          json={'status': 'fulfilled', 'reply': 'Klar'}).status_code == 200
    assert len(env.client.get('/api/wishes').json()['items']) == 1
    assert not env.service.annotate_users([env.user])[0]['can_request']


def test_anonymous_and_cross_origin_cannot_send_or_grant(env,monkeypatch):
    env.user['admin']=True
    assert env.client.put('/api/admin/users/one/wishes',json={'enabled':True},headers={'Origin':'https://evil.example'}).status_code==403
    def anonymous():
        raise HTTPException(401,'Log ind')
    monkeypatch.setitem(main.app.dependency_overrides,main.user,anonymous)
    assert env.client.get('/api/wishes').status_code==401
    assert env.client.post('/api/wishes',json={'title':'Film'}).status_code==401
