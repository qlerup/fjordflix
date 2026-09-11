"""Two independent browser contexts, reading the actual displayed QR and sending touch input."""
import math
import sys
from pathlib import Path
import cv2
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
out = Path(__file__).resolve().parents[1]/'test-results'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    tv_context = browser.new_context(viewport={'width':1440,'height':1000})
    mobile_context = browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    tv = tv_context.new_page()
    phone = mobile_context.new_page()
    errors=[]
    tv.on('pageerror',lambda e:errors.append(str(e)))
    phone.on('pageerror',lambda e:errors.append(str(e)))
    clicks=[]
    phone.on('websocket', lambda ws: ws.on('framesent', lambda data: clicks.append(data) if '"click"' in str(data) else None))
    tv.goto('http://localhost:8097')
    tv.get_by_label('Brugernavn',exact=True).fill('Remote QA')
    tv.get_by_label('Adgangskode',exact=True).fill('Temporary-remote-test-73!')
    tv.locator('#auth-submit').click()
    expect(tv.get_by_role('button',name='Fjernbetjening',exact=True)).to_be_visible()
    tv.get_by_role('button',name='Fjernbetjening',exact=True).click()
    expect(tv.locator('#remote-status')).to_have_text('Scan koden med kameraet på din telefon')
    tv.locator('.qr-paper').screenshot(path=str(out/'remote-qr.png'))
    qr_image=cv2.imread(str(out/'remote-qr.png'))
    qr_url = ''
    for scale in (1, 2, 3, 4):
        qr_url,_,_ = cv2.QRCodeDetector().detectAndDecode(cv2.resize(qr_image,None,fx=scale,fy=scale,interpolation=cv2.INTER_NEAREST))
        if qr_url: break
    assert qr_url.startswith('http://localhost:8097/remote#'), 'QR must decode into a valid local pairing link'
    tv.screenshot(path=str(out/'08-remote-pair.png'),full_page=True)
    phone.goto(qr_url)
    phone.get_by_role('button',name='Forbind til skærmen').click()
    expect(phone.locator('#remote-connection-status')).to_have_text('Forbundet · klar til filmaften')
    expect(tv.locator('#remote-dialog')).not_to_be_visible()
    expect(tv.locator('#remote-cursor')).to_be_visible()
    assert '#' not in phone.url, 'Pair secret must be removed from address bar'

    pad = phone.locator('#touchpad')
    touch = mobile_context.new_cdp_session(phone)
    def drag(dx,dy):
        box=pad.bounding_box()
        x,y=box['x']+box['width']/2,box['y']+box['height']/2
        touch.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1}]})
        touch.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+dx,'y':y+dy,'id':1}]})
        touch.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    before=tv.locator('#remote-cursor').bounding_box()
    drag(40,20)
    tv.wait_for_function('x => Math.abs(document.getElementById("remote-cursor").getBoundingClientRect().x-x)<2',arg=before['x']+80)

    def click_on_tv(locator, tap=False):
        target=locator.bounding_box()
        target_x,target_y=target['x']+target['width']/2,target['y']+target['height']/2
        current=tv.locator('#remote-cursor').bounding_box()
        dx,dy=target_x-current['x'],target_y-current['y']
        count=max(1,math.ceil(max(abs(dx),abs(dy))/160))
        for _ in range(count):
            drag(dx/count/2,dy/count/2)
        tv.wait_for_function('p => {let r=document.getElementById("remote-cursor").getBoundingClientRect();return Math.abs(r.x-p.x)<3 && Math.abs(r.y-p.y)<3;}',arg={'x':target_x,'y':target_y})
        before_clicks=len(clicks)
        if tap:
            pad.tap()
        else:
            phone.get_by_role('button',name='Klik / vælg').tap()
        phone.wait_for_timeout(400)
        assert len(clicks)==before_clicks+1, 'One touch must send exactly one click'

    # The reported failure: generate the demo through the paired phone.
    click_on_tv(tv.locator('#demo-button'), tap=True)
    expect(tv.locator('.movie-card').first).to_be_visible(timeout=180000)
    expect(tv.locator('#demo-button')).to_be_enabled(timeout=180000)

    # Select a film entirely through the phone's touchpad and click button.
    click_on_tv(tv.locator('.movie-card').first)
    expect(tv.locator('#detail')).to_be_visible()
    click_on_tv(tv.locator('#favorite-button'), tap=True)
    expect(tv.locator('#favorite-button')).to_contain_text('På min liste')
    click_on_tv(tv.locator('#play-button'), tap=True)
    expect(tv.locator('#player-dialog')).to_be_visible()
    tv.wait_for_function('() => document.getElementById("video").currentTime > 0.1',timeout=30000)
    click_on_tv(tv.locator('#player-toggle'), tap=True)
    tv.wait_for_function('() => video.paused')
    click_on_tv(tv.locator('#timeline'), tap=True)
    tv.wait_for_function('() => !switching && position() >= 5 && video.currentTime > .1',timeout=30000)
    phone.get_by_role('button',name='Afspil eller pause').tap()
    tv.wait_for_function('() => document.getElementById("video").paused')
    phone.get_by_role('button',name='← Tilbage',exact=True).tap()
    expect(tv.locator('#player-dialog')).not_to_be_visible()
    phone.get_by_label('Find en film').fill('Ingen film matcher dette')
    phone.get_by_role('button',name='Søg',exact=True).click()
    expect(tv.get_by_role('heading',name='Ingen film matcher søgningen')).to_be_visible()
    click_on_tv(tv.locator('#admin-open'))
    expect(tv.locator('#admin-dialog')).not_to_be_visible()
    expect(tv.locator('#toast')).to_contain_text('Brug pc’en')
    phone.screenshot(path=str(out/'09-phone-touchpad.png'),full_page=True)
    assert phone.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'No mobile horizontal overflow'
    # An unrelated browser tab on the same account must not receive commands.
    other=tv_context.new_page();other.goto('http://localhost:8097')
    expect(other.locator('#search')).to_have_value('')
    tv.get_by_role('button',name='Fjernbetjening',exact=True).click()
    tv.get_by_role('button',name='Afbryd telefon',exact=True).click()
    expect(phone.locator('#connect-error')).to_contain_text('Parringen er afsluttet')
    assert not errors,errors
    print('PASS: QR decoded, actual touch movement, touchpad tap generates demo, click button selects movie, taps favorite and play, pauses, goes back, searches, screen isolation, revocation. No JS errors.')
    browser.close()
