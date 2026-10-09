"""Run directly with Python; exercises trailer UI without contacting YouTube."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1] / 'app' / 'static'
movie = {'id': 'a' * 32, 'title': 'Testfilm', 'width': 1920, 'height': 1080,
         'duration': 100, 'size': 1000, 'video': 'h264', 'audio': 'aac',
         'catalog': {'tmdb_id': 42, 'status': 'matched'}}

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errors, embeds = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def route(request):
        url = request.request.url
        if url.startswith('https://www.youtube-nocookie.com/'):
            embeds.append(request.request.headers)
            return request.fulfill(content_type='text/html', body='<p>Mock trailer</p>')
        path = url.split('fjordflix.test')[-1].split('?')[0]
        if path == '/':
            return request.fulfill(path=str(root / 'index.html'), content_type='text/html',
                                   headers={'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://www.youtube-nocookie.com", 'Referrer-Policy': 'same-origin'})
        if path.startswith('/static/'):
            file = root / path[len('/static/'):]
            return request.fulfill(path=str(file)) if file.is_file() else request.fulfill(status=404)
        data = {}
        if path == '/api/state':
            data = {'user': {'id': 'user', 'name': 'Test', 'admin': False}}
        elif path == '/api/movies':
            data = [movie]
        elif path.endswith('/trailer'):
            data = {'trailer': {'url': 'https://www.youtube.com/watch?v=abcdefghijk'}}
        elif path.endswith('/credits'):
            data = {'cast': []}
        elif path.endswith('/tracks'):
            data = {'audio': [], 'subtitles': [], 'defaults': {}}
        elif path.endswith('/plan'):
            data = {'mode': 'Direct Play', 'height': 1080, 'reason': 'Original'}
        return request.fulfill(content_type='application/json', body=json.dumps(data))
    page.route('**/*', route)
    page.goto('http://fjordflix.test')
    page.locator('#movie-grid .movie-card').first.click()
    button = page.locator('#trailer-link')
    button.wait_for(state='visible')
    assert page.locator('iframe').count() == 0, 'No YouTube request before clicking'
    for width in [390, 1440]:
        page.set_viewport_size({'width': width, 'height': 960})
        button.click()
        dialog = page.locator('#trailer-dialog')
        dialog.wait_for(state='visible')
        frame = page.locator('#trailer-player iframe')
        assert frame.get_attribute('src').startswith('https://www.youtube-nocookie.com/embed/abcdefghijk?')
        assert page.locator('#trailer-title').inner_text() == 'Trailer \u00b7 Testfilm'
        assert dialog.evaluate('e => e.scrollWidth <= e.clientWidth + 1')
        assert dialog.bounding_box()['width'] <= width
        page.locator('#trailer-dialog .close').click()
        frame.wait_for(state='detached')
        assert dialog.is_hidden(), 'Closing stops playback'
        assert button.evaluate('e => e === document.activeElement'), 'Focus restored'
        button.click()
        page.locator('#trailer-player iframe').wait_for()
        page.keyboard.press('Escape')
        frame.wait_for(state='detached')
        assert dialog.is_hidden()
    page.wait_for_timeout(100)
    assert embeds and all(e.get('referer') == 'http://fjordflix.test/' for e in embeds)
    page.evaluate("loadDetailTrailer({...selected, id:'b'.repeat(32), catalog:{}})")
    assert button.is_hidden()
    assert not errors, errors
    browser.close()
    print('PASS desktop/mobile modal, CSP/referrer, close/Escape cleanup, focus and missing trailer')
