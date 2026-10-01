"""Real settings UI; only inventory data is mocked. No host commands execute."""
import re
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
html = (root / 'app/static/index.html').read_text(encoding='utf-8')
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
html = re.sub(r'<link\b[^>]*>', '', html)
styles = '\n'.join(p.read_text(encoding='utf-8') for p in (root / 'app/static').glob('*.css'))
with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_content(html)
    page.add_style_tag(content=styles)
    page.evaluate('''() => {
      window.$ = id => document.getElementById(id);
      window.refresh = async () => {};
      window.loadMediaSettings = () => {};
      window.requests = [];
      window.api = async (path, method='GET') => {
        requests.push([path, method]);
        if (path === '/admin/library') return {sources:[],scan:{running:false,added:0,updated:0,errors:[]}};
        if (path === '/admin/library/proxmox') return {ctid:'1000',errors:[],storages:[],disks:[],mounts:[
          {path:'/mnt/Film',source:'/mnt/mediahub-storage',local_path:'/library/server/Film',write_guide:{
            source:'/mnt/mediahub-storage',target:'/mnt/Film',ctid:'1000',commands:'python3 REVIEW_ONLY',permissions_commands:'python3 REVIEW_ONLY --file-permissions'}},
          {path:'/mnt/Disk',source:'/dev/sda1',local_path:null,write_guide:null}]};
        throw Error('Unexpected request: '+path);
      };
    }''')
    page.add_script_tag(content=(root / 'app/static/settings.js').read_text(encoding='utf-8'))
    page.evaluate("$('admin-dialog').showModal()")
    page.locator('[data-settings-tab="library"]').click()
    page.locator('#source-proxmox').click()
    page.get_by_text('Mapper delt med FjordHubs LXC', exact=True).click()
    button = page.get_by_role('button', name='Få fuld adgang til /mnt/Film', exact=True)
    expect(button).to_be_visible()
    button.click()
    expect(page.locator('#library-write-guide')).to_be_visible()
    expect(page.locator('#library-write-acl')).not_to_be_checked()
    expect(page.locator('#library-write-scope')).to_contain_text('/mnt/mediahub-storage')
    expect(page.locator('#library-write-scope')).to_contain_text('LXC 1000')
    page.locator('#library-write-acl').check()
    expect(page.locator('#library-write-commands')).to_contain_text('--file-permissions')
    output = root / 'test-results'
    output.mkdir(exist_ok=True)
    page.screenshot(path=str(output / 'library-access-desktop.png'))
    for width in (390, 320):
        page.set_viewport_size({'width':width,'height':844})
        assert page.locator('#admin-dialog').evaluate('(d) => d.scrollWidth <= d.clientWidth + 1')
    page.screenshot(path=str(output / 'library-access-mobile.png'))
    page.locator('#library-write-close').click()
    expect(page.locator('#library-write-guide')).to_be_hidden()
    expect(button).to_be_focused()
    assert all(method == 'GET' for path, method in page.evaluate('requests'))
    assert not errors, errors
    browser.close()
print('Desktop/mobile guide, scope, optional ACL, focus and no mutation requests: passed')
