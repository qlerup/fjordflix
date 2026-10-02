"""Validate GPU decoding/filtering on the actual source before using it for HLS."""
import subprocess
from functools import lru_cache


@lru_cache(maxsize=32)
def _probe(path, size, modified, height, cpu_filters, hdr):
    # HDR tone mapping still uses the existing CPU filters. CUDA can decode it
    # and return software frames; SDR decoding/scaling stays on the GPU.
    inputs = ('-hwaccel', 'cuda')
    filters = cpu_filters
    if not hdr:
        inputs += ('-hwaccel_output_format', 'cuda')
        filters = f'scale_cuda=-2:{height}:format=nv12'
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
               *inputs, '-i', path, '-map', '0:v:0', '-an', '-sn', '-vf', filters,
               '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']
    try:
        result = subprocess.run(command, capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return (), cpu_filters
    return (inputs, filters) if result.returncode == 0 else ((), cpu_filters)


def accelerated_filters(path, height, cpu_filters, *, enabled, hdr=False, burn=False, soft=False):
    if not enabled or burn or soft:
        return (), cpu_filters
    try:
        stat = path.stat()
    except OSError:
        return (), cpu_filters
    return _probe(str(path), stat.st_size, stat.st_mtime_ns, height, cpu_filters, hdr)
