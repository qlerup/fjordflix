"""Source quality only: never infer Dolby formats from filenames or channel count."""
import json
import shutil
import subprocess


def source_quality(video, audio, tracks=()):
    side_data = video.get('side_data_list', [])
    transfer = video.get('color_transfer')
    dynamic_range = {'smpte2084': 'HDR10', 'arib-std-b67': 'HLG'}.get(transfer, 'SDR')
    if any(s.get('side_data_type') == 'DOVI configuration record' for s in side_data):
        dynamic_range = 'Dolby Vision'
    profile = str(audio.get('profile', ''))
    atmos = 'atmos' in profile.lower()
    for track in tracks:
        if track.get('@type') == 'Video':
            hdr = str(track.get('HDR_Format', ''))
            if 'Dolby Vision' in hdr:
                dynamic_range = 'Dolby Vision'
            elif '2094-40' in hdr and dynamic_range != 'Dolby Vision':
                dynamic_range = 'HDR10+'
            break
    # Playback currently uses the first audio stream, so describe that same stream.
    first_audio = next((t for t in tracks if t.get('@type') == 'Audio'), {})
    features = str(first_audio.get('Format_AdditionalFeatures', '')).split()
    atmos = atmos or ('JOC' in features and audio.get('codec_name') == 'eac3') or (
        first_audio.get('Format') == 'MLP FBA' and '16-ch' in features and audio.get('codec_name') == 'truehd')
    return {'version': 1, 'dynamic_range': dynamic_range, 'audio_codec': audio.get('codec_name'),
            'audio_profile': profile, 'audio_channels': audio.get('channels'),
            'audio_layout': audio.get('channel_layout', ''), 'dolby_atmos': bool(atmos)}


def inspect(video, audio, path):
    tracks = []
    if shutil.which('mediainfo'):
        try:
            result = subprocess.run(['mediainfo', '--Output=JSON', str(path)], capture_output=True, timeout=30)
            if result.returncode == 0:
                tracks = json.loads(result.stdout).get('media', {}).get('track', [])
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
    return {**source_quality(video, audio, tracks), 'mediainfo': bool(tracks)}
