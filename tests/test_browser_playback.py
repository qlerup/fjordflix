"""Browser HDR fallback: reduce pixels before CPU tone mapping."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_tv import tv_client, login, main


def test_browser_hdr_downscale_before_tonemap(tv_client, monkeypatch):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('Real FFmpeg required')
    client, credentials, mid = tv_client
    monkeypatch.setattr(main, 'GPU', False)
    row, _ = main.movie(mid)
    source = Path(row['path'])
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
        'color=c=blue:s=1280x720:r=24:d=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le',
        '-x265-params', 'pools=1:frame-threads=1:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
        '-y', str(source)], check=True, capture_output=True, timeout=30)
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=? WHERE id=?', (json.dumps(main.probe(source)), mid))
    _, headers = login(client, credentials)
    response = client.post(f'/tv-api/movies/{mid}/play', headers=headers, json={'quality':'480'})
    assert response.status_code == 200, response.text
    result = response.json()
    try:
        assert result['mode'] == 'Transcoding' and result['height'] == 480
        job = main.JOBS[result['session']]
        job['process'].wait(timeout=20)
        command = job['process'].args
        filters = command[command.index('-vf') + 1]
        assert 'zscale=t=linear:npl=100:w=-2:h=480' in filters
        assert filters.index('h=480') < filters.index('tonemap=')
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json',
            str(job['folder'] / 'index.m3u8')], check=True, capture_output=True, timeout=20)
        video = json.loads(probe.stdout)['streams'][0]
        assert (video['width'], video['height'], video['codec_name']) == (854, 480, 'h264')
        assert video['color_transfer'] == video['color_primaries'] == video['color_space'] == 'bt709'
    finally:
        main.stop_job(result['session'])
