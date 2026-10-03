"""Validate GPU decoding/filtering on the actual source before using it for HLS."""
import subprocess
import logging
import math
from functools import lru_cache

log = logging.getLogger(__name__)


def hdr_filters(height=None):
    # Scale in linear light before the expensive float RGB tone mapper. The
    # current Xbox H.264 fallback is Full HD; processing 4K pixels wastes CPU work.
    size = f':w=-2:h={height}' if height else ''
    return [f'zscale=t=linear:npl=100{size}', 'format=gbrpf32le', 'zscale=p=bt709',
            'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv']


def progress(folder):
    """Read only the last complete FFmpeg progress record, never expose logs/paths."""
    try:
        with (folder / 'progress.txt').open('rb') as stream:
            stream.seek(0, 2)
            size = stream.tell()
            stream.seek(max(0, size - 16384))
            text = stream.read(16384).decode('ascii', errors='ignore')
    except OSError:
        return {}
    lines = text.splitlines()
    ends = [i for i, line in enumerate(lines) if line in ('progress=continue', 'progress=end')]
    if not ends:
        return {}
    end = ends[-1]
    start = ends[-2] + 1 if len(ends) > 1 else 0
    fields = dict(line.split('=', 1) for line in lines[start:end + 1] if '=' in line)
    result = {'finished': fields.get('progress') == 'end'}
    for field, key, divisor in [('speed', 'speed', 1), ('out_time_us', 'encoded_seconds', 1000000)]:
        try:
            value = float(fields[field].rstrip('x')) / divisor
            if math.isfinite(value) and value >= 0:
                result[key] = round(value, 3)
        except (KeyError, ValueError):
            pass
    return result


def _works(path, inputs, filters):
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
               *inputs, '-i', path, '-map', '0:v:0', '-an', '-sn', '-vf', filters,
               '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']
    try:
        result = subprocess.run(command, capture_output=True, timeout=5)
        if result.returncode == 0:
            return True
        log.warning('GPU filter probe failed: %s', result.stderr.decode(errors='replace')[-1500:])
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning('GPU filter probe unavailable: %s', exc)
    return False


@lru_cache(maxsize=32)
def _probe(path, size, modified, height, cpu_filters, hdr):
    if hdr:
        # CUDA decodes to software frames for OpenCL upload. The expensive HDR
        # conversion runs on the NVIDIA GPU; CPU scaling remains after download.
        opencl_inputs = ('-init_hw_device', 'opencl=ocl:,device_type=gpu,device_vendor=NVIDIA',
                         '-filter_hw_device', 'ocl', '-hwaccel', 'cuda')
        opencl_filters = ('format=p010,hwupload,'
                          'tonemap_opencl=tonemap=hable:desat=0:t=bt709:p=bt709:m=bt709:r=tv:format=nv12,'
                          f'hwdownload,format=nv12,scale=-2:{height},format=yuv420p')
        if _works(path, opencl_inputs, opencl_filters):
            return opencl_inputs, opencl_filters
    # Keep the existing CPU tone mapper if OpenCL is unavailable.
    inputs = ('-hwaccel', 'cuda')
    filters = cpu_filters
    if not hdr:
        inputs += ('-hwaccel_output_format', 'cuda')
        filters = f'scale_cuda=-2:{height}:format=nv12'
    return (inputs, filters) if _works(path, inputs, filters) else ((), cpu_filters)


def accelerated_filters(path, height, cpu_filters, *, enabled, hdr=False, burn=False, soft=False):
    if not enabled or burn or soft:
        return (), cpu_filters
    try:
        stat = path.stat()
    except OSError:
        return (), cpu_filters
    return _probe(str(path), stat.st_size, stat.st_mtime_ns, height, cpu_filters, hdr)
