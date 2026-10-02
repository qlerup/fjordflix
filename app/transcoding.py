"""Validate GPU decoding/filtering on the actual source before using it for HLS."""
import subprocess
import logging
from functools import lru_cache

log = logging.getLogger(__name__)


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
