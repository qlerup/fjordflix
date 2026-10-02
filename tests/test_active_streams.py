import json
from unittest.mock import patch

import pytest
from test_tv import tv_client
from test_integration import main
from app import active_streams as active


@pytest.fixture(autouse=True)
def clean_presence():
    active.LIVE.clear()
    yield
    active.LIVE.clear()


def admin(client, credentials):
    with main.db() as conn:
        conn.execute('UPDATE users SET admin=1 WHERE name=?', (credentials['name'],))
    client.post('/api/login', json=credentials)


def test_presence_auth_lifecycle_and_concurrent_direct_play(tv_client):
    client, credentials, mid = tv_client
    assert client.get('/api/admin/active-streams').status_code == 401
    client.post('/api/login', json=credentials)
    assert client.get('/api/admin/active-streams').status_code == 403
    one = client.post(f'/api/movies/{mid}/play', json={'direct': True, 'quality': 'original'}).json()
    two = client.post(f'/api/movies/{mid}/play', json={'direct': True, 'quality': 'original'}).json()
    assert one['playback_id'] != two['playback_id']
    key = one['playback_id']
    active.LIVE[two['playback_id']]['user_id'] = 'someone-else'
    assert client.post(f"/api/playbacks/{two['playback_id']}/heartbeat", json={'position': 1}).status_code == 404
    assert client.post(f"/api/playbacks/{two['playback_id']}/stop").status_code == 404
    assert client.post(f'/api/playbacks/{key}/heartbeat', json={'position': 27, 'state': 'paused'}).status_code == 200
    admin(client, credentials)
    response = client.get('/api/admin/active-streams')
    assert response.headers['cache-control'] == 'no-store'
    cards = response.json()['streams']
    assert len(cards) == 2
    card = next(c for c in cards if c['id'] == key)
    assert card['position'] == 27 and card['state'] == 'paused'
    assert card['mode'] == 'Direct Play' and not card['video']['transcoded']
    assert not {'session', '_audio', 'user_id', 'ticket'} & card.keys()
    client.post(f'/api/playbacks/{key}/stop')
    with patch.object(active.time, 'time', return_value=active.LIVE[two['playback_id']]['touch']+121):
        assert client.get('/api/admin/active-streams').json()['streams'] == []


def test_native_pgs_is_local_and_tracks_update(tv_client):
    client, credentials, mid = tv_client
    admin(client, credentials)
    with main.db() as conn:
        meta = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?', (mid,)).fetchone()[0])
        meta['tracks'] = {'audio':[{'index':1,'codec':'truehd','language':'eng','default':True}], 'subtitles':[{'index':2,'codec':'hdmv_pgs_subtitle','language':'dan','delivery':'burn'}]}
        conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(meta),mid))
    result = client.post(f'/api/desktop/movies/{mid}/play', json={'subtitle_track':2}).json()
    key = result['playback_id']
    card = client.get('/api/admin/active-streams').json()['streams'][0]
    assert card['subtitle_delivery'] == 'local'
    assert card['audio']['codec'] == 'truehd' and not card['audio_transcoded']
    assert client.post(f'/api/playbacks/{key}/heartbeat', json={'position':3,'subtitle_ordinal':0}).status_code == 200
    assert client.get('/api/admin/active-streams').json()['streams'][0]['subtitle'] is None
    assert client.post(f'/api/playbacks/{key}/heartbeat', json={'position':4,'subtitle_ordinal':1}).status_code == 200
    assert client.get('/api/admin/active-streams').json()['streams'][0]['subtitle']['codec'] == 'hdmv_pgs_subtitle'
    assert client.post(f'/api/playbacks/{key}/heartbeat', json={'position':4,'subtitle_ordinal':99}).status_code == 400
    client.post(f'/api/playbacks/{key}/heartbeat', json={'position':60,'state':'ended'})
    assert client.get('/api/admin/active-streams').json()['streams'] == []


def test_transcode_and_remux_report_actual_components():
    row={'id':'a'*32,'title':'Example'}
    meta={'duration':100,'height':2160,'video':'hevc','bitrate':25000000,'hdr':True}
    audio={'index':1,'codec':'truehd'}
    sub={'index':2,'codec':'hdmv_pgs_subtitle'}
    user={'id':'u','name':'User'}
    data=main.Playback()
    result=active.begin({'mode':'Transcoding','height':1080,'subtitle_delivery':'burn','session':'job'},row,meta,user,data,audio,sub)
    entry=active.LIVE[result['playback_id']]
    assert entry['video']['output']=='h264' and entry['audio_transcoded']
    assert entry['video']['tonemapped']
    assert entry['subtitle_delivery']=='burn'
    active.remove_session('job')
    assert not active.LIVE
    result=active.begin({'mode':'Direct Stream'},row,meta,user,data,audio,None,audio_copy=True)
    entry=active.LIVE[result['playback_id']]
    assert not entry['video']['transcoded'] and not entry['audio_transcoded']


def test_tv_legacy_presence_uses_ticket_and_does_not_guess_pause():
    row={'id':'a'*32,'title':'Example'}
    result=active.begin({'mode':'Direct Play'},row,{'duration':100},{'id':'u','name':'User'},main.Playback(),None,None)
    key=result['playback_id']
    active.bind_tv(key,'test-ticket','test-login')
    active.tv_progress('wrong-login',row['id'],30)
    assert active.LIVE[key]['position']==0
    active.tv_progress('test-login',row['id'],30)
    assert active.LIVE[key]['position']==30
    assert active.LIVE[key]['state']=='connected' and active.LIVE[key]['limited_status']
    active.tv_touch('test-ticket',stop=True)
    assert not active.LIVE
