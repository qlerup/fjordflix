"""Custom player regression checks against the disposable remote-test server on 8097."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out=Path(__file__).resolve().parents[1]/'test-results'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':960})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://localhost:8097')
    page.get_by_label('Brugernavn',exact=True).fill('Remote QA')
    page.get_by_label('Adgangskode',exact=True).fill('Temporary-remote-test-73!')
    page.locator('#auth-submit').click()
    page.locator('.movie-card').first.click()
    page.locator('#detail-quality').select_option('720')
    page.locator('#play-button').click()
    page.wait_for_function('() => playback && !switching && video.currentTime > .1')
    assert page.locator('#video').evaluate('(v)=>!v.controls')
    assert page.locator('#player-dialog #timeline').count()==1
    page.locator('#player-toggle').click()
    page.wait_for_function('() => video.paused')
    expect(page.locator('#player-toggle')).to_have_attribute('aria-label','Afspil')
    page.locator('#player-mute').click()
    assert page.locator('#video').evaluate('(v)=>v.muted')
    page.locator('#player-mute').click()
    assert not page.locator('#video').evaluate('(v)=>v.muted')
    # A seek on the single timeline restarts HLS but keeps original-film time.
    box=page.locator('#timeline').bounding_box()
    page.mouse.click(box['x']+box['width']/3,box['y']+box['height']/2)
    page.wait_for_function('() => playback && playback.offset > 2 && !switching && video.currentTime > .1')
    assert page.evaluate('position()')>3
    page.locator('#player-toggle').click()
    page.wait_for_function('() => video.paused')
    page.locator('#player-fullscreen').click()
    page.wait_for_function('() => document.fullscreenElement === document.documentElement')
    expect(page.locator('#timeline')).to_be_visible()
    page.locator('#player-fullscreen').click()
    page.wait_for_function('() => !document.fullscreenElement')
    page.screenshot(path=str(out/'player-desktop.png'))
    # Hide during playback, then reveal controls from remote movement.
    page.locator('#player-toggle').click()
    page.mouse.move(2,2)
    page.wait_for_function('() => document.getElementById("player-dialog").classList.contains("controls-hidden")',timeout=6000)
    page.evaluate('wakePlayerControls()')
    expect(page.locator('#player-toggle')).to_be_visible()
    page.locator('#player-toggle').click()
    page.set_viewport_size({'width':390,'height':844})
    expect(page.locator('#timeline')).to_be_visible()
    expect(page.locator('#player-quality')).to_be_visible()
    assert page.evaluate('document.getElementById("player-dialog").scrollWidth <= innerWidth')
    page.screenshot(path=str(out/'player-mobile.png'))
    page.locator('#player-close').click()
    expect(page.locator('#player-dialog')).not_to_be_visible()
    assert not errors,errors
    print('PASS: custom play/pause, mute, one full-movie timeline, transcoded seek offset, fullscreen, auto-hide, mobile layout, close. No JS errors.')
    browser.close()
