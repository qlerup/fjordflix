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


def test_auto_4k_transcode_is_opt_in_for_browser_only():
    meta = {'width':3840, 'height':2160, 'video':'hevc', 'pix_fmt':'yuv420p10le',
            'hdr':True, 'bitrate':30000000}
    options = {'browser_profile':1, 'browser_4k_transcode':True}
    assert main.decide(meta, main.Playback(**options))['height'] == 2160
    for patch in ({'browser_profile':0}, {'browser_4k_transcode':False}, {'airplay':True},
                  {'client_profile':'xbox'}, {'quality':'1080'}, {'bandwidth':12}):
        assert main.decide(meta, main.Playback(**{**options, **patch}))['height'] == 1080
    for direct, mode in ((True, 'Direct Play'), (False, 'Direct Stream')):
        result = main.decide(meta, main.Playback(**options, direct=direct, video_copy=True))
        assert result['mode'] == mode and result['height'] == 2160


def test_auto_4k_fits_wide_movies_and_never_upscales():
    meta = {'width':3840, 'height':1600, 'video':'hevc', 'pix_fmt':'yuv420p10le',
            'hdr':True, 'bitrate':30000000}
    options = main.Playback(browser_profile=1, browser_4k_transcode=True)
    assert main.decide(meta, options)['height'] == 1600
    assert main.decide({**meta, 'width':1920, 'height':1080}, options)['height'] == 1080
