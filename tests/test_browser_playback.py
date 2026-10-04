"""Browser HDR fallback: reduce pixels before CPU tone mapping."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from test_tv import tv_client, login, main


@pytest.mark.skipif(os.getenv('FJORDFLIX_TEST_NVENC') != '1', reason='Opt-in NVIDIA GPU test')
@pytest.mark.parametrize('hdr', [False, True])
def test_real_4k_nvenc_segments_preserve_fractional_frame_cadence(tv_client, monkeypatch, hdr):
    client, credentials, mid = tv_client
    monkeypatch.setattr(main, 'GPU', True)
    row, _ = main.movie(mid)
    source = Path(row['path'])
    color = ['-pix_fmt','p010le','-bsf:v',
             'hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9'] if hdr else []
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=s=3840x2160:r=24000/1001:d=8',*color,
        '-c:v','hevc_nvenc','-preset','fast','-b:v','25M','-y',str(source)],
        check=True,capture_output=True,timeout=60)
    meta = main.probe(source)
    assert meta['hdr'] == hdr
    with main.db() as conn:
        conn.execute('UPDATE movies SET metadata=? WHERE id=?',(json.dumps(meta),mid))
    _, headers = login(client,credentials)
    response = client.post(f'/tv-api/movies/{mid}/play',headers=headers,json={'quality':'original'})
    assert response.status_code == 200, response.text
    result = response.json()
    try:
        print('Tested encoder:',result['encoder'])
        assert result['mode'] == 'Transcoding' and result['height'] == 2160
        job = main.JOBS[result['session']]
        job['process'].wait(timeout=30)
        assert job['process'].returncode == 0
        segments = sorted(job['folder'].glob('segment*.ts'))
        assert len(segments) == 4
        timestamps = []
        for segment in segments:
            inspected = subprocess.run(['ffprobe','-v','error','-select_streams','v:0',
                '-show_frames','-show_entries','frame=best_effort_timestamp_time,key_frame,width,height',
                '-of','json',str(segment)],check=True,capture_output=True,timeout=20)
            frames = json.loads(inspected.stdout)['frames']
            assert frames[0]['key_frame'] == 1
            assert (frames[0]['width'],frames[0]['height']) == (3840,2160)
            timestamps.extend(float(f['best_effort_timestamp_time']) for f in frames)
        assert len(timestamps) == 192
        assert all(abs(b-a-1001/24000) < 0.0001 for a,b in zip(timestamps,timestamps[1:]))
    finally:
        main.stop_job(result['session'])


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
