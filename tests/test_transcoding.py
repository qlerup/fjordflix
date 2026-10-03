from types import SimpleNamespace
import subprocess
import json
import shutil
import pytest
from app import transcoding


def test_progress_ignores_partial_records_and_nonfinite_values(tmp_path):
    path = tmp_path / 'progress.txt'
    path.write_text('out_time_us=6000000\nspeed=1.25x\nprogress=continue\nout_time_us=9000000\nspeed=0.5x\n')
    assert transcoding.progress(tmp_path) == {'finished':False, 'encoded_seconds':6, 'speed':1.25}
    path.write_text('out_time_us=9000000\nspeed=0.5x\nprogress=continue\n')
    assert transcoding.progress(tmp_path)['speed'] == 0.5
    path.write_text('out_time_us=N/A\nspeed=nanx\nprogress=end\n')
    assert transcoding.progress(tmp_path) == {'finished':True}
    path.write_text('speed=3x\n')
    assert transcoding.progress(tmp_path) == {}


def test_scaled_hdr_pipeline_outputs_decodable_sdr_with_expected_dimensions(tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('Real FFmpeg is required')
    target = tmp_path / 'sdr.mp4'
    filters = ['setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
               *transcoding.hdr_filters(90), 'format=yuv420p']
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',
                    'color=c=blue:s=320x180:r=24:d=0.5,format=yuv420p10le',
                    '-vf',','.join(filters),'-c:v','libx264','-y',str(target)],
                   check=True,capture_output=True,timeout=20)
    result = subprocess.run(['ffprobe','-v','error','-show_streams','-of','json',str(target)],
                            check=True,capture_output=True,timeout=20)
    video = json.loads(result.stdout)['streams'][0]
    assert (video['width'], video['height'], video['pix_fmt']) == (160,90,'yuv420p')
    assert video['color_transfer'] == video['color_primaries'] == video['color_space'] == 'bt709'
    subprocess.run(['ffmpeg','-v','error','-i',str(target),'-f','null','-'],
                   check=True,capture_output=True,timeout=20)


@pytest.fixture
def video(tmp_path):
    transcoding._probe.cache_clear()
    path = tmp_path / 'video.mkv'
    path.write_bytes(b'test')
    return path


def test_sdr_decoding_and_scaling_stay_on_gpu(video, monkeypatch):
    commands = []
    monkeypatch.setattr(transcoding.subprocess, 'run', lambda cmd, **kw: commands.append(cmd) or SimpleNamespace(returncode=0))
    args, filters = transcoding.accelerated_filters(video, 1080, 'scale=-2:1080,format=yuv420p', enabled=True)
    assert args == ('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda')
    assert filters == 'scale_cuda=-2:1080:format=nv12'
    transcoding.accelerated_filters(video, 1080, 'scale=-2:1080,format=yuv420p', enabled=True)
    assert len(commands) == 1


def test_hdr_keeps_cpu_tonemapping_with_gpu_decode(video, monkeypatch):
    commands = []
    def run(cmd, **kw):
        commands.append(cmd)
        return SimpleNamespace(returncode=1 if '-init_hw_device' in cmd else 0, stderr=b'OpenCL unavailable')
    monkeypatch.setattr(transcoding.subprocess, 'run', run)
    args, filters = transcoding.accelerated_filters(video, 1080, 'tonemap,scale', enabled=True, hdr=True)
    assert args == ('-hwaccel', 'cuda')
    assert filters == 'tonemap,scale'
    assert len(commands) == 2


def test_hdr_prefers_gpu_tonemapping_and_preserves_sdr_output_colors(video, monkeypatch):
    commands = []
    monkeypatch.setattr(transcoding.subprocess, 'run', lambda cmd, **kw: commands.append(cmd) or SimpleNamespace(returncode=0))
    args, filters = transcoding.accelerated_filters(video, 2160, 'cpu-tonemap', enabled=True, hdr=True)
    assert '-init_hw_device' in args and '-hwaccel' in args
    assert 'device_vendor=NVIDIA' in args[1]
    assert 'tonemap_opencl=' in filters and 't=bt709:p=bt709:m=bt709:r=tv' in filters
    assert 'hwdownload,format=nv12' in filters
    assert 'scale=-2:2160' in filters
    assert len(commands) == 1


def test_hdr_falls_back_when_both_gpu_probes_fail(video, monkeypatch):
    monkeypatch.setattr(transcoding.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=1, stderr=b'GPU unavailable'))
    assert transcoding.accelerated_filters(video, 2160, 'cpu-tonemap', enabled=True, hdr=True) == ((), 'cpu-tonemap')


@pytest.mark.parametrize('failure', ['unsupported', 'timeout', 'missing'])
def test_probe_failures_preserve_existing_pipeline(video, monkeypatch, failure):
    def run(*a, **kw):
        if failure == 'timeout': raise subprocess.TimeoutExpired('ffmpeg', 5)
        if failure == 'missing': raise OSError('unavailable')
        return SimpleNamespace(returncode=1, stderr=b'unsupported')
    monkeypatch.setattr(transcoding.subprocess, 'run', run)
    assert transcoding.accelerated_filters(video, 1080, 'cpu', enabled=True) == ((), 'cpu')


@pytest.mark.parametrize('options', [{'enabled':False}, {'enabled':True,'burn':True}, {'enabled':True,'soft':True}])
def test_cpu_and_subtitle_paths_do_not_probe(video, monkeypatch, options):
    def unexpected(*a, **kw): raise AssertionError('GPU should not be probed')
    monkeypatch.setattr(transcoding.subprocess, 'run', unexpected)
    assert transcoding.accelerated_filters(video, 720, 'cpu', **options) == ((), 'cpu')
