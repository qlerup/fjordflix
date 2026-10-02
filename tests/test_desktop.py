from unittest.mock import patch
from test_tv import tv_client
from test_integration import main


def test_native_original_requires_login_and_scopes_ticket(tv_client):
    client, credentials, mid = tv_client
    url = f'/api/desktop/movies/{mid}/play'
    assert client.post(url, json={}).status_code == 401
    assert client.post('/api/login', json=credentials).status_code == 200
    assert client.post(url, json={'audio_track':999}).status_code == 400
    assert client.post(url, json={'start':-1}).status_code == 422
    with patch.object(main, 'play', side_effect=AssertionError('Must never transcode')):
        response = client.post(url, json={'start':12})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['start'] == 12
    assert data['session'] is None
    assert data['subtitle'] == 'no'
    media_url = data['url']
    result = client.get(media_url, headers={'Range':'bytes=0-9'})
    assert result.status_code == 206
    assert result.content == b'0123456789'
    assert client.get(media_url.replace(mid, 'f'*32)).status_code == 403
    assert client.post('/api/media/heartbeat', json={'ticket':data['media_ticket']}).status_code == 200
    assert client.post('/api/media/revoke', json={'ticket':data['media_ticket']}).status_code == 200
    assert client.get(media_url).status_code == 401


def test_download_has_fixed_release_destination(tv_client):
    client, _, _ = tv_client
    response = client.get('/downloads/windows', follow_redirects=False)
    assert response.status_code == 307
    assert response.headers['location'].endswith('/desktop-v0.1.0/FjordFlix-Setup-0.1.0.exe')
