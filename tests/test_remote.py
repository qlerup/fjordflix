import time
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_integration import main
from app.remote import ROOMS


def test_pairing_permissions_and_command_isolation():
    with TestClient(main.app) as tv:
        credentials = {'name':'Remote Tester','password':'Test-remote-password-73!'}
        if tv.get('/api/state').json()['setup']:
            assert tv.post('/api/setup',json=credentials).status_code == 200
        else:
            assert tv.post('/api/login',json={'name':'Test Admin','password':'Temporary-test-password-73!'}).status_code == 200
        phone = TestClient(main.app)
        assert phone.post('/api/remote/screens').status_code == 401
        assert phone.get('/remote').status_code == 200
        room = tv.post('/api/remote/screens').json()
        sid = room['screen']
        token = room['link'].split(':')[-1]
        assert room['qr'].startswith('data:image/svg+xml;base64,')
        assert phone.post('/api/remote/pair',json={'screen':sid,'token':'wrong'}).status_code == 410
        assert phone.post('/api/remote/pair',json={'screen':sid,'token':token}).status_code == 409
        with pytest.raises(WebSocketDisconnect):
            with phone.websocket_connect(f'/api/remote/ws/{sid}/tv',headers={'origin':'http://testserver'}) as intruder:
                intruder.receive_json()
        with pytest.raises(WebSocketDisconnect):
            with tv.websocket_connect(f'/api/remote/ws/{sid}/tv',headers={'origin':'http://evil.test'}):
                pass
        with tv.websocket_connect(f'/api/remote/ws/{sid}/tv',headers={'origin':'http://testserver'}) as screen:
            assert screen.receive_json()['type'] == 'ready'
            paired = phone.post('/api/remote/pair',json={'screen':sid,'token':token})
            assert paired.status_code == 200
            assert phone.post('/api/remote/pair',json={'screen':sid,'token':token}).status_code == 410
            key = paired.json()['key']
            with phone.websocket_connect(f'/api/remote/ws/{sid}/phone',headers={'origin':'http://testserver'}) as handset:
                handset.send_json({'key':key})
                assert handset.receive_json()['type'] == 'ready'
                assert screen.receive_json()['type'] == 'paired'
                handset.send_json({'type':'move','dx':40,'dy':-20})
                assert screen.receive_json() == {'type':'move','dx':40,'dy':-20}
                handset.send_json({'type':'eval','code':'alert(1)'})
                handset.send_json({'type':'move','dx':'bad','dy':0})
                handset.send_json({'type':'click'})
                assert screen.receive_json() == {'type':'click'}
                handset.send_json({'type':'move','dx':100000,'dy':-100000})
                assert screen.receive_json() == {'type':'move','dx':800,'dy':-800}
                assert phone.get('/api/movies').status_code == 401
            assert screen.receive_json()['type'] == 'phone_offline'
        assert sid not in ROOMS
        assert phone.post('/api/remote/pair',json={'screen':sid,'token':token}).status_code == 410
        expired = tv.post('/api/remote/screens').json()
        ROOMS[expired['screen']]['pair_expires'] = time.time()-1
        assert phone.post('/api/remote/pair',json={'screen':expired['screen'],'token':expired['link'].split(':')[-1]}).status_code == 410
        tv.delete('/api/remote/screens/'+expired['screen'])
