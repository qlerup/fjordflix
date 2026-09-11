"""Run against an empty QA container exposed on localhost:8097 and 127.0.0.1:8099."""
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page()
    errors=[]; media_requests=[]; wrong=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    def observe(request):
        parsed=urlsplit(request.url)
        if parsed.path.startswith('/media/'):
            media_requests.append((parsed.netloc, parsed.path.rsplit('/',1)[-1], 'cookie' in request.all_headers()))
        if parsed.path.endswith(('.ts','.m3u8','/file')) and parsed.netloc=='localhost:8097':
            wrong.append(parsed.path)
    page.on('request', observe)
    page.goto('http://localhost:8097')
    page.locator('#username').fill('Media QA')
    page.locator('#password').fill('Temporary-media-test-73!')
    page.locator('#auth-submit').click()
    page.wait_for_function('() => state.user')
    page.evaluate("async () => { await api('/demo','POST'); await refresh(); }")
    page.locator('#admin-open').click()
    page.locator('#media-settings-open').click()
    page.locator('#media-web-url').fill('http://localhost:8097')
    page.locator('#media-direct-url').fill('http://127.0.0.1:8099')
    page.locator('#media-settings-form button[type=submit]').click()
    page.wait_for_function('() => state.user && library.length > 0')
    page.locator('.movie-card').first.click()
    page.locator('#detail-quality').select_option('720')
    page.locator('#play-button').click()
    page.wait_for_function('() => playback && !switching && video.currentTime > .1', timeout=60000)
    page.wait_for_function('() => video.ended', timeout=30000)
    assert page.evaluate('position()') >= 11
    assert media_requests and any(r[1].endswith('.ts') for r in media_requests)
    assert any(r[1].endswith('.m3u8') for r in media_requests)
    assert all(r[0]=='127.0.0.1:8099' and not r[2] for r in media_requests)
    assert not wrong and not errors, (wrong, errors)
    print('PASS: saved admin settings; HLS playlist and segments on separate origin without login cookies; full test movie reached end; no web-origin video requests or JS errors.')
    browser.close()
