"""Create and play the high-bitrate demo on a fresh GPU QA server at :8097."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    page.goto('http://localhost:8097')
    page.locator('#username').fill('Stress QA')
    page.locator('#password').fill('Temporary-stress-test-73!')
    page.locator('#auth-submit').click()
    page.locator('#admin-open').click()
    page.locator('#demo-stress-button').click()
    page.wait_for_function("() => document.querySelector('#demo-stress-status').textContent.includes('Bitstorm er klar')", timeout=180000)
    films = page.evaluate("api('/movies')")
    assert len(films) == 1
    movie = films[0]
    assert movie['height'] == 2160 and 59 <= movie['duration'] <= 61
    assert 110e6 <= movie['bitrate'] <= 130e6
    page.locator('#demo-stress-button').click()
    page.wait_for_timeout(2500)
    assert len(page.evaluate("api('/movies')")) == 1
    page.locator('[data-close="admin-dialog"]').click()
    page.locator('.movie-card').click()
    page.locator('#detail-quality').select_option('original')
    page.locator('#play-button').click()
    page.wait_for_function("() => playback && video.currentTime > 4", timeout=30000)
    assert page.evaluate('playback.mode') == 'Direct Play'
    page.locator('#player-quality').select_option('1080')
    page.wait_for_function("() => playback && playback.mode === 'Transcoding' && video.currentTime > 4 && !switching", timeout=30000)
    assert page.evaluate('playback.encoder') == 'NVIDIA NVENC'
    page.evaluate('release()')
    print(f"PASS: admin generation, no duplicates, {movie['bitrate']/1e6:.1f} Mbit/s; Chrome Original playback and NVENC 1080p playback.")
    browser.close()
