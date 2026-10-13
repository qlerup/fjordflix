"""Bound FFmpeg work and recover HLS encoding without replacing served segments."""
import ctypes
import logging
import os
import re
import shutil
import signal
import subprocess
import time

from app import transcoding, hls_subtitles

log = logging.getLogger(__name__)
DISK_ERROR = 'Afspilningen er stoppet, fordi serveren har for lidt ledig diskplads. Frigør plads og start afspilningen igen.'
ENCODE_ERROR = 'Videokonverteringen mislykkedes. Prøv en lavere kvalitet eller start afspilningen igen.'


def reserve_bytes():
    return int(os.getenv('TRANSCODE_MIN_FREE_MB', '2048')) * 1024**2


def suspend(process, paused):
    if os.name == 'nt':
        # FFmpeg's interactive pause keys require a patched build. Suspend only
        # the owned child process, also when developing with stock FFmpeg.
        function = getattr(ctypes.WinDLL('ntdll'), 'NtSuspendProcess' if paused else 'NtResumeProcess')
        function.argtypes = [ctypes.c_void_p]
        function.restype = ctypes.c_long
        if function(int(process._handle)) != 0:
            raise OSError('Could not change FFmpeg suspension state')
    else:
        process.send_signal(signal.SIGSTOP if paused else signal.SIGCONT)


def resume(job):
    if job.get('paused'):
        if job['process'].poll() is None:
            suspend(job['process'], False)
        job['paused'] = False


def terminate(job):
    process = job['process']
    resume(job)
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    if process.stdout:
        process.stdout.close()


def fail(job, code, message):
    terminate(job)
    job.update(error={'code': code, 'message': message}, paused=False)
    job['log'].close()
    shutil.rmtree(job['folder'], ignore_errors=True)


def playlist_info(text):
    """Return complete segment start times and committed duration, not progress."""
    duration, pending = 0.0, None
    segments = {}
    for line in text.splitlines():
        if line.startswith('#EXTINF:'):
            pending = float(line.split(':', 1)[1].split(',', 1)[0])
        elif pending is not None and line and not line.startswith('#'):
            segments[line] = duration
            duration += pending
            pending = None
    return segments, duration


def playlist(job):
    try:
        return (job['folder'] / 'index.m3u8').read_text()
    except FileNotFoundError:
        return ''


def publish_cpu(job):
    if not job.get('prefix'):
        return
    try:
        text = (job['folder'] / 'cpu.m3u8').read_text()
    except FileNotFoundError:
        return
    # Publish only complete CPU segments after the original TS prefix.
    if not playlist_info(text)[0]:
        return
    subtitles = job.get('subtitles')
    if subtitles and 'cpu_mpegts' not in subtitles:
        first = next(iter(playlist_info(text)[0]))
        info = hls_subtitles.probe(['-select_streams', 'v:0', '-show_entries', 'stream=start_time'], job['folder'] / first)
        first_pts = float(info['streams'][0]['start_time'])
        subtitles['cpu_mpegts'] = round((first_pts - subtitles['origin'] - job['encoded_base']) * 90000) % (1 << 33)
    prefix = job['prefix'].splitlines()
    target = max(float(next(x.split(':')[1] for x in prefix if x.startswith('#EXT-X-TARGETDURATION:'))),
                 float(next(x.split(':')[1] for x in text.splitlines() if x.startswith('#EXT-X-TARGETDURATION:'))))
    prefix = [f'#EXT-X-TARGETDURATION:{int(target)}' if x.startswith('#EXT-X-TARGETDURATION:') else x for x in prefix]
    body = [x for x in text.splitlines() if not x.startswith(('#EXTM3U', '#EXT-X-VERSION:',
            '#EXT-X-TARGETDURATION:', '#EXT-X-MEDIA-SEQUENCE:', '#EXT-X-PLAYLIST-TYPE:'))]
    combined = '\n'.join([*prefix, '#EXT-X-DISCONTINUITY', *body]) + '\n'
    if combined == job.get('published_cpu'):
        return
    temporary = job['folder'] / 'publish.m3u8'
    temporary.write_text(combined)
    temporary.replace(job['folder'] / 'index.m3u8')
    job['published_cpu'] = combined


def fallback(job):
    """One CPU retry. Once served, preserve the prefix and switch at its boundary."""
    command = job.get('cpu_command')
    if not command or job.get('retried'):
        return False
    job['retried'] = True
    terminate(job)
    text = playlist(job)
    committed = playlist_info(text)[1] if job.get('ready') else 0
    command = list(command)
    if committed:
        prefix = '\n'.join(x for x in text.splitlines() if x != '#EXT-X-ENDLIST') + '\n'
        job.update(prefix=prefix, encoded_base=committed)
        seek = job['offset'] + committed
        if '-ss' in command:
            command[command.index('-ss') + 1] = str(seek)
        else:
            command[command.index('-i'):command.index('-i')] = ['-ss', str(seek)]
        # Extracted burn-in subtitles use source timestamps, including a retry.
        command = [x.replace(f"PTS-STARTPTS+{job['offset']}/TB", f'PTS-STARTPTS+{seek}/TB') for x in command]
        for index, argument in enumerate(command):
            if argument == '-hls_segment_filename':
                command[index + 1] = command[index + 1].replace('segment%', 'cpu_segment%')
        command[-1:-1] = ['-start_number', str(len(playlist_info(prefix)[0]))]
        # Keep timestamps advancing. TS continuity counters restart in the new
        # muxer and must be explicitly marked as a discontinuity.
        command[-1:-1] = ['-output_ts_offset', str(committed)]
        command[-1:-1] = ['-hls_segment_options', 'mpegts_flags=+initial_discontinuity']
        command[-1] = str(job['folder'] / 'cpu.m3u8')
        # FFmpeg can write ENDLIST when exiting unsuccessfully. Remove it before
        # a receiver mistakes the failed encode for the end of the film.
        temporary = job['folder'] / 'publish.m3u8'
        temporary.write_text(prefix)
        temporary.replace(job['folder'] / 'index.m3u8')
    else:
        for path in job['folder'].iterdir():
            if re.fullmatch(r'(index\.m3u8|init\.mp4|segment\d+\.(ts|m4s)(\.tmp)?|progress\.txt)', path.name):
                path.unlink(missing_ok=True)
    (job['folder'] / 'progress.txt').unlink(missing_ok=True)
    job['log'].write(b'\nGPU encoding failed; retrying with CPU.\n')
    job['log'].flush()
    job['process'] = subprocess.Popen(command, stdout=subprocess.PIPE if job.get('transport') == 'matroska' else subprocess.DEVNULL,
                                      stderr=job['log'], cwd=job['folder'])
    job.update(paused=False, encoder='CPU · HEVC' if 'libx265' in command else 'CPU · H.264')
    log.warning('GPU encoding failed; restarted stream on CPU at %.3f seconds', job['offset'] + committed)
    return True


def tick(job, data_dir):
    """Called under the jobs lock by the monitor and media request handlers."""
    if job.get('error'):
        return
    process = job['process']
    code = process.poll()
    if code is None or code != 0:
        if shutil.disk_usage(data_dir).free < reserve_bytes():
            fail(job, 507, DISK_ERROR)
            return
    if code not in (None, 0):
        # Native fMP4/Matroska decoders retain codec initialization. Reopen on
        # CPU at the actual playback position instead of splicing new headers.
        if (job.get('transport') == 'matroska' and job.get('bytes_sent') or
                job.get('transport') == 'fmp4' and job.get('ready')):
            job['cpu_required'] = bool(job.get('cpu_command') and not job.get('retried'))
            fail(job, 503, ENCODE_ERROR)
            return
        if not fallback(job):
            fail(job, 503, ENCODE_ERROR)
            return
    publish_cpu(job)
    if job['process'].poll() is not None or job.get('transport') == 'matroska':
        return
    text = playlist(job)
    segments, encoded = playlist_info(text)
    if len(segments) < 3:
        return
    buffer = max(10, float(os.getenv('TRANSCODE_BUFFER_SECONDS', '180')))
    ahead = encoded - job.get('delivered', 0)
    if not job.get('paused') and ahead >= buffer:
        suspend(job['process'], True)
        job['paused'] = True
    elif job.get('paused') and ahead <= buffer / 2:
        resume(job)


def delivered(job, filename):
    segments, _ = playlist_info(playlist(job))
    if filename in segments:
        # GET requests work for receivers that do not send playback heartbeats.
        # Prefetching may advance this watermark, but it is bounded by the client
        # buffer. HEAD requests must never advance it.
        job['delivered'] = max(job.get('delivered', 0), segments[filename])
        job.setdefault('recent_segments', {})[filename] = time.monotonic()


def cleanup(job, position):
    """Retire only committed media behind a managed client's actual playhead.

    Keep the EVENT timeline intact for timestamps and GPU/CPU continuation.
    Managed seeks open a new job; AirPlay and old clients retain all segments.
    """
    if (position is None or not job.get('cleanup_allowed') or job.get('error') or
            job.get('transport') == 'matroska' or os.getenv('TRANSCODE_CLEANUP', '1') != '1'):
        return
    segments, encoded = playlist_info(playlist(job))
    played = min(max(0, position - job['offset']), encoded, job.get('delivered', 0))
    cutoff = played - max(60, float(os.getenv('TRANSCODE_RETAIN_SECONDS', '180')))
    entries = list(segments.items())
    now = time.monotonic()
    recent = job.setdefault('recent_segments', {})
    removed = 0
    for index, (name, start) in enumerate(entries):
        end = entries[index + 1][1] if index + 1 < len(entries) else encoded
        if end >= cutoff:
            break
        if not re.fullmatch(r'(?:cpu_)?segment\d+\.(?:ts|m4s)', name):
            continue
        if now - recent.get(name, float('-inf')) < 60:
            continue
        path = job['folder'] / name
        try:
            size = path.stat().st_size
            path.unlink()
            removed += size
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning('Could not retire HLS segment %s: %s', name, exc)
            continue
        recent.pop(name, None)
    job['reclaimed_bytes'] = job.get('reclaimed_bytes', 0) + removed


def status(job):
    result = transcoding.progress(job['folder'])
    if 'encoded_seconds' in result:
        result['encoded_seconds'] += job.get('encoded_base', 0)
    result.update(paused=bool(job.get('paused')), encoder=job.get('encoder'), reclaimed_bytes=job.get('reclaimed_bytes', 0))
    if job.get('error'):
        result['error'] = job['error']['message']
        result['cpu_required'] = bool(job.get('cpu_required'))
    return result
