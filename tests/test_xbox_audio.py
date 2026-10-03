"""Original Dolby/DTS transport: real remux bytes, scope and lifecycle checks."""
import asyncio
import array
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_tv import tv_client, login, main


def metadata(codec='truehd'):
    return dict(width=3840,height=2160,video='hevc',pix_fmt='yuv420p10le',hdr=True,
                audio=codec,format='matroska',bitrate=68000000,
                quality={'dynamic_range':'Dolby Vision','dv_profile':7},
                tracks={'audio':[{'index':2,'codec':codec,'channels':8,'default':True}]})


@pytest.mark.parametrize('codec', ['truehd','dts','ac3','eac3'])
def test_original_audio_plan_keeps_hdr10_and_channels(codec):
    result = main.decide(metadata(codec), main.Playback(client_profile='xbox',quality='original',
                        video_copy=True,hdr10_base=True,audio_passthrough=True))
    assert result['mode'] == 'Direct Stream' and result['height'] == 2160
    assert result['dynamic_range'] == 'HDR10' and result['transport'] == 'matroska'
    assert result['audio_output'] == {'codec':codec,'channels':8,'copied':True}


def test_passthrough_is_scoped_and_legacy_stereo_output_is_honest():
    for data in [main.Playback(audio_passthrough=True),
                 main.Playback(client_profile='xbox',audio_passthrough=True,airplay=True)]:
        with pytest.raises(main.HTTPException):
            main.decide(metadata(),data)
    result = main.decide(metadata(),main.Playback(client_profile='xbox',video_copy=True))
    assert result['audio_output'] == {'codec':'aac','channels':2,'copied':False}
    assert 'transport' not in result


@pytest.mark.parametrize('codec', ['truehd','eac3','dca'])
def test_real_matroska_keeps_selected_audio_packets(tv_client, codec):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    client, credentials, mid = tv_client
    row, _ = main.movie(mid)
    source = Path(row['path']).with_suffix('.mkv')
    video_args = ['-c:v','libx264','-preset','ultrafast']
    if codec == 'truehd':
        video_args = ['-c:v','libx265','-preset','ultrafast','-pix_fmt','yuv420p10le',
                      '-x265-params','pools=1:frame-threads=1:log-level=error',
                      '-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc']
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=s=320x180:r=24:d=1',
                    '-f','lavfi','-i','anullsrc=r=48000:cl=stereo',
                    '-f','lavfi','-i','anullsrc=r=48000:cl=5.1','-t','1',
                    '-map','0:v','-map','1:a','-map','2:a',*video_args,
                    '-c:a:0','aac','-c:a:1',codec,'-strict','-2','-y',str(source)],
                   check=True,capture_output=True,timeout=30)
    meta = main.probe(source)
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?, metadata=? WHERE id=?',(str(source),json.dumps(meta),mid))
    _, headers = login(client,credentials)
    response = client.post(f'/tv-api/movies/{mid}/play',headers=headers,json={
        'client_profile':'xbox','quality':'original','video_copy':True,
        'audio_passthrough':True,'audio_track':2,'subtitle_track':None})
    assert response.status_code == 200, response.text
    result=response.json()
    sid=result['session']
    try:
        assert result['transport']=='matroska' and result['audio_track']==2
        assert result['audio_output']['copied']
        assert client.head(result['url']).status_code==200
        assert client.get(result['url'].replace(sid,'0'*32)).status_code==403
        assert client.get(result['url'].replace('stream.mkv','ffmpeg.log')).status_code==404
        assert client.get(result['url'],headers={'Range':'bytes=100-'}).status_code==416
        response=client.get(result['url'],headers={'Range':'bytes=0-'})
        assert response.status_code==200
        assert response.headers['content-type']=='video/x-matroska'
        output=source.with_name('output.mkv');output.write_bytes(response.content)
        def hashes(file, stream):
            checked=subprocess.run(['ffprobe','-v','error','-select_streams',stream,
                '-show_packets','-show_data_hash','sha256','-of','json',str(file)],
                check=True,capture_output=True,timeout=15)
            return [packet['data_hash'] for packet in json.loads(checked.stdout)['packets']]
        assert hashes(source,'a:1') == hashes(output,'a:0'), 'complete compressed packets, including extension data, must survive'
        assert hashes(source,'v:0') == hashes(output,'v:0')
        assert client.get(result['url']).status_code==409, 'a consumed pipe cannot be replayed'
        assert client.post(f'/tv-api/streams/{sid}/heartbeat',headers=headers).status_code==200
        entry=main.active_streams.LIVE[result['playback_id']]
        assert entry['audio']['index']==2 and not entry['audio_transcoded']
    finally:
        main.stop_job(sid)
    assert sid not in main.JOBS


def test_disconnecting_live_mkv_stops_the_process(monkeypatch):
    class Pipe:
        def read1(self, size): return b'chunk'
    class Process:
        stdout=Pipe()
    stopped=[]
    monkeypatch.setattr(main,'stop_job',lambda sid:stopped.append(sid))
    async def read_then_close():
        chunks=main.matroska_chunks('owned-session',{'process':Process()})
        assert await anext(chunks)==b'chunk'
        await chunks.aclose()
    asyncio.run(read_then_close())
    assert stopped==['owned-session']


@pytest.mark.parametrize('transport', ['hls-aac', 'fmp4-aac', 'matroska-original'])
def test_seek_between_keyframes_keeps_audio_and_video_aligned(tv_client, transport):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg required')
    client, credentials, mid = tv_client
    row, _ = main.movie(mid)
    source = Path(row['path']).with_suffix('.mkv')
    video_args = ['-c:v','libx264','-g','96','-keyint_min','96','-sc_threshold','0']
    if transport == 'fmp4-aac':
        video_args = ['-c:v','libx265','-x265-params',
                      'pools=1:frame-threads=1:log-level=error:keyint=96:min-keyint=96:scenecut=0']
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=24:d=10',
                    '-f','lavfi','-i',r"aevalsrc=if(between(t\,5\,5.1)\,0.8*sin(2*PI*1000*t)\,0):s=48000:d=10",
                    *video_args,'-c:a','truehd' if transport=='matroska-original' else 'ac3',
                    '-strict','-2','-y',str(source)],check=True,capture_output=True,timeout=30)
    meta = main.probe(source)
    def video_frames(path):
        from fractions import Fraction
        lines = subprocess.check_output(['ffmpeg','-v','error','-copyts','-i',str(path),
            '-map','0:v:0','-fps_mode','passthrough','-f','framemd5','-'],timeout=15).decode().splitlines()
        timebase = float(Fraction(next(line.split(':',1)[1].strip() for line in lines if line.startswith('#tb'))))
        return [(float(parts[2])*timebase,parts[-1].strip()) for line in lines
                if line and not line.startswith('#') for parts in [line.split(',')]]
    marker = min(video_frames(source),key=lambda frame:abs(frame[0]-5))
    with main.db() as conn:
        conn.execute('UPDATE movies SET path=?, metadata=? WHERE id=?',(str(source),json.dumps(meta),mid))
    _, headers = login(client,credentials)
    # Both forward and backward restarts land between the four-second keyframes.
    for start in (7, 3):
        response = client.post(f'/tv-api/movies/{mid}/play',headers=headers,json={
            'client_profile':'xbox','quality':'original','video_copy':True,
            'audio_passthrough':transport=='matroska-original','start':start})
        assert response.status_code == 200, response.text
        result = response.json()
        sid = result['session']
        try:
            job = main.JOBS[sid]
            if transport == 'matroska-original':
                output = source.with_name('seek.mkv')
                output.write_bytes(client.get(result['url']).content)
            else:
                job['process'].wait(timeout=15)
                output = job['folder']/'index.m3u8'
            video_time = next(pts for pts,digest in video_frames(output) if digest==marker[1])
            frames = json.loads(subprocess.check_output(['ffprobe','-v','error',
                '-select_streams','a:0','-show_frames','-of','json',str(output)],timeout=15))['frames']
            samples = array.array('f')
            samples.frombytes(subprocess.check_output(['ffmpeg','-v','error','-i',str(output),
                '-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-'],timeout=15))
            audio_time = float(frames[0]['pts_time']) + next(i for i,s in enumerate(samples) if abs(s)>0.1)/48000
            # Compare actual content, not first packets: HEVC can retain more
            # audio preroll than video, which is valid when timestamps agree.
            assert abs(audio_time-video_time) < 0.06, (audio_time,video_time)
            assert result['audio_output']['copied'] == (transport=='matroska-original')
        finally:
            main.stop_job(sid)
