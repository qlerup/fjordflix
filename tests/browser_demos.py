"""Run against the isolated GPU QA server prepared by browser_media.py."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    page.goto('http://localhost:8097')
    page.locator('#username').fill('Media QA')
    page.locator('#password').fill('Temporary-media-test-73!')
    page.locator('#auth-submit').click()
    page.locator('#admin-open').click()
    page.locator('#demo-pack-button').click()
    page.wait_for_function("() => document.querySelector('#demo-pack-button').disabled")
    page.wait_for_function("() => document.querySelector('#demo-pack-status').textContent.includes('Alle tre')", timeout=180000)
    films = page.evaluate("api('/movies')")
    expected = {'Fjordens ro': 30, 'Det sidste sollys': 60, 'Langt fra jorden': 120}
    for title, duration in expected.items():
        matches = [m for m in films if m['title'] == title]
        assert len(matches) == 1 and abs(matches[0]['duration'] - duration) < .1
    page.locator('#demo-pack-button').click()
    page.wait_for_timeout(2500)
    assert len(page.evaluate("api('/movies')")) == len(films)
    page.locator('[data-close="admin-dialog"]').click()
    page.screenshot(path='test-results/demo-library.png', full_page=True)
    print('PASS: created 30/60/120-second movies through admin UI; repeated request creates no duplicates.')
    browser.close()

