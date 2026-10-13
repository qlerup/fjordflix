import json
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from app import stream_control as control, transcoding, hls_subtitles


def manifest(count=6, prefix='segment', start=0, end=False, init=None):
    return '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' + (
        f'#EXT-X-MAP:URI="{init}"\n' if init else '') + ''.join(
        f'#EXTINF:2,\n{prefix}{i:05d}.ts\n' for i in range(start, start+count)) + ('#EXT-X-ENDLIST\n' if end else '')


@pytest.fixture
def job(tmp_path, monkeypatch):
    monkeypatch.setattr(control.shutil, 'disk_usage', lambda _: SimpleNamespace(free=10 * 1024**3))
    (tmp_path/'index.m3u8').write_text(manifest())
    job = {'folder':tmp_path, 'process':Mock(poll=Mock(return_value=None), stdout=None),
           'log':(tmp_path/'ffmpeg.log').open('wb'), 'offset':30, 'encoder':'NVIDIA NVENC'}
    yield job
    job['log'].close()


def test_buffer_pauses_and_resumes_only_as_segments_are_requested(job, monkeypatch):
    monkeypatch.setenv('TRANSCODE_BUFFER_SECONDS', '10')
    changes = []
    monkeypatch.setattr(control, 'suspend', lambda p, state: changes.append(state))
    control.tick(job, job['folder'])
    control.tick(job, job['folder'])
    assert changes == [True] and job['paused']
    control.delivered(job, 'segment00004.ts')
    control.tick(job, job['folder'])
    assert changes == [True, False] and not job['paused']
    control.delivered(job, 'segment00000.ts')
    assert job['delivered'] == 8


def test_stop_resumes_paused_child_before_termination(job, monkeypatch):
    job['paused'] = True
    events = []
    monkeypatch.setattr(control, 'suspend', lambda *args: events.append('resume'))
    job['process'].terminate.side_effect = lambda: events.append('terminate')
    control.terminate(job)
    assert events == ['resume','terminate']


def test_low_disk_stops_job_removes_files_and_preserves_clear_error(job, monkeypatch):
    monkeypatch.setattr(control.shutil, 'disk_usage', lambda _: SimpleNamespace(free=100))
    control.tick(job, job['folder'])
    assert job['error']['code'] == 507 and 'diskplads' in job['error']['message']
    job['process'].terminate.assert_called_once()
    assert not job['folder'].exists()
    control.tick(job, job['folder'])
    assert control.status(job)['error'] == control.DISK_ERROR


def test_completed_job_is_not_destroyed_when_disk_becomes_low(job, monkeypatch):
    job['process'].poll.return_value = 0
    monkeypatch.setattr(control.shutil, 'disk_usage', lambda _: SimpleNamespace(free=0))
    control.tick(job, job['folder'])
    assert 'error' not in job and (job['folder']/'index.m3u8').exists()


def test_media_head_does_not_advance_buffer_and_foreign_user_cannot_control_job(job, monkeypatch):
    from app import main
    from starlette.requests import Request
    job['user'] = 'owner'
    (job['folder']/'segment00004.ts').write_bytes(b'segment')
    monkeypatch.setattr(main,'JOBS',{'owned':job})
    monkeypatch.setattr(main,'DATA',job['folder'])
    monkeypatch.setenv('TRANSCODE_BUFFER_SECONDS','10')
    changes = []
    monkeypatch.setattr(control,'suspend',lambda p,paused: changes.append(paused))
    with pytest.raises(main.HTTPException) as error:
        main.stream_file('owned','segment00004.ts',{'id':'foreign'})
    assert error.value.status_code == 404 and changes == []
    main.stream_file('owned','segment00004.ts',{'id':'owner'},Request({'type':'http','method':'HEAD','headers':[]}))
    assert job.get('delivered',0) == 0 and changes == [True]
    main.stream_file('owned','segment00004.ts',{'id':'owner'},Request({'type':'http','method':'GET','headers':[]}))
    assert job['delivered'] == 8 and changes == [True,False]


def test_disk_error_is_returned_by_heartbeat_and_media_routes(job, monkeypatch):
    from app import main
    job['user'] = 'owner'
    monkeypatch.setattr(main,'JOBS',{'owned':job})
    monkeypatch.setattr(main,'DATA',job['folder'])
    monkeypatch.setattr(control.shutil,'disk_usage',lambda _:SimpleNamespace(free=0))
    for call in [lambda:main.heartbeat('owned',{'id':'owner'}),
                 lambda:main.stream_file('owned','index.m3u8',{'id':'owner'})]:
        with pytest.raises(main.HTTPException) as error:
            call()
        assert error.value.status_code == 507 and 'diskplads' in error.value.detail


def test_cpu_command_removes_gpu_decode_scaling_and_encoder_for_both_codecs():
    for encoder, expected in [('h264_nvenc','libx264'),('hevc_nvenc','libx265')]:
        hw = ('-hwaccel','cuda','-hwaccel_output_format','cuda')
        cmd = ['ffmpeg',*hw,'-i','source.mkv','-vf','scale_cuda=-2:720',
               '-c:v',encoder,'-preset','fast','-forced-idr','1','-c:a','copy','output.m3u8']
        cpu = transcoding.cpu_command(cmd, hw, 'scale=-2:720,format=yuv420p')
        assert not any('cuda' in x or 'nvenc' in x for x in cpu)
        assert cpu[cpu.index('-c:v')+1] == expected and '-forced-idr' not in cpu
        assert cpu[cpu.index('-c:a')+1] == 'copy'
        assert cpu[cpu.index('-vf')+1] == 'scale=-2:720,format=yuv420p'


def test_cpu_bitmap_overlay_preserves_selected_subtitle():
    cmd = ['ffmpeg','-i','source','-filter_complex','GPU graph','-c:v','h264_nvenc','-preset','fast','output']
    cpu = transcoding.cpu_command(cmd, (), 'cpu-filters', bitmap=True, subtitle_index=4)
    assert cpu[cpu.index('-filter_complex')+1] == transcoding.bitmap_overlay('cpu-filters',4)


def test_startup_retries_once_and_discards_unserved_gpu_files(job, monkeypatch):
    job['process'].poll.return_value = 1
    job['cpu_command'] = ['ffmpeg','-i','source','-c:v','libx264',str(job['folder']/'index.m3u8')]
    cpu = Mock(poll=Mock(return_value=None), stdout=None)
    monkeypatch.setattr(control.subprocess,'Popen',Mock(return_value=cpu))
    control.tick(job,job['folder'])
    assert job['retried'] and job['process'] is cpu and job['encoder'] == 'CPU · H.264'
    assert not (job['folder']/'index.m3u8').exists()
    cpu.poll.return_value = 1
    control.tick(job,job['folder'])
    assert job['error']['code'] == 503
    control.subprocess.Popen.assert_called_once()


def test_live_fallback_preserves_segments_and_subtitle_source_offset(job, monkeypatch):
    job.update(ready=True, cpu_command=['ffmpeg','-ss','30','-i','source','-vf','setpts=PTS-STARTPTS+30/TB',
        '-c:v','libx264','-hls_segment_filename',str(job['folder']/'segment%05d.ts'),str(job['folder']/'index.m3u8')])
    job['process'].poll.return_value = 1
    original = manifest(count=3,end=True)
    (job['folder']/'index.m3u8').write_text(original)
    popen = Mock(return_value=Mock(poll=Mock(return_value=None),stdout=None))
    monkeypatch.setattr(control.subprocess,'Popen',popen)
    control.tick(job,job['folder'])
    args = popen.call_args.args[0]
    assert args[args.index('-ss')+1] == '36.0'
    assert 'setpts=PTS-STARTPTS+36.0/TB' in args
    assert args[args.index('-start_number')+1] == '3'
    assert args[args.index('-output_ts_offset')+1] == '6.0'
    (job['folder']/'cpu.m3u8').write_text(manifest(2,'cpu_segment',3,True))
    control.tick(job,job['folder'])
    text = control.playlist(job)
    assert text.count('#EXT-X-DISCONTINUITY') == 1 and text.count('#EXT-X-ENDLIST') == 1
    assert text.index('segment00002.ts') < text.index('#EXT-X-DISCONTINUITY') < text.index('cpu_segment00003.ts')
    assert control.playlist_info(text)[1] == 10


def test_matroska_failure_after_bytes_requests_client_cpu_reopen(job):
    job.update(transport='matroska',bytes_sent=True,cpu_command=['ffmpeg'])
    job['process'].poll.return_value = 1
    control.tick(job,job['folder'])
    assert job['cpu_required'] and control.status(job)['cpu_required']


def test_native_fmp4_failure_requests_cpu_reopen_instead_of_changing_headers(job):
    job.update(transport='fmp4',ready=True,cpu_command=['ffmpeg'])
    job['process'].poll.return_value = 1
    control.tick(job,job['folder'])
    assert job['cpu_required'] and job['error']['code'] == 503


def test_airplay_subtitle_timeline_survives_cpu_discontinuity():
    text = manifest(3) + '#EXT-X-DISCONTINUITY\n' + '#EXTINF:2,\ncpu_segment00003.ts\n'
    rendition = hls_subtitles.rendition_playlist(text)
    assert 'subtitle00003.vtt' in rendition and 'cpu_segment' not in rendition
    state = {'origin':30,'mpegts':126000-30*90000,'cpu_mpegts':123456,'cues':[(36,38,'00:00:36.000 --> 00:00:38.000\nCPU cue')]}
    result = hls_subtitles.segment_text(state,text,3)
    assert 'CPU cue' in result and 'MPEGTS:123456' in result


@pytest.mark.parametrize('fmp4',[False,True])
def test_real_ffmpeg_cpu_continuation_decodes_complete_hls(tmp_path, monkeypatch, fmp4):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('Real FFmpeg required')
    source = tmp_path/'source.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=24:d=16',
        '-f','lavfi','-i','sine=frequency=440:duration=16','-c:v','libx264','-preset','ultrafast',
        '-g','48','-c:a','aac','-y',str(source)],check=True,capture_output=True,timeout=15)
    cmd = ['ffmpeg','-v','error','-nostdin','-progress',str(tmp_path/'progress.txt'),'-i',str(source),
        '-c:v','libx264','-preset','veryfast','-force_key_frames','expr:gte(t,n_forced*2)',
        '-c:a','aac','-f','hls','-hls_time','2','-hls_list_size','0','-hls_playlist_type','event','-hls_flags','temp_file']
    if fmp4:
        cmd += ['-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4']
    cmd += ['-hls_segment_filename',str(tmp_path/('segment%05d.m4s' if fmp4 else 'segment%05d.ts')),str(tmp_path/'index.m3u8')]
    first = list(cmd)
    first[first.index('-c:v'):first.index('-c:v')] = ['-t','6']
    subprocess.run(first,check=True,capture_output=True,timeout=15)
    failed = subprocess.Popen([sys.executable,'-c','raise SystemExit(1)'])
    failed.wait(timeout=5)
    job = {'folder':tmp_path,'process':failed,'log':(tmp_path/'ffmpeg.log').open('wb'),
        'offset':0,'ready':not fmp4,'cpu_command':cmd}
    monkeypatch.setattr(control.shutil,'disk_usage',lambda _:SimpleNamespace(free=10*1024**3))
    try:
        control.tick(job,tmp_path)
        job['process'].wait(timeout=15)
        assert job['process'].returncode == 0
        control.tick(job,tmp_path)
        playlist = tmp_path/'index.m3u8'
        text = playlist.read_text()
        assert text.count('#EXT-X-ENDLIST') == 1
        assert ('#EXT-X-DISCONTINUITY' in text) == (not fmp4)
        assert abs(control.playlist_info(text)[1]-16) < .15
        decoded = subprocess.run(['ffprobe','-v','error','-count_frames','-select_streams','v:0',
            '-show_entries','stream=nb_read_frames','-of','json',str(playlist)],check=True,capture_output=True,timeout=15)
        assert int(json.loads(decoded.stdout)['streams'][0]['nb_read_frames']) == 384
        subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(playlist),'-f','null','-'],check=True,capture_output=True,timeout=15)
    finally:
        control.terminate(job)
        job['log'].close()


def test_real_child_stops_advancing_and_resumes(tmp_path):
    path = tmp_path/'counter'
    # Windows venv python.exe is a redirector that spawns another process. Like
    # FFmpeg, use the actual executable whose threads we intend to suspend.
    process = subprocess.Popen([getattr(sys,'_base_executable',sys.executable),'-c',
        'import pathlib,time,sys\np=pathlib.Path(sys.argv[1])\ni=0\nwhile True:\n i+=1\n p.write_text(str(i))\n time.sleep(.02)',str(path)])
    job = {'process':process}
    try:
        deadline = time.monotonic()+5
        while not path.exists() and time.monotonic()<deadline:
            time.sleep(.02)
        control.suspend(process,True)
        job['paused'] = True
        time.sleep(.1)
        value = path.read_text()
        time.sleep(.15)
        assert path.read_text() == value
        control.resume(job)
        time.sleep(.15)
        assert int(path.read_text()) > int(value)
    finally:
        control.terminate(job)


@pytest.mark.parametrize('hevc',[False,True])
def test_play_route_recovers_failed_nvenc_with_real_cpu_output(tmp_path, monkeypatch, hevc):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('Real FFmpeg required')
    from app import main
    from starlette.requests import Request
    source = tmp_path/'source.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=24:d=8',
                    '-c:v','libx264','-y',str(source)],check=True,capture_output=True,timeout=15)
    meta = main.probe(source)
    row = {'id':'fixture','title':'CPU recovery','path':str(source)}
    monkeypatch.setattr(main,'DATA',tmp_path)
    (tmp_path/'streams').mkdir()
    monkeypatch.setattr(main,'GPU',True)
    monkeypatch.setattr(main,'movie',lambda _: (row,meta))
    monkeypatch.setattr(main.media,'issue',lambda result,*args,**kwargs: result)
    monkeypatch.setattr(main.active_streams,'begin',lambda result,*args,**kwargs: result)
    monkeypatch.setattr(main.transcoding,'hevc_encoder',lambda gpu: 'hevc_nvenc' if gpu else 'libx265')
    monkeypatch.setattr(main.transcoding,'accelerated_filters',lambda path,height,filters,**kw: ((),filters))
    actual_popen = subprocess.Popen
    calls = []
    def launch(command,**kwargs):
        calls.append(list(command))
        command = list(command)
        if '-c:v' in command and command[command.index('-c:v')+1].endswith('_nvenc'):
            command[command.index('-c:v')+1] = 'deliberately_unavailable_nvenc'
        return actual_popen(command,**kwargs)
    monkeypatch.setattr(main.subprocess,'Popen',launch)
    data = main.Playback(client_profile='xbox' if hevc else 'default',quality='2160' if hevc else '480',hevc_output=hevc)
    request = Request({'type':'http','method':'POST','headers':[]})
    result = main.play('fixture',data,request,{'id':'owner','name':'Owner'})
    sid = result['session']
    try:
        job = main.JOBS[sid]
        job['process'].wait(timeout=15)
        assert job['retried'] and result['encoder'].startswith('CPU')
        encoder = 'libx265' if hevc else 'libx264'
        assert len(calls) == 2 and encoder in calls[-1]
        assert not any('cuda' in x or 'nvenc' in x for x in calls[-1])
        output = job['folder']/'index.m3u8'
        info = subprocess.run(['ffprobe','-v','error','-show_streams','-of','json',str(output)],check=True,capture_output=True,timeout=15)
        video = json.loads(info.stdout)['streams'][0]
        assert video['codec_name'] == ('hevc' if hevc else 'h264')
        assert (video['width'],video['height']) == (160,90)
        subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(output),'-f','null','-'],check=True,capture_output=True,timeout=15)
    finally:
        main.stop_job(sid)
