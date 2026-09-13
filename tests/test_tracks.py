import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app import main, tracks
from test_series import client


def test_track_metadata_and_validation():
    info = tracks.describe([
        {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2, 'tags': {'language': 'eng'}, 'disposition': {}},
        {'index': 2, 'codec_type': 'audio', 'codec_name': 'eac3', 'tags': {'LANGUAGE': 'dan', 'title': 'Dansk'}, 'disposition': {'default': 1}},
        {'index': 3, 'codec_type': 'subtitle', 'codec_name': 'subrip', 'tags': {'language': 'dan'}, 'disposition': {'forced': 1}},
        {'index': 4, 'codec_type': 'subtitle', 'codec_name': 'hdmv_pgs_subtitle'},
        {'index': 5, 'codec_type': 'subtitle', 'codec_name': 'unknown'},
    ])
    assert info['audio'][1]['language'] == 'dan'
    assert tracks.select({'tracks': info})[0]['index'] == 2
    assert tracks.select({'tracks': info}, subtitle_index=3)[1]['delivery'] == 'text'
    assert tracks.select({'tracks': info}, subtitle_index=4)[1]['delivery'] == 'burn'
    for kwargs in [{'audio_index': 3}, {'subtitle_index': 1}, {'subtitle_index': 5}]:
        with pytest.raises(ValueError):
            tracks.select({'tracks': info}, **kwargs)


@pytest.fixture
def mkv(client):
    (main.DATA / 'streams').mkdir()
    danish = main.DATA / 'danish.srt'
    english = main.DATA / 'english.srt'
    danish.write_text('1\n00:00:01,000 --> 00:00:04,000\nHej med dig! Æ, ø og å.\n\n2\n00:00:05,000 --> 00:00:07,000\nAnden undertekst.\n', encoding='utf-8')
    english.write_text('1\n00:00:01,000 --> 00:00:04,000\nHello there!\n', encoding='utf-8')
    path = main.MEDIA / 'tracks.mkv'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=8',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8',
        '-i', str(english), '-i', str(danish), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
        '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=dan',
        '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=dan',
        '-disposition:a:0', '0', '-disposition:a:1', 'default', '-y', str(path)], check=True, capture_output=True)
    meta = main.probe(path)
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=?', (str(path), json.dumps(meta)))
    yield 'a'*32, path, meta
    for sid in list(main.JOBS):
        main.stop_job(sid)


def test_mkv_tracks_subtitles_and_invalid_ids(client, mkv):
    mid, path, meta = mkv
    result = client.get(f'/api/movies/{mid}/tracks')
    assert result.status_code == 200
    available = result.json()
    assert [t['language'] for t in available['audio']] == ['eng', 'dan']
    assert [t['index'] for t in available['subtitles']] == [3, 4]
    text = client.get(f'/api/movies/{mid}/subtitles/4.vtt')
    assert text.status_code == 200 and text.text.startswith('WEBVTT')
    assert 'Æ, ø og å.' in text.text and '00:01.' in text.text
    assert client.get(f'/api/movies/{mid}/subtitles/2.vtt').status_code == 400
    assert client.post(f'/api/movies/{mid}/play', json={'audio_track': 4}).status_code == 400
    assert client.post(f'/api/movies/{mid}/play', json={'subtitle_track': 1}).status_code == 400
    assert client.post(f'/api/movies/{mid}/play', json={'audio_track': -1}).status_code == 422
    assert client.get('/api/movies/' + 'b'*32 + '/subtitles/4.vtt').status_code == 404


def test_selected_audio_is_in_real_output_and_text_does_not_transcode_video(client, mkv, monkeypatch):
    from array import array
    monkeypatch.setattr(main, 'GPU', False)
    mid, path, meta = mkv
    data = {'quality':'original', 'direct':True, 'h264':True, 'audio_track':2, 'subtitle_track':4, 'start':3}
    plan = client.post(f'/api/movies/{mid}/plan', json=data)
    assert plan.json()['mode'] == 'Direct Stream'
    response = client.post(f'/api/movies/{mid}/play', json=data)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['audio_track'] == 2 and result['subtitle_delivery'] == 'text' and result['offset'] == 3
    job = main.JOBS[result['session']]
    job['process'].wait(timeout=15)
    output = job['folder'] / 'index.m3u8'
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(output)], capture_output=True, check=True)
    streams = json.loads(probe.stdout)['streams']
    assert len([s for s in streams if s['codec_type'] == 'audio']) == 1
    assert next(s for s in streams if s['codec_type'] == 'video')['codec_name'] == 'h264'
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a:0', '-t', '1', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], capture_output=True, check=True)
    samples = array('f', pcm.stdout)
    frequency = sum(a <= 0 < b for a, b in zip(samples, samples[1:])) * 8000 / len(samples)
    assert abs(frequency - 880) < 10


def test_bitmap_subtitles_force_transcoding():
    meta = {'height': 1080, 'video': 'h264', 'pix_fmt': 'yuv420p', 'hdr': False, 'bitrate': 1000000,
            'tracks': {'audio': [], 'subtitles': [{'index': 3, 'delivery': 'burn'}]}}
    result = main.decide(meta, main.Playback(quality='original', direct=True, h264=True, subtitle_track=3))
    assert result['mode'] == 'Transcoding'


def test_ass_subtitles_extract_as_text_and_cache_is_reused(client, mkv):
    mid, path, meta = mkv
    converted = path.with_name('ass-tracks.mkv')
    subprocess.run(['ffmpeg','-v','error','-i',str(path),'-map','0','-c','copy','-c:s','ass','-y',str(converted)], check=True, capture_output=True)
    meta = main.probe(converted)
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=?', (str(converted),json.dumps(meta)))
    first = client.get(f'/api/movies/{mid}/subtitles/4.vtt')
    assert first.status_code == 200 and 'Hej med dig!' in first.text
    second = client.get(f'/api/movies/{mid}/subtitles/4.vtt')
    assert second.content == first.content
    assert len(list((main.DATA/'subtitles').glob('*.vtt'))) == 1


def test_track_routes_require_login(client):
    with main.db() as conn:
        conn.executescript('CREATE TABLE sessions(token TEXT,user_id TEXT,expires REAL); CREATE TABLE users(id TEXT,name TEXT,admin INTEGER,hub_id TEXT,hub_username TEXT);')
    main.app.dependency_overrides.pop(main.user)
    anonymous = TestClient(main.app)
    assert anonymous.get('/api/movies/' + 'a'*32 + '/tracks').status_code == 401
    assert anonymous.get('/api/movies/' + 'a'*32 + '/subtitles/3.vtt').status_code == 401


@pytest.mark.parametrize('start', [0, 2])
def test_real_pgs_overlay(client, monkeypatch, start):
    import os
    fixture = os.getenv('PGS_TEST_FILE')
    if not fixture:
        pytest.skip('Set PGS_TEST_FILE to a local PGS sample for decoder verification.')
    path = Path(fixture)
    monkeypatch.setattr(main, 'GPU', False)
    (main.DATA / 'streams').mkdir()
    meta = main.probe(path)
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=?', (str(path), json.dumps(meta)))
    subtitle = meta['tracks']['subtitles'][0]['index']
    outputs = []
    try:
        for track in [None, subtitle]:
            response = client.post('/api/movies/'+'a'*32+'/play', json={'quality':'480', 'subtitle_track':track, 'start':start})
            assert response.status_code == 200, response.text
            result = response.json()
            job = main.JOBS[result['session']]
            job['process'].wait(timeout=15)
            frame = subprocess.run(['ffmpeg','-v','error','-ss',str(2 if start == 0 else 0.5),'-i',str(job['folder']/'index.m3u8'),'-frames:v','1','-f','rawvideo','-pix_fmt','gray','-'],capture_output=True,check=True)
            outputs.append(frame.stdout)
        assert len(outputs[0]) == len(outputs[1]) > 0
        assert sum(abs(a-b) > 40 for a,b in zip(*outputs)) > 100, 'PGS must visibly change the decoded video frame.'
    finally:
        for sid in list(main.JOBS):
            main.stop_job(sid)
