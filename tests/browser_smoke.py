"""Run against disposable QA container on 8097, never the user's installation."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')

out = Path(__file__).parent.parent / 'test-results'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':1440, 'height':1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://localhost:8097')
    expect(page.get_by_role('heading', name='Velkommen hjem.')).to_be_visible()
    page.screenshot(path=str(out / '01-setup.png'), full_page=True)
    page.get_by_label('Brugernavn', exact=True).fill('Browser Tester')
    page.get_by_label('Adgangskode', exact=True).fill('Temporary-browser-test-73!')
    page.get_by_role('button', name='Opret administrator').click()
    expect(page.get_by_role('heading', name='Her begynder samlingen')).to_be_visible()
    page.screenshot(path=str(out / '02-library-empty.png'), full_page=True)
    page.get_by_role('button', name='Prøv med en 4K-testfilm').click()
    expect(page.locator('.movie-card')).to_have_count(1, timeout=180000)
    page.screenshot(path=str(out / '03-library.png'), full_page=True)
    page.locator('.movie-card').click()
    expect(page.get_by_role('dialog').get_by_role('heading', name='Nordlys · 4K testfilm')).to_be_visible()
    page.locator('#detail-quality').select_option('original')
    expect(page.locator('#plan-badge')).to_have_text('Direct Play', timeout=20000)
    page.screenshot(path=str(out / '04-details.png'), full_page=True)
    page.get_by_role('button', name='Afspil film', exact=False).click()
    page.wait_for_function("() => document.getElementById('video').currentTime > 0.3 && document.getElementById('video').videoWidth === 3840", timeout=30000)
    expect(page.locator('#actual-badge')).to_have_text('Direct Play')
    page.locator('#player-quality').select_option('1080')
    page.wait_for_function("() => document.getElementById('video').currentTime > 0.2 && document.getElementById('video').videoHeight === 1080", timeout=30000)
    expect(page.locator('#actual-badge')).to_have_text('Transcoding')
    page.screenshot(path=str(out / '05-transcoding.png'), full_page=True)
    print('PLAYBACK', page.locator('#playback-info').inner_text())
    page.get_by_role('button', name='Tilbage', exact=False).click()
    expect(page.locator('#player-dialog')).not_to_be_visible()
    page.get_by_role('button', name='Server og brugere', exact=True).click()
    expect(page.get_by_role('heading', name='Din server', exact=True)).to_be_visible()
    page.get_by_role('button', name='Opret invitation').click()
    expect(page.locator('#invite-code')).not_to_have_value('')
    page.screenshot(path=str(out / '06-admin.png'), full_page=True)
    page.get_by_role('button', name='Luk serverindstillinger').click()
    page.get_by_role('searchbox').fill('findes ikke')
    expect(page.get_by_role('heading', name='Ingen film matcher søgningen')).to_be_visible()
    page.get_by_role('searchbox').fill('')
    page.set_viewport_size({'width':390, 'height':844})
    page.screenshot(path=str(out / '07-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile overflow'
    assert not errors, errors
    print('Browser smoke passed: setup, demo, direct 4K playback, 1080p transcoding, invite, search, mobile width; no JS exceptions.')
    browser.close()
