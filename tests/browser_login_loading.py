"""Login must not depend on downloading the video library."""
import time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width':390, 'height':844})
    cdp = page.context.new_cdp_session(page)
    cdp.send('Network.enable')
    cdp.send('Network.emulateNetworkConditions', {
        'offline':False, 'latency':150, 'downloadThroughput':64000,
        'uploadThroughput':32000, 'connectionType':'cellular3g'})
    requests = []
    page.on('request', lambda request: requests.append(request.url))
    page.route('**/vendor/hls.min.js', lambda route: route.abort())
    start = time.monotonic()
    page.goto('http://127.0.0.1:8096')
    page.locator('#auth-submit').wait_for(state='visible')
    assert not any('/vendor/hls.min.js' in url for url in requests)
    assert page.evaluate('typeof window.Hls') == 'undefined'
    print(f'Login visible in {time.monotonic()-start:.2f}s at simulated 512 kbit/s; no HLS request.')
    failure = page.evaluate('() => loadHlsLibrary().then(() => false, () => true)')
    assert failure
    page.unroute('**/vendor/hls.min.js')
    page.evaluate('() => loadHlsLibrary()')
    assert page.evaluate('typeof window.Hls') == 'function'
    print('PASS: player library loads on demand and can retry a failed download.')
    browser.close()
