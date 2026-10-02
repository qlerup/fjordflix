import pytest
from app import main


@pytest.mark.parametrize('direct,expected', [(True, 'Direct Play'), (False, 'Direct Stream')])
def test_auto_preserves_compatible_high_bitrate_when_server_bandwidth_is_unknown(direct, expected):
    meta = {'height': 1080, 'video': 'h264', 'pix_fmt': 'yuv420p', 'hdr': False, 'bitrate': 20000000}
    # A generic browser estimate of 5 Mbps used to trigger 480p transcoding.
    old = main.decide(meta, main.Playback(quality='auto', direct=direct, h264=True, bandwidth=5))
    assert old['mode'] == 'Transcoding' and old['height'] == 480
    actual = main.decide(meta, main.Playback(quality='auto', direct=direct, h264=True, bandwidth=0))
    assert actual['mode'] == expected and actual['height'] == 1080
    manual = main.decide(meta, main.Playback(quality='720', direct=direct, h264=True))
    assert manual['mode'] == 'Transcoding' and manual['height'] == 720
