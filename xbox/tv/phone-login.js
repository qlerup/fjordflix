/* Short-lived phone approval. The device secret stays in memory on this Xbox. */
(function (root) {
  'use strict';
  var current = null, receiveToken;
  function $(id) { return document.getElementById(id); }
  function request(base, path, data, token) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', base + '/tv-api' + path); xhr.timeout = 12000;
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.onload = function () {
        var result = {};
        try { result = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300) { resolve(result); return; }
        var error = new Error(typeof result.detail === 'string' ? result.detail : 'Kunne ikke kontakte serveren.');
        error.status = xhr.status; reject(error);
      };
      xhr.onerror = xhr.ontimeout = function () { reject(new Error('Forbindelsen til serveren blev afbrudt.')); };
      xhr.send(JSON.stringify(data || {}));
    });
  }
  function ignore() {}
  function timers(run) { clearTimeout(run.pollTimer); clearInterval(run.clockTimer); }
  function discard(run, pair) {
    return pair && pair.device_code ? request(run.server, '/pair/cancel', {device_code:pair.device_code}).catch(ignore) : Promise.resolve();
  }
  function showPanel(show) {
    $('phone-panel').hidden = !show; $('login-form').hidden = show;
    document.body.classList.toggle('phone-login-active', show);
  }
  function cancel() {
    var run = current; current = null;
    if (run) timers(run);
    if (run && run.local) run.local.close();
    showPanel(false); $('phone-qr').removeAttribute('src');
    return run ? discard(run, run.pair) : Promise.resolve();
  }
  function failed(run, message) {
    if (current !== run || run.done) return;
    run.done = true; timers(run); discard(run, run.pair);
    if (run.local) run.local.close();
    $('phone-status').textContent = message;
    $('phone-expires').textContent = '';
    $('phone-qr').hidden = true; $('phone-code').textContent = '';
    $('phone-retry').hidden = false; $('phone-retry').focus();
  }
  function tick(run) {
    if (current !== run || run.done) return;
    var seconds = Math.max(0, Math.ceil((run.expires - Date.now()) / 1000));
    $('phone-expires').textContent = 'Koden udløber om ' + Math.floor(seconds / 60) + ':' + ('0' + seconds % 60).slice(-2);
    if (!seconds) failed(run, 'QR-koden er udløbet. Lav en ny kode for at fortsætte.');
  }
  function poll(run) {
    if (current !== run || run.done) return;
    request(run.server, '/pair/poll', {device_code:run.pair.device_code}).then(function (result) {
      if (result.status === 'approved' && /^[A-Za-z0-9_-]{43}$/.test(result.token || '')) {
        if (current !== run || run.done) {
          // Cancellation can race a completed poll. Revoke any late session.
          request(run.server, '/logout', {}, result.token).catch(ignore); return;
        }
        timers(run); current = null; showPanel(false); $('phone-qr').removeAttribute('src');
        receiveToken(result.token, run.server); return;
      }
      if (current !== run || run.done) return;
      if (result.status !== 'pending') { failed(run, 'Serveren returnerede et ugyldigt login-svar. Prøv en ny kode.'); return; }
      $('phone-status').textContent = 'Venter på, at du logger ind på telefonen…';
      run.pollTimer = setTimeout(function () { poll(run); }, run.interval);
    }).catch(function (error) {
      if (current !== run || run.done) return;
      if (error.status && error.status < 500 && error.status !== 429) {
        failed(run, error.status === 410 ? 'QR-koden er udløbet eller allerede brugt. Lav en ny kode.' : error.message); return;
      }
      $('phone-status').textContent = 'Forbindelsen blev afbrudt. Prøver igen…';
      run.pollTimer = setTimeout(function () { poll(run); }, Math.max(5000, run.interval));
    });
  }
  function start(base) {
    if (root.FjordLocalPhoneServer && root.FjordLocalPhoneServer.available()) return startLocal();
    cancel();
    var run = {server:base}; current = run;
    showPanel(true); $('phone-cancel').focus();
    $('phone-code-label').textContent = 'Kontrollér, at telefonen viser denne kode:';
    $('phone-address-label').textContent = 'Du kan også åbne adressen på telefonen og skrive koden:';
    if (root.XboxPlatform) root.XboxPlatform.hideKeyboard();
    $('phone-qr').hidden = true; $('phone-retry').hidden = true;
    $('phone-code').textContent = ''; $('phone-address').textContent = base;
    $('phone-expires').textContent = ''; $('phone-status').textContent = 'Gør QR-koden klar…';
    return request(base, '/pair/start', {}).then(function (pair) {
      if (current !== run) { discard(run, pair); return; }
      run.pair = pair;
      if (!/^[A-Za-z0-9_-]{43}$/.test(pair.device_code || '') ||
          !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pair.user_code || '') ||
          !/^data:image\/svg\+xml;base64,/.test(pair.qr_data_url || '') || !pair.verification_uri ||
          !(pair.expires_in > 0 && pair.expires_in <= 600)) {
        failed(run, 'Serveren kunne ikke oprette QR-koden. Opdatér FjordFlix-serveren, og prøv igen.'); return;
      }
      run.interval = Math.max(3000, (Number(pair.interval) || 3) * 1000);
      run.expires = Date.now() + pair.expires_in * 1000;
      $('phone-qr').src = pair.qr_data_url; $('phone-qr').hidden = false;
      $('phone-code').textContent = pair.user_code;
      $('phone-address').textContent = pair.verification_uri;
      $('phone-status').textContent = 'Venter på, at du logger ind på telefonen…';
      tick(run); run.clockTimer = setInterval(function () { tick(run); }, 1000);
      run.pollTimer = setTimeout(function () { poll(run); }, run.interval);
    }).catch(function (error) {
      failed(run, error.status === 404 ? 'Opdatér FjordFlix-serveren for at bruge login via telefonen. Du kan stadig logge ind her på Xbox.' : error.message);
    });
  }
  function startLocal() {
    cancel();
    var run = {server:''}; current = run; showPanel(true); $('phone-cancel').focus();
    if (root.XboxPlatform) root.XboxPlatform.hideKeyboard();
    $('phone-qr').hidden = true; $('phone-retry').hidden = true; $('phone-code').textContent = '';
    $('phone-code-label').textContent = 'Telefon og Xbox skal være på samme lokalnetværk.';
    $('phone-address-label').textContent = 'Scan QR-koden eller åbn denne midlertidige adresse på telefonen:';
    $('phone-address').textContent = ''; $('phone-expires').textContent = '';
    $('phone-status').textContent = 'Åbner login-siden på din Xbox…';
    function revoke(result) { request(result.server, '/logout', {}, result.token).catch(ignore); }
    return root.FjordLocalPhoneServer.start({
      login:function (data) {
        var address = root.FjordServerURL(data.server);
        return request(address, '/login', {name:data.name,password:data.password}).then(function (result) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(result.token || '')) throw new Error('Serveren returnerede et ugyldigt login-svar.');
          return {server:address,token:result.token};
        });
      },
      accept:function (result) {
        if (current !== run || run.done) { revoke(result); return; }
        timers(run); current = null; showPanel(false); $('phone-qr').removeAttribute('src');
        receiveToken(result.token,result.server);
      }, revoke:revoke,
      expired:function () { failed(run,'Den midlertidige login-side er udløbet. Lav en ny QR-kode.'); }
    }).then(function (service) {
      if (current !== run || run.done) { service.close(); return; }
      run.local = service; run.expires = service.expires;
      var qr = root.qrcode(0,'M'); qr.addData(service.url); qr.make();
      $('phone-qr').src = qr.createDataURL(6,24); $('phone-qr').hidden = false;
      $('phone-address').textContent = service.url;
      $('phone-status').textContent = 'Skriv serveradresse og login på telefonen. Du behøver ikke udfylde noget på Xboxen.';
      tick(run); run.clockTimer = setInterval(function () { tick(run); },1000);
    }).catch(function (error) { failed(run,'Kunne ikke åbne den lokale login-side. ' + error.message); });
  }
  $('phone-cancel').onclick = function () { cancel(); $('phone-login').focus(); };
  $('phone-retry').onclick = function () { if (current) start(current.server); };
  root.TVPhoneLogin = {start:start, cancel:cancel, active:function () { return !!current; },
    setup:function (callback) { receiveToken = callback; }};
}(window));
