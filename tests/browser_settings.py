"""Run against a disposable local server, with an empty mounted test directory."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path(__file__).parent.parent / 'test-results'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:18097')
    expect(page.locator('#auth')).to_be_visible()
    page.get_by_label('Brugernavn', exact=True).fill('Settings QA')
    page.locator('#password').fill('Temporary-settings-test-928!')
    page.locator('#auth-submit').click()
    expect(page.locator('#shell')).to_be_visible()
    page.get_by_role('button', name='Indstillinger', exact=True).click()
    expect(page.locator('#admin-dialog')).to_be_visible()
    for section, heading in [('media', 'Video direkte fra serveren'), ('metadata', 'TMDB API-nøgle'),
                             ('subtitles', 'OpenSubtitles'), ('users', 'Brugere'), ('server', 'Server og test'), ('library', 'Biblioteksmapper')]:
        page.locator(f'[data-settings-tab="{section}"]').click()
        expect(page.locator('#admin-dialog').get_by_role('heading', name=heading, exact=True)).to_be_visible()
        assert page.locator('dialog[open]').count() == 1
    page.locator('#source-browse').click()
    expect(page.locator('#source-picker')).to_be_visible()
    page.locator('#source-directories button').first.click()
    page.get_by_role('button', name='▸ Film', exact=True).click()
    expect(page.locator('#source-select')).to_be_enabled()
    if page.locator('#source-list .source-row').count() == 0:
        page.locator('#source-select').click()
        expect(page.locator('#source-list .source-row')).to_have_count(1)
    else:
        page.locator('#source-picker-close').click()
    page.screenshot(path=str(out / 'settings-desktop.png'))
    selected_path = page.locator('#source-list strong').first.inner_text()
    page.route('**/api/admin/library/proxmox', lambda route: route.fulfill(json={
        'configured': True, 'ctid': '1000', 'errors': [], 'mounts': [],
        'storages': [
            {'id': 'Storage-pool1', 'type': 'dir', 'total_bytes': 10**12, 'free_bytes': 5*10**11,
             'online': True, 'directories': [{'name': '/mnt/Film', 'path': selected_path}], 'reason': '', 'path': '/mnt/pve/Storage-pool1'},
            {'id': 'local', 'type': 'dir', 'total_bytes': 240*10**9, 'free_bytes': 50*10**9,
             'online': True, 'directories': [], 'reason': 'Mediemappen skal deles med LXC.', 'path': '/var/lib/vz', 'commands': '# Test fixture: read-only mount instructions'},
            {'id': 'local-lvm', 'type': 'lvmthin', 'total_bytes': 200*10**9, 'free_bytes': 50*10**9,
             'online': True, 'directories': [], 'reason': 'Dette lager indeholder virtuelle diske.', 'path': ''}],
        'disks': [{'devpath': '/dev/sda1', 'parent': '/dev/sda', 'size': 10**12, 'used': 'ext4',
                   'mounted': True, 'directories': [], 'reason': 'Vælg dens storage-pool.'}]}))
    page.locator('#source-proxmox').click()
    expect(page.locator('#proxmox-storages .source-row')).to_have_count(3)
    page.locator('#proxmox-storages button').first.click()
    expect(page.locator('#source-picker')).to_be_visible()
    expect(page.locator('#source-path')).to_have_text(selected_path)
    page.locator('#source-picker-close').click()
    page.locator('#proxmox-storages button').nth(1).click()
    expect(page.locator('#proxmox-selection')).to_contain_text('local')
    expect(page.locator('#proxmox-guide')).to_be_visible()
    page.screenshot(path=str(out / 'settings-proxmox.png'))
    page.set_viewport_size({'width': 390, 'height': 844})
    for section in ['server', 'users', 'metadata', 'media', 'library']:
        page.locator(f'[data-settings-tab="{section}"]').click()
        assert page.locator('#admin-dialog').evaluate('(d) => d.scrollWidth <= d.clientWidth')
    page.screenshot(path=str(out / 'settings-mobile.png'))
    page.keyboard.press('Escape')
    expect(page.locator('#admin-dialog')).not_to_be_visible()
    assert errors == [], errors
    browser.close()
print('Settings desktop/mobile, sections, folder selection and Proxmox inventory passed.')
