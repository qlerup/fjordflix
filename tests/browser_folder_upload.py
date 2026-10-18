"""Actual upload modal and native folder picker with synthetic upload responses."""
import json
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
source = (root / 'app/static/index.html').read_text(encoding='utf8')
start = source.index('<dialog id="upload-dialog"')
modal = source[start:source.index('</dialog>', start) + len('</dialog>')]
css = '\n'.join((root / 'app/static' / name).read_text(encoding='utf8') for name in ('style.css','library.css','mobile.css'))
html = '<!doctype html><meta charset="utf-8"><style>' + css + '</style><button id="upload-open">Upload</button>' + modal

with tempfile.TemporaryDirectory(prefix='fjordflix-picker-') as temporary, sync_playwright() as pw:
    folder = Path(temporary) / 'The Show'
    (folder / 'Season 1').mkdir(parents=True)
    (folder / 'Season 2').mkdir()
    for relative in ('Season 1/E01.mkv','Season 2/E01.mkv','cover.jpg'):
        (folder / relative).write_bytes(b'video')
    browser = pw.chromium.launch()
    for width in (1280, 390):
        page = browser.new_page(viewport={'width':width,'height':900})
        errors, posts = [], []
        states = {}
        page.on('pageerror', lambda error: errors.append(str(error)))
        def route(route):
            request = route.request
            if request.url == 'http://upload.test/':
                return route.fulfill(body=html,content_type='text/html')
            if request.url == 'http://upload.test/api/uploads':
                data = request.post_data_json
                posts.append(data)
                uid = str(len(posts))
                states[uid] = {**data,'id':uid,'offset':0,'status':'uploading'}
                return route.fulfill(json=states[uid])
            uid = request.url.split('/api/uploads/')[-1].split('/')[0].split('?')[0]
            state = states[uid]
            if request.method == 'PUT': state['offset'] = state['size']
            if request.method == 'POST': state.update(status='done',metadata_message='Tilføjet med metadata')
            route.fulfill(json=state)
        page.route('**/*',route)
        page.goto('http://upload.test/')
        page.add_script_tag(content="const $=id=>document.getElementById(id); const refresh=async()=>{}; const toast=message=>{window.lastToast=message};")
        page.add_script_tag(path=str(root / 'app/static/uploads.js'))
        page.evaluate('setupUploads()')
        page.click('#upload-open')
        with page.expect_file_chooser() as chooser:
            page.click('#upload-choose-folder')
        chooser.value.set_files(str(folder))
        expect(page.locator('.upload-queue li')).to_have_count(3)
        expect(page.locator('.upload-queue')).to_contain_text('The Show/Season 1/E01.mkv')
        expect(page.locator('.upload-queue')).to_contain_text('The Show/Season 2/E01.mkv')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        results = root / 'test-results'
        results.mkdir(exist_ok=True)
        page.screenshot(path=str(results / f'folder-upload-{width}.png'))
        page.click('#upload-submit')
        expect(page.locator('.upload-queue [data-status="done"]')).to_have_count(2)
        assert sorted(p['relative_path'] for p in posts) == ['The Show/Season 1/E01.mkv','The Show/Season 2/E01.mkv']
        # Drop events must recurse instead of treating a directory as an empty file.
        page.evaluate("$('upload-dialog').close()")
        page.click('#upload-open')
        page.evaluate('''() => {
            const file = new File(['video'], 'Film.mp4');
            const entry = {isDirectory:true,name:'Dropped Movie',createReader:() => {
                let read = false;
                return {readEntries:resolve => {
                    const batch = read ? [] : [{isFile:true,file:done => done(file)}];
                    read = true; resolve(batch);
                }};
            }};
            const event = new Event('drop', {bubbles:true,cancelable:true});
            Object.defineProperty(event, 'dataTransfer', {value:{items:[{kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>null}]}});
            document.querySelector('.dropzone').dispatchEvent(event);
        }''')
        expect(page.locator('.upload-queue li')).to_have_count(1)
        expect(page.locator('.upload-queue')).to_contain_text('Dropped Movie/Film.mp4')
        page.click('#upload-submit')
        expect(page.locator('.upload-queue [data-status="done"]')).to_have_count(1)
        assert posts[-1]['relative_path'] == 'Dropped Movie/Film.mp4'
        assert not errors, errors
        page.close()
    browser.close()
print('PASS actual folder picker: nested structure, same-name episodes, unsupported files, upload queue and desktop/mobile layout.')
