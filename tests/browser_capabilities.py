from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    for channel in [None, 'msedge']:
        browser = p.chromium.launch(headless=True, channel=channel)
        page = browser.new_page()
        page.goto('http://localhost:8097')
        page.get_by_label('Brugernavn', exact=True).fill('Browser Tester')
        page.get_by_label('Adgangskode', exact=True).fill('Temporary-browser-test-73!')
        page.get_by_role('button', name='Log ind', exact=False).first.click()
        page.wait_for_selector('.movie-card')
        print(page.evaluate("async () => ({movie:library[0],caps:await capabilities(library[0],'original')})"))
        print(channel, page.evaluate('''async () => {
          const v = document.createElement('video');
          return {h264:v.canPlayType('video/mp4; codecs="avc1.640033"'),
            aac:v.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
            decoding:await navigator.mediaCapabilities.decodingInfo({type:'file',video:{contentType:'video/mp4; codecs="avc1.640033"', width:3840,height:2160,bitrate:35000000,framerate:24}})};
        }'''))
        browser.close()
