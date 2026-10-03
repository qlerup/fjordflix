from app.quality import source_quality
from app.quality import hdr10_base
import pytest


@pytest.mark.parametrize('profile,compat,base,expected', [(7,None,True,True),(8,1,True,True),(8,None,True,False),(8,2,True,False),(5,0,True,False),(7,6,False,False)])
def test_dolby_hdr10_base_requires_profile_evidence(profile, compat, base, expected):
    source = source_quality({'side_data_list':[{'side_data_type':'DOVI configuration record',
        'dv_profile':profile,'dv_bl_signal_compatibility_id':compat,'bl_present_flag':base}]}, {})
    assert source['version'] == 3
    assert hdr10_base(source) is expected
    assert source['dv_bl_signal_compatibility_id'] == compat


def test_dolby_vision_and_atmos_require_stream_evidence():
    video = {'color_transfer': 'smpte2084', 'side_data_list': [{'side_data_type': 'DOVI configuration record'}]}
    audio = {'codec_name': 'eac3', 'channels': 6, 'channel_layout': '5.1(side)'}
    plain = source_quality(video, audio)
    assert plain['dynamic_range'] == 'Dolby Vision'
    assert plain['dolby_atmos'] is False
    assert source_quality(video, audio, [{'@type': 'Audio', 'Format_AdditionalFeatures': 'JOC'}])['dolby_atmos'] is True
    assert source_quality(video, {**audio, 'profile': 'Dolby Digital Plus + Dolby Atmos'})['dolby_atmos'] is True


def test_mediainfo_truehd_and_hdr_formats():
    tracks = [{'@type': 'Video', 'HDR_Format': 'Dolby Vision / SMPTE ST 2086'},
              {'@type': 'Audio', 'Format': 'MLP FBA', 'Format_AdditionalFeatures': '16-ch'}]
    quality = source_quality({}, {'codec_name': 'truehd'}, tracks)
    assert quality['dynamic_range'] == 'Dolby Vision'
    assert quality['dolby_atmos'] is True
    assert source_quality({'color_transfer': 'arib-std-b67'}, {})['dynamic_range'] == 'HLG'
    assert source_quality({}, {})['dynamic_range'] == 'SDR'


def test_other_audio_tracks_and_titles_do_not_claim_atmos():
    tracks = [{'@type': 'Audio', 'Title': 'Dolby Atmos', 'Format_AdditionalFeatures': ''},
              {'@type': 'Audio', 'Format_AdditionalFeatures': 'JOC'}]
    assert source_quality({}, {'codec_name': 'eac3', 'channels': 8}, tracks)['dolby_atmos'] is False
