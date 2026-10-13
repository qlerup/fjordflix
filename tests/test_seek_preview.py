import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from test_integration import main


@pytest.fixture
def preview(monkeypatch):
    client=TestClient(main.app)
    assert client.get('/api/movies/test/seek-preview').status_code==401
    main.app.dependency_overrides[main.user]=lambda:{'id':'preview-user'}
    monkeypatch.setattr(main,'movie',lambda mid:({'path':'/media/film.mp4'},{'duration':120}))
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(main.user,None)


def test_preview_seeks_to_requested_time_and_bounds_input(preview,monkeypatch):
    commands=[]
    def run(command,**kwargs):
        commands.append(command)
        assert kwargs['timeout']==8
        return SimpleNamespace(returncode=0,stdout=b'\xff\xd8frame')
    monkeypatch.setattr(main.subprocess,'run',run)
    result=preview.get('/api/movies/test/seek-preview?position=43.5')
    assert result.status_code==200 and result.headers['content-type']=='image/jpeg'
    assert 'no-store' in result.headers['cache-control']
    assert commands[-1][commands[-1].index('-ss')+1]=='43.5'
    assert preview.get('/api/movies/test/seek-preview?position=999').status_code==200
    assert commands[-1][commands[-1].index('-ss')+1]=='119.9'
    for value in ['-1','nan','inf','not-a-time','999999']:
        assert preview.get('/api/movies/test/seek-preview?position='+value).status_code==422


def test_preview_timeout_releases_capacity_and_busy_requests_do_not_spawn(preview,monkeypatch):
    def fail(*args,**kwargs):raise subprocess.TimeoutExpired('ffmpeg',8)
    monkeypatch.setattr(main.subprocess,'run',fail)
    assert preview.get('/api/movies/test/seek-preview').status_code==503
    assert main.PREVIEW_SLOTS.acquire(False)
    assert main.PREVIEW_SLOTS.acquire(False)
    try:
        assert preview.get('/api/movies/test/seek-preview').status_code==429
    finally:
        main.PREVIEW_SLOTS.release();main.PREVIEW_SLOTS.release()


def test_real_ffmpeg_extracts_target_frame(preview,monkeypatch,tmp_path):
    clip=tmp_path/'seek.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=2',
                    '-t','3','-c:v','libx264','-pix_fmt','yuv420p',str(clip)],check=True,timeout=15)
    monkeypatch.setattr(main,'movie',lambda mid:({'path':str(clip)},{'duration':3}))
    early=preview.get('/api/movies/test/seek-preview?position=0')
    late=preview.get('/api/movies/test/seek-preview?position=2')
    assert early.status_code==late.status_code==200
    assert early.content.startswith(b'\xff\xd8') and late.content.endswith(b'\xff\xd9')
    assert early.content!=late.content


def test_tv_preview_requires_bearer_token_not_browser_cookie(preview,monkeypatch):
    monkeypatch.setattr(main,'session_user',lambda digest:{'id':'tv-test'})
    monkeypatch.setattr(main.subprocess,'run',lambda *a,**k:SimpleNamespace(returncode=0,stdout=b'\xff\xd8frame'))
    preview.cookies.set('fjordflix_session','t'*43)
    path='/tv-api/movies/test/seek-preview?position=40'
    assert preview.get(path).status_code==401
    result=preview.get(path,headers={'Authorization':'Bearer '+'t'*43})
    assert result.status_code==200 and result.headers['content-type']=='image/jpeg'
    assert preview.get(path.replace('40','nan'),headers={'Authorization':'Bearer '+'t'*43}).status_code==422
