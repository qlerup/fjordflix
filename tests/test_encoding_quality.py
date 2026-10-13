import pytest
from app import encoding_quality as quality, main


def source(**overrides):
    return dict(width=1920, height=1080, bitrate=20000000, video='h264',
                **overrides)


def test_frame_rate_changes_budget_but_unknown_metadata_is_safe():
    film = source(quality={'frame_rate': '24000/1001'})
    sport = source(quality={'frame_rate': '60000/1001'})
    assert quality.output(film, 1080, 8)[1] < quality.output(sport, 1080, 8)[1] <= 12.8
    for value in ('0/0', 'N/A', 'nan', '-1', '1/999999', None):
        assert quality.frame_rate(source(quality={'frame_rate': value})) == 24


def test_hevc_efficiency_source_rate_and_client_budget():
    meta = source()
    assert quality.output(meta, 1080, 8, codec='hevc')[1] < quality.output(meta, 1080, 8)[1]
    meta['bitrate'] = 1500000
    assert quality.output(meta, 1080, 8)[1] == 1.5
    meta.update(bitrate=100000000, quality={'frame_rate': '60'})
    assert quality.output(meta, 1080, 8, xbox=True)[1] == 8
    assert quality.output(meta, 1080, 8, bandwidth=3)[1] == 1.8


def test_wide_video_fits_requested_box_without_upscaling():
    meta = source()
    meta.update(width=3840, height=1608)
    height, rate = quality.output(meta, 720, 4)
    assert height == 536 and rate < 4
    meta.update(width=640, height=360)
    assert quality.output(meta, 1080, 8)[0] == 360


def test_auto_uses_supplied_bandwidth_while_original_is_preserved():
    meta = {**source(), 'hdr':False, 'pix_fmt':'yuv420p', 'audio':'aac'}
    auto = main.decide(meta, main.Playback(quality='auto', direct=True, bandwidth=3))
    assert auto['mode'] == 'Transcoding' and auto['height'] == 480 and auto['mbps'] <= 1.8
    original = main.decide(meta, main.Playback(quality='original', direct=True, bandwidth=3))
    assert original['mode'] == 'Direct Play' and original['height'] == 1080
