"""Subtitle upload UI with mocked HTTP; no production media or account."""
import json
from pathlib import Path
import re

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
static = root/'app/static'
html = (static/'index.html').read_text(encoding='utf-8')
modal = re.search(r'<dialog id="subtitle-upload-dialog".*?</dialog>',html,re.S).group()
fixture = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<section id="detail"><label class="quality-label"></label><button id="play-button">Play</button><button id="restart-button">Restart</button></section>
<dialog id="player-dialog"><div class="player-top"></div></dialog>'''+modal+'''<script>
window.state={user:{admin:true}};window.$=id=>document.getElementById(id);window.playback=null;
window.updatePlan=async()=>{};window.toast=message=>window.lastToast=message;
window.available={version:1,audio:[{index:1,codec:'aac',language:'en'}],subtitles:[]};
window.api=async()=>window.available;
</script></body></html>'''
output = root/'test-results'; output.mkdir(exist_ok=True)
def check_download(page):
    page.evaluate('FjordTracks.subtitle=available.subtitles[0].index;FjordTracks.sync()')
    expect(page.locator('#detail-subtitle-download')).to_be_visible()
    with page.expect_download() as event:
        page.locator('#detail-subtitle-download').click()
    assert event.value.suggested_filename == 'episode.da.srt'
    assert event.value.path().read_text().endswith('Hej!\n')
    page.wait_for_function('!FjordTracks.downloadingSubtitle')
    page.evaluate('state.user.admin=false;FjordTracks.sync()')
    expect(page.locator('#detail-subtitle-download')).not_to_be_visible()
    page.evaluate('state.user.admin=true;FjordTracks.sync()')

def check_delete(page):
    page.evaluate('available.subtitles[0].uploaded=true;FjordTracks.subtitle=available.subtitles[0].index;FjordTracks.sync()')
    expect(page.locator('#detail-subtitle-delete')).to_be_visible()
    page.once('dialog',lambda dialog:dialog.dismiss())
    page.locator('#detail-subtitle-delete').click()
    assert page.evaluate('available.subtitles.length') == 1
    page.once('dialog',lambda dialog:dialog.accept())
    page.locator('#detail-subtitle-delete').click()
    expect(page.locator('#detail-subtitle-delete')).not_to_be_visible()
    assert page.evaluate('FjordTracks.subtitle') is None
    assert page.evaluate('available.subtitles.length') == 0

def check_timing(page, width):
    page.evaluate('''() => {
      window.savedApi=api;window.timingCalls=[];
      window.api=async (route,method,data) => {
        if(route.endsWith('/timing')) {timingCalls.push(data);available.subtitles[0].timing_revision='a'.repeat(64);return {revision:'a'.repeat(64)}}
        return available;
      };
      window.video=document.createElement('video');document.body.append(video);
      const track=video.addTextTrack('subtitles');track.addCue(new VTTCue(1,3,'Hej!'));
      FjordTracks.element={track};FjordTracks.subtitle=available.subtitles[0].index;
      FjordTracks.applyTiming(track,0);FjordTracks.sync();
      document.getElementById('player-dialog').showModal();document.getElementById('player-tracks').hidden=false;
    }''')
    expect(page.locator('#subtitle-timing')).to_be_visible()
    page.locator('#subtitle-later').click()
    assert page.evaluate('FjordTracks.element.track.cues[0].startTime') == 1.5
    page.locator('#subtitle-delay').fill('-0.5')
    page.locator('#subtitle-delay').dispatch_event('change')
    assert page.evaluate('FjordTracks.element.track.cues[0].startTime') == 0.5
    page.screenshot(path=str(output/f'subtitle-timing-{width}.png'))
    assert page.locator('#subtitle-timing').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
    page.once('dialog',lambda dialog:dialog.accept())
    page.locator('#subtitle-delay-save').click()
    page.wait_for_function('timingCalls.length===1 && !FjordTracks.savingTiming')
    assert page.evaluate('timingCalls[0].delay') == -0.5
    expect(page.locator('#subtitle-delay')).to_have_value('0')
    page.evaluate('state.user.admin=false;FjordTracks.sync()')
    expect(page.locator('#subtitle-timing')).not_to_be_visible()
    page.evaluate('FjordTracks.setSubtitleDelay(3)')
    assert page.evaluate('FjordTracks.subtitleDelay') == 0
    page.evaluate("state.user.admin=true;window.api=savedApi;FjordTracks.element=null;document.getElementById('player-dialog').close();FjordTracks.sync()")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    for width in (1440,390):
        page = browser.new_page(viewport={'width':width,'height':900})
        errors = []; page.on('pageerror',lambda error:errors.append(str(error)))
        requests = []
        def handle(route):
            request = route.request
            if request.url.endswith('/download'):
                route.fulfill(body='1\n00:00:01,000 --> 00:00:03,000\nHej!\n',
                    headers={'Content-Disposition':'attachment; filename="episode.da.srt"'},content_type='application/octet-stream')
                return
            if '/subtitle-upload?' in request.url:
                requests.append(request)
                assert '/api/movies/'+'a'*32+'/subtitle-upload?' in request.url
                if 'invalid.srt' in request.url:
                    route.fulfill(status=400,json={'detail':'Filen er ikke gyldig SRT.'}); return
                route.fulfill(json={'index':2**49+123,'cached':False}); return
            route.fulfill(body=fixture,content_type='text/html')
        page.route('**/*',handle)
        page.goto('http://upload.test')
        page.add_style_tag(path=str(static/'style.css'))
        page.add_style_tag(path=str(static/'library.css'))
        page.add_style_tag(path=str(static/'player.css'))
        page.add_style_tag(path=str(static/'selects.css'))
        page.add_style_tag(path=str(static/'subtitle-upload.css'))
        for script in ('tracks.js','subtitle-upload.js','selects.js'):
            page.add_script_tag(path=str(static/script))
        page.evaluate('''async () => {
          FjordTracks.setup();
          await FjordTracks.prepare({id:'a'.repeat(32),title:'Power Book II: Ghost',catalog:{media_type:'tv',season:3,episode:1}});
        }''')
        if width <= 600:
            assert page.locator('#detail-subtitle option[value="__upload__"]').count()==0
            page.evaluate('FjordSubtitleUpload.open(FjordTracks.movie)')
            expect(page.locator('#subtitle-upload-dialog')).not_to_be_visible()
            page.evaluate('''() => {
              available.subtitles=[{index:2**49+123,language:'da',codec:'subrip',delivery:'text',external:true,title:'Tilføjet SRT'}];
              FjordTracks.movie.tracks=available;FjordTracks.fill(available);
            }''')
            expect(page.locator('#detail-subtitle')).to_be_enabled()
            expect(page.locator('#detail-subtitle option').filter(has_text='Tilføjet SRT')).to_have_count(1)
            check_download(page)
            check_timing(page,width)
            check_delete(page)
            assert not errors, errors
            print('PASS mobile hides subtitle upload and keeps existing subtitles selectable',width)
            page.close()
            continue
        expect(page.locator('#detail-subtitle')).to_be_enabled()
        page.locator('.fx-select-button[data-select-id="detail-subtitle"]').click()
        page.get_by_role('option',name='＋ Tilføj undertekster…',exact=True).click()
        expect(page.locator('#subtitle-upload-dialog')).to_be_visible()
        expect(page.locator('#subtitle-upload-title')).to_have_text('Tilføj undertekster')
        expect(page.locator('#subtitle-upload-target')).to_have_text('Power Book II: Ghost · S03E01')
        assert page.evaluate('FjordTracks.subtitle === null')
        data = page.evaluate_handle('''() => {
          const data = new DataTransfer();
          data.items.add(new File(['1\\n00:00:01,000 --> 00:00:03,000\\nHej!\\n'],'episode.da.srt',{type:'text/plain'}));
          return data;
        }''')
        page.locator('#subtitle-upload-drop').dispatch_event('drop',{'dataTransfer':data})
        expect(page.locator('#subtitle-upload-files')).to_contain_text('episode.da.srt')
        expect(page.locator('#subtitle-upload-files select')).to_have_value('da')
        page.screenshot(path=str(output/f'subtitle-upload-{width}.png'))
        box = page.locator('#subtitle-upload-dialog').bounding_box()
        assert box['x']>=0 and box['x']+box['width']<=width
        assert box['y']>=0 and box['y']+box['height']<=900
        assert page.locator('#subtitle-upload-dialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
        page.evaluate('''() => available.subtitles=[{index:2**49+123,language:'da',codec:'subrip',delivery:'text',external:true,title:'Tilføjet · episode.da.srt'}]''')
        page.locator('#subtitle-upload-save').click()
        expect(page.locator('#subtitle-upload-dialog')).not_to_be_visible()
        expect(page.locator('#detail-subtitle')).to_have_value(str(2**49+123))
        assert len(requests)==1 and 'language=da' in requests[0].url
        assert 'Hej!' in requests[0].post_data
        check_download(page)
        check_timing(page,width)
        # Errors retain pending files; a mixed batch preserves successful uploads.
        page.evaluate('FjordSubtitleUpload.open(FjordTracks.movie)')
        page.locator('#subtitle-upload-input').set_input_files([
            {'name':'valid.srt','mimeType':'text/plain','buffer':b'valid fixture'},
            {'name':'invalid.srt','mimeType':'text/plain','buffer':b'invalid fixture'}])
        page.locator('#subtitle-upload-save').click()
        expect(page.locator('#subtitle-upload-status')).to_contain_text('Nogle filer kunne ikke tilføjes')
        expect(page.locator('#subtitle-upload-files')).to_contain_text('Filen er ikke gyldig SRT.')
        expect(page.locator('#subtitle-upload-files')).to_contain_text('Tilføjet')
        page.locator('#subtitle-upload-cancel').click()
        page.evaluate('FjordSubtitleUpload.open(FjordTracks.movie)')
        page.locator('#subtitle-upload-input').set_input_files({'name':'wrong.exe','mimeType':'application/octet-stream','buffer':b'no'})
        expect(page.locator('#subtitle-upload-status')).to_contain_text('Vælg op til 20 SRT-filer')
        expect(page.locator('#subtitle-upload-save')).to_be_disabled()
        page.locator('#subtitle-upload-cancel').click()
        check_delete(page)
        page.evaluate('state.user.admin=false;FjordTracks.fill(available)')
        assert page.locator('#detail-subtitle option[value="__upload__"]').count()==0
        assert not errors, errors
        print('PASS subtitle dropdown action, drag/drop, upload selection, partial errors and permissions',width)
        page.close()
    browser.close()
