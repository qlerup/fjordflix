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
    page.set_viewport_size({'width':1440,'height':1000})
    page.clock.install()
    page.evaluate('''() => {
      window.posts = 0; window.checks = 0;
      const original = api;
      window.api = async (path, method='GET', body) => {
        if (path === '/admin/library/proxmox/connect') {
          posts++; if (!body.confirm_restart || body.pool_id !== 'a'.repeat(20)) throw Error('invalid request');
          return {accepted:true,job:{state:'queued'}};
        }
        if (path === '/admin/library/proxmox') {
          if (posts && ++checks === 1) throw Error('FjordHub genstarter');
          const ready = posts && checks > 1;
          return {errors:[],ctid:'1000',storages:[],disks:[],mounts:[],host_storage:{available:true,
            job:{state:ready?'ready':'idle',message:ready?'Lageret er klar':'Vælg lager'},
            pools:[{id:'a'.repeat(20),source:'/mnt/media',target:'/mnt/fjordflix/pool-test',type:'mergerfs',allow_other:true,
              configured:!!ready,local_path:ready?'/library/server/fjordflix/pool-test':null}]}};
        }
        return original(path,method,body);
      };
    }''')
    page.locator('#source-proxmox').click()
    page.once('dialog', lambda dialog: dialog.accept())
    page.get_by_role('button', name='Tilslut lager', exact=True).click()
    expect(page.locator('#proxmox-pool-status')).to_contain_text('Starter tilslutningen')
    page.clock.fast_forward(5000)
    expect(page.locator('#proxmox-status')).to_have_text('FjordHub genstarter')
    page.clock.fast_forward(5000)
    expect(page.locator('#proxmox-pool-status')).to_have_text('Lageret er klar')
    expect(page.locator('#proxmox-pools').get_by_role('button', name='Vælg mappe')).to_be_visible()
    assert page.evaluate('posts') == 1
    assert not errors, errors
    browser.close()
print('Desktop/mobile guide, scope, optional ACL, focus and no mutation requests: passed')
