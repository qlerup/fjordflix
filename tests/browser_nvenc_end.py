"""Chrome playback regression on the GPU QA server (prepared by browser_media.py)."""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page()
    page.goto('http://localhost:8097')
    page.locator('#username').fill('Media QA')
    page.locator('#password').fill('Temporary-media-test-73!')
    page.locator('#auth-submit').click()
    page.locator('.movie-card').first.click()
    page.locator('#detail-quality').select_option('720')
    page.locator('#play-button').click()
    page.wait_for_function('() => playback && !switching')
    page.evaluate('startPlayback(0)')
    page.evaluate('''() => {
      window.mediaEvents=[];
      for(const name of ['waiting','playing','ended','error']) video.addEventListener(name,()=>mediaEvents.push({event:name,time:video.currentTime,at:performance.now()}));
      hls.on(Hls.Events.ERROR,(_,d)=>mediaEvents.push({event:d.details,fatal:d.fatal,time:video.currentTime,at:performance.now()}));
    }''')
    page.wait_for_timeout(18000)
    state=page.evaluate('''() => ({encoder:playback.encoder,offset:playback.offset,time:video.currentTime,duration:video.duration,ended:video.ended,ready:video.readyState,loading:!$('player-loading').hidden,events:mediaEvents})''')
    print(json.dumps(state))
    assert state['encoder']=='NVIDIA NVENC'
    assert state['offset']==0 and state['ended'] and state['time']>=11 and not state['loading']
    browser.close()
