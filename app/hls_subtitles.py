"""WebVTT renditions using the video's segment boundaries and MPEG-TS clock."""
import json
import re
import subprocess

STAMP = r'(?:\d+:)?\d{2}:\d{2}\.\d{3}'
TIMING = re.compile(rf'^({STAMP}) --> ({STAMP})(?: .*)?$')
SEGMENT = re.compile(r'^segment(\d+)\.ts$')


def seconds(stamp):
    value = 0.0
    for part in stamp.split(':'):
        value = value * 60 + float(part)
    return value


def read_cues(path):
    cues = []
    for block in re.split(r'\n\s*\n', path.read_text(encoding='utf-8-sig').replace('\r\n', '\n')):
        lines = block.strip().splitlines()
        for line in lines[:2]:
            match = TIMING.fullmatch(line)
            if match:
                cues.append((seconds(match[1]), seconds(match[2]), '\n'.join(lines)))
                break
    return cues


def probe(args, path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                             *args, '-of', 'json', str(path)], capture_output=True, timeout=15, check=True)
    return json.loads(result.stdout)


def source_origin(path, offset):
    # Stream copying retains the keyframe preceding the requested seek. It must
    # be used for subtitle mapping rather than pretending the seek was exact.
    info = probe(['-show_entries', 'format=start_time'], path)
    start = float(info.get('format', {}).get('start_time', 0))
    info = probe(['-select_streams', 'v:0', '-read_intervals', f'{offset + start}%+#1',
                  '-show_entries', 'packet=pts_time'], path)
    return float(info['packets'][0]['pts_time']) - start


def prepare(folder, source, subtitle, offset, remux):
    info = probe(['-select_streams', 'v:0', '-show_entries', 'stream=start_time'], folder/'segment00000.ts')
    first_pts = float(info['streams'][0]['start_time'])
    origin = source_origin(source, offset) if remux else offset
    return {'cues': read_cues(subtitle), 'origin': origin,
            'mpegts': round((first_pts - origin) * 90000) % (1 << 33)}


def rendition_playlist(video_playlist):
    lines = []
    for line in video_playlist.splitlines():
        match = SEGMENT.fullmatch(line)
        if match:
            line = f'subtitle{match[1]}.vtt'
        elif line.startswith('#EXT-X-VERSION:'):
            line = '#EXT-X-VERSION:6'
        lines.append(line)
    return '\n'.join(lines) + '\n'


def segment_text(state, video_playlist, number):
    elapsed, duration = 0.0, None
    for line in video_playlist.splitlines():
        if line.startswith('#EXTINF:'):
            duration = float(line.split(':', 1)[1].split(',')[0])
        match = SEGMENT.fullmatch(line)
        if match and duration is not None:
            if int(match[1]) == number:
                start, end = state['origin'] + elapsed, state['origin'] + elapsed + duration
                blocks = [block for a, b, block in state['cues'] if a < end and b > start]
                # Repeat spanning cues, with their full timestamps, in every
                # intersecting segment as required by RFC 8216 section 3.5.
                return f"WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:{state['mpegts']}\n\n" + '\n\n'.join(blocks) + '\n'
            elapsed += duration
            duration = None
    raise KeyError(number)


def master(result, subtitle):
    language = str(subtitle.get('language', 'und'))
    language = {'dan':'da','eng':'en','swe':'sv','nor':'no','nob':'nb','deu':'de','ger':'de','fra':'fr','fre':'fr','spa':'es'}.get(language, language)
    if not re.fullmatch(r'[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*', language):
        language = 'und'
    # Label is deliberately stable: the native text-track API uses it to apply
    # the user's explicit selection instead of the receiver's language defaults.
    bandwidth = max(256000, int(result['mbps'] * 1_000_000 * 1.25) + 256000)
    return ('#EXTM3U\n#EXT-X-VERSION:6\n'
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="FjordFlix",'
            f'LANGUAGE="{language}",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subtitles.m3u8"\n'
            f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},SUBTITLES="text"\nindex.m3u8\n')
