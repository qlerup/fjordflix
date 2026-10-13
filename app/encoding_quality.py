"""Conservative output sizing/rate policy; explicit quality remains a ceiling."""
import math
from fractions import Fraction


def frame_rate(meta):
    try:
        value = float(Fraction(str(meta.get('quality', {}).get('frame_rate') or 24)))
        return value if math.isfinite(value) and 1 <= value <= 240 else 24
    except (ValueError, ZeroDivisionError):
        return 24


def output(meta, height, ceiling, *, codec='h264', xbox=False, bandwidth=0, box=None):
    source_height = max(2, meta['height'])
    source_width = max(2, meta.get('width') or source_height * 16 / 9)
    # Fit wide cinema images as well as 16:9 into the requested resolution.
    width_limit = {480: 854, 720: 1280, 1080: 1920, 2160: 3840}
    box = box or next((h for h in width_limit if h >= height), 2160)
    ceiling = min(ceiling, {480: 2, 720: 4, 1080: 8, 2160: 25}[box])
    height = max(2, int(min(height, source_height, width_limit[box] * source_height / source_width)) // 2 * 2)
    fps_factor = math.sqrt(min(frame_rate(meta), 60) / 24)
    pixels = (source_width * height / source_height) * height
    reference = width_limit[box] * box
    rate = ceiling * min(1, pixels / reference) ** 0.75 * fps_factor
    if codec == 'hevc':
        rate *= 0.75
    # Decoder budgets already used by the Xbox capability probe.
    rate = min(rate, (25 if codec == 'hevc' else 8) if xbox else ceiling * 1.6)
    source_rate = meta.get('bitrate', 0) / 1e6
    if source_rate > 0:
        # HEVC/AV1 sources need more bits when converted to H.264. Container
        # bitrate includes audio, so this is deliberately a conservative cap.
        factor = 1.6 if codec == 'h264' and meta.get('video') in ('hevc', 'av1', 'vp9') else 1
        rate = min(rate, source_rate * factor)
    if bandwidth:
        rate = min(rate, max(0.1, bandwidth * 0.7 - 0.3))
    return height, round(max(0.1, rate), 2)
