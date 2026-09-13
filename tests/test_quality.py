from app.quality import source_quality


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
