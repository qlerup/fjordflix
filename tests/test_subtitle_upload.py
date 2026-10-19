import json
import subprocess

import pytest

from app import main, opensubtitles, subtitle_upload
from test_series import client

MID = 'a'*32
SRT = '1\n00:00:01,000 --> 00:00:03,000\nHej! Æ, ø og å.\n'


def upload(client, filename='episode.da.srt', language='da', raw=None):
    return client.post(f'/api/movies/{MID}/subtitle-upload',params={'filename':filename,'language':language},
        content=SRT.encode() if raw is None else raw,headers={'Content-Type':'application/octet-stream'})


def test_srt_upload_selection_idempotency_and_movie_deletion(client):
    with main.db() as conn:
        meta = {'tracks':{'version':1,'audio':[],'subtitles':[]}}
        conn.execute('UPDATE movies SET metadata=?',(json.dumps(meta),))
    result = upload(client)
    assert result.status_code == 200, result.text
    index = result.json()['index']
    assert 2**49 <= index < 2**50
    path = opensubtitles.subtitle_path(main.DATA,MID,index)
    assert path.read_text() == SRT
    available = client.get(f'/api/movies/{MID}/tracks').json()['subtitles']
    assert len(available) == 1 and available[0]['uploaded'] and available[0]['language']=='da'
    assert upload(client,filename='renamed.srt').json() == {'index':index,'cached':True}
    english = upload(client,language='en')
    assert english.json()['index'] != index
    assert client.get(f'/api/movies/{MID}/subtitles/{index}.vtt').status_code == 200
    # The ordinary upload/movie cleanup also removes manually added subtitles.
    video = main.MEDIA/'original.mp4'
    video.write_bytes(b'fixture')
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?',(str(video),))
    assert client.request('DELETE',f'/api/movies/{MID}',json={'ids':[MID]}).status_code == 200
    assert not path.exists()


@pytest.mark.parametrize('filename,language,raw,status',[
    ('not.txt','da',SRT.encode(),400),('../file.srt','da',SRT.encode(),400),
    ('folder\\file.srt','da',SRT.encode(),400),('file.srt','invalid',SRT.encode(),400),
    ('file.srt','da',b'',400),('file.srt','da',b'<html>wrong content</html>',400),
    ('file.srt','da',b'x'*(2*1024**2+1),413),
])
def test_invalid_uploads_leave_metadata_and_files_untouched(client,filename,language,raw,status):
    with main.db() as conn:
        before = conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0]
    assert upload(client,filename,language,raw).status_code == status
    with main.db() as conn:
        assert conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0] == before
    assert not list((main.DATA/'subtitles').rglob('*.srt'))


def test_upload_normalizes_windows_text_and_preserves_other_metadata(client):
    with main.db() as conn:
        meta = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0])
    response = upload(client,raw=SRT.replace('\n','\r\n').encode('cp1252'))
    assert response.status_code == 200
    assert opensubtitles.subtitle_path(main.DATA,MID,response.json()['index']).read_text() == SRT
    with main.db() as conn:
        after = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0])
    assert {k:v for k,v in after.items() if k!='external_subtitles'} == meta


def test_upload_requires_admin_and_binds_to_existing_title(client,monkeypatch):
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'id':'viewer','admin':False})
    assert upload(client).status_code == 403
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'id':'owner','admin':True})
    assert client.post('/api/movies/'+'b'*32+'/subtitle-upload',params={'filename':'file.srt'},content=SRT.encode()).status_code == 404


def test_subtitle_limit_keeps_existing_downloads(client):
    with main.db() as conn:
        original = [{'index':opensubtitles.OFFSET+i+1,'external':True} for i in range(100)]
        conn.execute('UPDATE movies SET metadata=?',(json.dumps({'external_subtitles':original}),))
    assert upload(client).status_code == 400
    with main.db() as conn:
        assert json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0])['external_subtitles'] == original


def test_download_uploaded_subtitle_and_admin_permissions(client, monkeypatch):
    index = upload(client).json()['index']
    url = f'/api/movies/{MID}/subtitles/{index}/download'
    result = client.get(url)
    assert result.status_code == 200 and result.content == SRT.encode()
    assert 'attachment;' in result.headers['content-disposition']
    assert '.srt' in result.headers['content-disposition']
    assert client.get(f'/api/movies/{MID}/subtitles/999/download').status_code == 400
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'id':'viewer','admin':False})
    assert client.get(url).status_code == 403


def test_delete_only_manual_uploads_preserves_other_tracks(client, monkeypatch):
    index = upload(client).json()['index']
    other = upload(client,language='en').json()['index']
    url = f'/api/movies/{MID}/subtitle-upload/{index}'
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'id':'viewer','admin':False})
    assert client.delete(url).status_code == 403
    assert opensubtitles.subtitle_path(main.DATA,MID,index).exists()
    monkeypatch.setitem(main.app.dependency_overrides,main.user,lambda:{'id':'owner','admin':True})
    with main.db() as conn:
        before = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0])
        before['external_subtitles'].append({'index':1234567890,'external':True})
        conn.execute('UPDATE movies SET metadata=?',(json.dumps(before),))
    assert client.delete(f'/api/movies/{MID}/subtitle-upload/1234567890').status_code == 400
    assert client.delete(url).status_code == 200
    assert not opensubtitles.subtitle_path(main.DATA,MID,index).exists()
    assert opensubtitles.subtitle_path(main.DATA,MID,other).exists()
    assert client.get(f'/api/movies/{MID}/subtitles/{index}/download').status_code == 400
    with main.db() as conn:
        after = json.loads(conn.execute('SELECT metadata FROM movies WHERE id=?',(MID,)).fetchone()[0])
    assert after['external_subtitles'] == [t for t in before['external_subtitles'] if t['index']!=index]
    assert {k:v for k,v in after.items() if k!='external_subtitles'} == {k:v for k,v in before.items() if k!='external_subtitles'}
    # A deleted/missing file can still be removed from the subtitle list.
    opensubtitles.subtitle_path(main.DATA,MID,other).unlink()
    assert client.delete(f'/api/movies/{MID}/subtitle-upload/{other}').status_code == 200
    assert client.delete(url).status_code == 400
    assert upload(client).json()['index'] == index


@pytest.mark.parametrize('codec,extension', [('srt','.srt'),('ass','.ass')])
def test_download_embedded_subtitle_preserves_source(client, codec, extension):
    from app import tracks
    subtitle = main.MEDIA/'source.srt'
    subtitle.write_text(SRT,encoding='utf-8')
    video = main.MEDIA/'source.mkv'
    subprocess.run(['ffmpeg','-v','error','-i',str(subtitle),'-c:s',codec,'-y',str(video)],check=True)
    original = video.read_bytes()
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?,metadata=?',(str(video),json.dumps({'tracks':tracks.scan(video)})))
    url = f'/api/movies/{MID}/subtitles/0/download'
    result = client.get(url)
    assert result.status_code == 200, result.text
    assert extension in result.headers['content-disposition']
    assert 'Hej!' in result.content.decode('utf-8')
    assert client.get(url).content == result.content
    assert video.read_bytes() == original
