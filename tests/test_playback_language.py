from app import tracks
from test_integration import main


def fixture():
    return {'tracks': {'audio': [
        {'index':1,'language':'eng','default':True},
        {'index':2,'language':'dan'}], 'subtitles': [
        {'index':3,'language':'da','delivery':'burn'},
        {'index':4,'language':'dan','delivery':'text','forced':True},
        {'index':5,'language':'da','delivery':'text'},
        {'index':6,'language':'fre','delivery':'text'}]}}


def test_danish_audio_disables_subtitles_and_aliases_match():
    assert tracks.defaults(fixture(),'da-DK') == {'audio_track':2,'subtitle_track':None}
    assert tracks.defaults(fixture(),'en') == {'audio_track':1,'subtitle_track':None}


def test_foreign_audio_uses_full_preferred_subtitles_before_forced_or_bitmap():
    meta=fixture();meta['tracks']['audio']=meta['tracks']['audio'][:1]
    assert tracks.defaults(meta,'da') == {'audio_track':1,'subtitle_track':5}
    assert tracks.defaults(meta,'fr') == {'audio_track':1,'subtitle_track':6}
    assert tracks.defaults(meta,'de') == {'audio_track':1,'subtitle_track':None}


def test_manual_choices_and_explicit_off_are_preserved():
    meta=fixture()
    data=main.Playback(audio_track=1,subtitle_track=None)
    assert tracks.apply_defaults(meta,data,{'language':'da'}).subtitle_track is None
    data=main.Playback(audio_track=1)
    result=tracks.apply_defaults(meta,data,{'language':'da'})
    assert result.audio_track==1 and result.subtitle_track==5
    result=tracks.apply_defaults(meta,main.Playback(audio_track=None),{'language':'da'})
    assert result.audio_track is None and result.subtitle_track==5
    assert tracks.apply_defaults(meta,main.Playback(),{'language':'da'}).audio_track==2
    assert tracks.apply_defaults(meta,main.Playback(),{}).audio_track is None


def test_missing_tracks_and_language_overrides():
    assert tracks.defaults({},'da') == {'audio_track':None,'subtitle_track':None}
    meta=fixture();meta['tracks']['audio']=meta['tracks']['audio'][:1]
    meta['audio_language_overrides']={'1':'Dansk'}
    assert tracks.defaults(meta,'da') == {'audio_track':1,'subtitle_track':None}
