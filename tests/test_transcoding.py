from types import SimpleNamespace
import subprocess
import pytest
from app import transcoding


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
