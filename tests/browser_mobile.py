"""Mobile visual and interaction checks on a fresh GPU QA container at :8097."""
from pathlib import Path
from playwright.sync_api import sync_playwright

Path('test-results').mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://localhost:8097')
    page.locator('#auth-submit').wait_for(state='visible')
    page.screenshot(path='test-results/mobile-login.png', full_page=True)
    page.locator('#username').fill('Mobile QA')
    page.locator('#password').fill('Temporary-mobile-test-73!')
    page.locator('#auth-submit').click()
    page.wait_for_function('() => state.user')
    page.evaluate("api('/demo-pack', 'POST')")
    for _ in range(180):
        status = page.evaluate("api('/demo-pack')")
        assert not status['error'], status
        if status['completed'] == 3:
            break
        page.wait_for_timeout(1000)
    else:
        raise AssertionError('Demo generation timed out')
    page.evaluate('refresh()')
    for width in [320,390,430]:
        page.set_viewport_size({'width':width,'height':844})
        page.screenshot(path=f'test-results/mobile-library-{width}.png', full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('[data-view="all"]').click()
        page.locator('.movie-card').first.click()
        assert page.locator('#detail').evaluate('(e) => e.scrollWidth <= e.clientWidth')
        page.screenshot(path=f'test-results/mobile-detail-{width}.png')
        page.locator('[data-close="detail"]').click()
        page.locator('#admin-open').click()
        assert page.locator('#admin-dialog').evaluate('(e) => e.scrollWidth <= e.clientWidth')
        page.locator('[data-close="admin-dialog"]').click()
        page.locator('[data-view="home"]').click()
    page.set_viewport_size({'width':390,'height':844})
    page.locator('.movie-card').first.click()
    page.locator('#detail-quality').select_option('1080')
    page.locator('#play-button').click()
    page.wait_for_function('() => playback && video.currentTime > 1', timeout=30000)
    for width,height in [(390,844),(844,390)]:
        page.set_viewport_size({'width':width,'height':height})
        page.evaluate("document.querySelector('#player-dialog').classList.remove('controls-hidden')")
        page.screenshot(path=f'test-results/mobile-player-{width}.png')
        assert page.locator('#player-dialog').bounding_box()['width'] >= width - 1
        assert page.locator('#player-dialog').evaluate('(e) => e.scrollWidth <= e.clientWidth')
        for selector in ['#player-close','#player-toggle','#player-quality','#player-fullscreen']:
            box = page.locator(selector).bounding_box()
            assert box and box['x'] >= 0 and box['x']+box['width'] <= width+1 and box['y'] >= 0 and box['y']+box['height'] <= height+1, (selector,box)
    page.evaluate('release()')
    assert not errors, errors
    print('PASS: 320/390/430px library, dialogs, navigation; portrait/landscape player with visible controls; no JS errors.')
    browser.close()
