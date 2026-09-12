"""Check resume and restart using a fresh QA server at :8097."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width':390,'height':844})
    page.goto('http://localhost:8097')
    page.locator('#username').fill('Restart QA')
    page.locator('#password').fill('Temporary-restart-test-73!')
    page.locator('#auth-submit').click()
    page.wait_for_function('() => state.user')
    page.evaluate("async () => { await api('/demo','POST'); await refresh(); }")
    page.locator('.movie-card').first.click()
    assert page.locator('#restart-button').is_hidden()
    page.locator('[data-close="detail"]').click()
    for button, expected, quality in [('play-button',5,'original'), ('restart-button',0,'original'), ('restart-button',0,'720')]:
        page.evaluate("async () => { await api(`/movies/${library[0].id}/progress`,'POST',{position:5}); await refresh(); }")
        page.locator('.movie-card').first.click()
        assert 'Fortsæt' in page.locator('#play-button').inner_text()
        assert page.locator('#restart-button').is_visible()
        page.locator('#detail-quality').select_option(quality)
        with page.expect_request(lambda r: r.url.endswith('/play') and r.method=='POST') as request:
            page.locator('#'+button).click()
        assert request.value.post_data_json['start'] == expected
        page.wait_for_function('() => playback && video.readyState >= 2 && !switching', timeout=30000)
        if expected == 0:
            assert page.evaluate('position()') < 3
        assert page.locator('#player-quality').input_value() == quality
        page.locator('#player-close').click()
    print('PASS: resume at 5s; restart at 0s in Original and 720p; selected quality retained.')
    browser.close()
