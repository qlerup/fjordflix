"""Copied open-GOP video must retain its PTS across browser HLS fragments."""
import json
import statistics
import subprocess

import pytest

from app import main
from test_series import client


def video_packets(path):
    result = subprocess.run([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_packets',
        '-show_data_hash', 'sha256', '-show_entries', 'packet=pts_time,data_hash,flags',
        '-of', 'json', str(path),
    ], check=True, capture_output=True, timeout=20)
    return json.loads(result.stdout)['packets']


@pytest.fixture
def open_gop(client):
    (main.DATA / 'streams').mkdir()
    path = main.MEDIA / 'open-gop.mkv'
    subprocess.run([
        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=320x180:rate=24000/1001:duration=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params',
        'pools=1:frame-threads=1:keyint=48:min-keyint=48:scenecut=0:bframes=3:b-adapt=0:open-gop=1',
        '-c:a', 'aac', '-y', str(path),
    ], check=True, capture_output=True, timeout=45)
    meta = main.probe(path)
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=?', (str(path), json.dumps(meta)))
    yield path
    for sid in list(main.JOBS):
        main.stop_job(sid)


@pytest.mark.parametrize('start', [0, 3.2])
def test_browser_remux_preserves_open_gop_presentation_times(client, open_gop, start):
    source = video_packets(open_gop)
    # Verify the fixture actually contains leading pictures after a keyframe.
    assert any('K' in a['flags'] and float(b['pts_time']) < float(a['pts_time'])
               for a, b in zip(source, source[1:]))
    response = client.post('/api/movies/' + 'a' * 32 + '/play', json={
        'video_copy': True, 'browser_profile': 1, 'browser_fmp4': True,
        'audio_copy': False, 'audio_track': 1, 'start': start,
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['mode'] == 'Direct Stream'
    assert not result['audio_output']['copied']
    job = main.JOBS[result['session']]
    assert job['process'].wait(timeout=20) == 0
    playlist = job['folder'] / 'index.m3u8'
    assert playlist.read_text().count('#EXTINF:') >= 3
    output = video_packets(playlist)
    source_by_hash = {p['data_hash']: float(p['pts_time']) for p in source}
    # Match compressed payloads: no video encoding, and seeking may retain preroll.
    assert all(p['data_hash'] in source_by_hash for p in output)
    # Leading pictures before the initial random-access frame are discarded by
    # the decoder after a seek. Test presentation from that frame onwards,
    # including the leading pictures at every subsequent segment boundary.
    first_keyframe = next(p for p in output if 'K' in p['flags'])
    first_pts = source_by_hash[first_keyframe['data_hash']]
    output = [p for p in output if source_by_hash[p['data_hash']] >= first_pts]
    shifts = [float(p['pts_time']) - source_by_hash[p['data_hash']] for p in output]
    origin = statistics.median(shifts)
    # Matroska rounds to milliseconds. A GOP boundary must not shift a frame
    # by the 80-170 ms seen with FFmpeg's default sidx continuity adjustment.
    assert max(abs(shift - origin) for shift in shifts) < 0.002, [
        (i, output[i]['pts_time'], shift - origin) for i, shift in enumerate(shifts)
        if abs(shift - origin) >= 0.002]
    pts = sorted(float(p['pts_time']) for p in output)
    assert all(0.039 < b - a < 0.044 for a, b in zip(pts, pts[1:]))
