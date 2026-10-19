import json
import subprocess

import pytest

from app import main, sidecars, tracks
from test_series import client


SRT = '1\n00:00:01,000 --> 00:00:03,000\nHej med dig! Æ, ø og å.\n'


def test_matching_languages_nested_folders_and_stable_indices(tmp_path):
    video = tmp_path / 'Show.S04E01.mp4'
    video.touch()
    (tmp_path / 'Show.S04E01.srt').write_text(SRT)
    (tmp_path / 'Show.S04E02.da.srt').write_text(SRT)
    (tmp_path / 'Subs').mkdir()
    (tmp_path / 'Subs' / 'Show.S04E01.da.forced.srt').write_text(SRT)
    (tmp_path / 'Subs' / 'English.srt').write_text(SRT)
    found = sidecars.siblings(video)
    assert {t['language'] for t,_ in found} == {'und','da','en'}
    assert next(t for t,_ in found if t['language']=='da')['forced']
    assert all(t['external'] and t['sidecar'] and t['delivery']=='text' for t,_ in found)
    indices = {p.name:t['index'] for t,p in found}
    assert all(2**50 <= index < 2**53 for index in indices.values())
    (tmp_path / 'Show.S04E01.de.srt').write_text(SRT)
    assert all(indices[p.name] == t['index'] for t,p in sidecars.siblings(video) if p.name in indices)
    # A generic language filename must not be shared between multiple episodes.
    (tmp_path / 'Show.S04E02.mp4').touch()
    assert 'English.srt' not in {p.name for _,p in sidecars.siblings(video)}
    dedicated = tmp_path / 'Subs' / video.stem
    dedicated.mkdir()
    (dedicated / 'Danish.srt').write_text(SRT)
    assert any(p == dedicated/'Danish.srt' and t['language']=='da' for t,p in sidecars.siblings(video))


def test_missing_or_unrelated_files_links_and_buffers_are_not_tracks(tmp_path):
    video = tmp_path / 'Movie.mkv'
    video.touch()
    (tmp_path / 'Different.srt').write_text(SRT)
    (tmp_path / 'Movie.srt').touch()
    hidden = tmp_path / '.incomplete'
    hidden.mkdir()
    (hidden / 'Movie.da.srt').write_text(SRT)
    outside = tmp_path.parent / (tmp_path.name + '-outside.srt')
    outside.write_text(SRT)
    try:
        (tmp_path / 'Movie.en.srt').symlink_to(outside)
        assert sidecars.siblings(video) == []
        with pytest.raises(ValueError):
            sidecars.subtitle_path(video, sidecars.OFFSET)
    finally:
        outside.unlink()


def test_same_named_sidecars_in_different_subfolders_have_unique_indices(tmp_path):
    video = tmp_path / 'Movie.mkv'
    video.touch()
    for directory in ('Subs', 'Subtitles'):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / 'Movie.da.srt').write_text(SRT)
    found = sidecars.siblings(video)
    assert len({t['index'] for t,_ in found}) == 2
    assert all(sidecars.subtitle_path(video,t['index']) == p for t,p in found)


@pytest.fixture
def local_video(client):
    path = main.MEDIA / 'Show.S04E01.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=24:d=4',
        '-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-preset','ultrafast',
        '-pix_fmt','yuv420p','-c:a','aac','-y',str(path)], check=True,capture_output=True)
    meta = main.probe(path)
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=?',(str(path),json.dumps(meta)))
    return 'a'*32, path


@pytest.mark.parametrize('nested', [False, True])
def test_existing_mp4_gains_selectable_subtitles_without_rescan(client, local_video, nested):
    mid, video = local_video
    assert client.get(f'/api/movies/{mid}/tracks').json()['subtitles'] == []
    folder = video.parent / 'Subtitles' if nested else video.parent
    folder.mkdir(exist_ok=True)
    subtitle = folder / (video.stem + '.da.srt')
    subtitle.write_text(SRT, encoding='utf-8')
    response = client.get(f'/api/movies/{mid}/tracks')
    assert response.status_code == 200
    track = response.json()['subtitles'][0]
    assert track['language'] == 'da' and track['sidecar']
    assert str(folder) not in json.dumps(track)
    text = client.get(f'/api/movies/{mid}/subtitles/{track["index"]}.vtt')
    assert text.status_code == 200 and text.text.startswith('WEBVTT')
    assert 'Hej med dig! Æ, ø og å.' in text.text
    plan = client.post(f'/api/movies/{mid}/plan',json={'direct':True,'h264':True,'subtitle_track':track['index']})
    assert plan.status_code == 200 and plan.json()['mode'] == 'Direct Play'
    playback = client.post(f'/api/movies/{mid}/play',json={'direct':True,'h264':True,'subtitle_track':track['index']})
    assert playback.status_code == 200
    assert playback.json()['subtitle_track'] == track['index']
    assert playback.json()['subtitle_delivery'] == 'text'
    # Dynamic tracks never enter stored metadata or overwrite downloaded tracks.
    with main.db() as conn:
        saved = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?',(mid,)).fetchone()['metadata'])
    assert 'sidecar_subtitles' not in saved
    subtitle.unlink()
    assert client.get(f'/api/movies/{mid}/tracks').json()['subtitles'] == []
    assert client.get(f'/api/movies/{mid}/subtitles/{track["index"]}.vtt').status_code == 400


def test_embedded_downloaded_and_sidecars_are_all_retained(tmp_path):
    video = tmp_path / 'Movie.mkv'
    video.touch()
    (tmp_path / 'Movie.da.srt').write_text(SRT)
    meta = {'tracks':{'audio':[{'index':1,'language':'eng'}],
        'subtitles':[{'index':2,'language':'eng','delivery':'text'}]},
        'external_subtitles':[{'index':1000000001,'external':True,'language':'sv','delivery':'text'}]}
    enriched = sidecars.metadata(meta,video)
    available = tracks.displayed(enriched)
    assert len(available['subtitles']) == 3
    assert tracks.defaults(enriched,'da')['subtitle_track'] == available['subtitles'][-1]['index']
    assert 'sidecar_subtitles' not in meta
