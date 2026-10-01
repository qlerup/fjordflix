"""Isolated first-admin guide; provider requests are simulated, never sent."""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

import uvicorn
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
workspace = tempfile.TemporaryDirectory(prefix='flix-onboarding-browser-', ignore_cleanup_errors=True)
os.environ['DATA_DIR'] = workspace.name
os.environ['TRANSCODE_DEVICE'] = 'cpu'
os.environ.pop('TMDB_READ_ACCESS_TOKEN', None)
from app import main


def provider_login(value):
    if value['password'] != 'accepted-test-password':
        raise ValueError('OpenSubtitles afviste adgangen. Kontrollér oplysningerne.')
    return {'token': 'test-only', 'expires': time.time()+600, 'base': 'https://api.opensubtitles.com/api/v1'}


main.subtitle_provider.login = provider_login
server = uvicorn.Server(uvicorn.Config(main.app, host='127.0.0.1', port=0, log_level='error'))
thread = threading.Thread(target=server.run, daemon=True)
thread.start()
for _ in range(100):
    if server.started:
        break
    time.sleep(.1)
assert server.started
base = 'http://127.0.0.1:' + str(server.servers[0].sockets[0].getsockname()[1])
out = Path(__file__).resolve().parents[1] / 'test-results'
out.mkdir(exist_ok=True)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base)
        page.locator('#username').fill('Guide Admin')
        page.locator('#password').fill('Temporary-guide-password!')
        page.locator('#auth-submit').click()
        dialog = page.locator('#onboarding-dialog')
        expect(dialog).to_be_visible()
        expect(page.locator('[data-onboarding-step="tmdb"]')).to_be_visible()
        page.screenshot(path=str(out / 'onboarding-desktop.png'))
        for width in (320, 390):
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / 'onboarding-mobile-debug.png'))
            assert dialog.evaluate('(d) => d.scrollWidth <= d.clientWidth + 1'), dialog.evaluate('(d) => [...d.querySelectorAll("*")].filter(e => e.getBoundingClientRect().right > d.getBoundingClientRect().right).map(e => [e.tagName,e.className,e.textContent.slice(0,40), e.getBoundingClientRect().width])')
        page.screenshot(path=str(out / 'onboarding-mobile.png'))
        assert dialog.locator('a[target="_blank"]').count() >= 6
        page.locator('#onboarding-tmdb-token').fill('qa-token')
        page.locator('#onboarding-tmdb-form button').click()
        expect(page.locator('[data-onboarding-step="subtitles"]')).to_be_visible()
        expect(page.locator('#onboarding-tmdb-token')).to_have_value('')
        page.reload()
        expect(page.locator('[data-onboarding-step="subtitles"]')).to_be_visible()
        page.locator('#onboarding-os-key').fill('qa-key')
        page.locator('#onboarding-os-user').fill('qa-user')
        page.locator('#onboarding-os-password').fill('wrong-password')
        page.locator('#onboarding-os-form button').click()
        expect(page.locator('#onboarding-error')).to_contain_text('afviste')
        expect(page.locator('#onboarding-skip')).to_be_enabled()
        page.locator('#onboarding-os-password').fill('accepted-test-password')
        page.locator('#onboarding-os-form button').click()
        expect(dialog).not_to_be_visible()
        expect(page.locator('#onboarding-os-password')).to_have_value('')
        page.reload()
        expect(page.locator('#shell')).to_be_visible()
        expect(dialog).not_to_be_visible()
        # Reset only the disposable database to exercise independent skip behavior.
        with main.db() as conn:
            conn.execute('DELETE FROM catalog_settings')
        page.reload()
        expect(dialog).to_be_visible()
        page.locator('#onboarding-skip').click()
        expect(page.locator('[data-onboarding-step="subtitles"]')).to_be_visible()
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        page.reload()
        expect(page.locator('#shell')).to_be_visible()
        expect(dialog).not_to_be_visible()
        assert not errors, errors
        browser.close()
    print('PASS: first login, responsive modal, provider guides, save, failed/retried login, resume, skip, Escape, no JS errors')
finally:
    server.should_exit = True
    thread.join(timeout=10)
    workspace.cleanup()
