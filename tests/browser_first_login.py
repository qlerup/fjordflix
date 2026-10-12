"""Exercise the actual login handler with synthetic Hub responses."""
from pathlib import Path
from playwright.sync_api import sync_playwright

source = (Path(__file__).resolve().parents[1] / 'app/static/app.js').read_text(encoding='utf-8')
handler = source[source.index("$('auth-form').onsubmit ="):source.index('async function boot()')]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('''<form id="auth-form"><input id="username" value="tester">
      <input id="password" type="password" value="temporary"><input id="invite">
      <button id="auth-submit">Login</button><p id="auth-error"></p></form>''')
    page.add_script_tag(content='''const $ = id => document.getElementById(id);
      let authMode = 'login'; window.payloads = [];
      async function api(path, method, data) { payloads.push(data); return window.reply; }
      async function boot() { return window.sessionReady; }
    ''' + handler)
    page.evaluate("reply = {onboarding_required:true, password_required:true, email_required:true, error:'Udfyld oplysningerne'}")
    page.click('#auth-submit')
    assert page.locator('#first-login-email').is_visible()
    assert page.locator('#first-login-password').is_visible()
    assert page.input_value('#password') == 'temporary'
    page.fill('#first-login-email', 'test@example.com')
    page.fill('#first-login-password', 'personal-password')
    page.fill('#first-login-password-confirm', 'personal-password')
    page.evaluate('reply = {ok:true}; sessionReady = false')
    page.click('#auth-submit')
    assert 'sessionen' in page.locator('#auth-error').inner_text()
    assert page.input_value('#password') == 'temporary'
    assert page.evaluate('payloads.at(-1).first_login_email') == 'test@example.com'
    assert page.evaluate('payloads.at(-1).first_login_password') == 'personal-password'
    page.evaluate('sessionReady = true')
    page.click('#auth-submit')
    assert page.input_value('#password') == ''
    assert page.locator('#first-login-password').count() == 0
    assert page.locator('#auth-error').inner_text() == ''
    page.evaluate("reply = {}; document.getElementById('password').value = 'temporary'")
    page.click('#auth-submit')
    assert page.locator('#auth-error').inner_text()
    assert page.input_value('#password') == 'temporary'
    browser.close()
print('PASS: first-login fields, payload, session failure, success and invalid response.')
