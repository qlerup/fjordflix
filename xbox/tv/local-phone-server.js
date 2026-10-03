/* A one-use HTTP setup service, bound only to Xbox's LAN address. */
(function (root) {
  'use strict';
  function bytes(text) {
    var encoded = unescape(encodeURIComponent(text)), result = [];
    for (var i = 0; i < encoded.length; i++) result.push(encoded.charCodeAt(i));
    return result;
  }
  function utf8(data) { return decodeURIComponent(escape(String.fromCharCode.apply(null, data))); }
  function parse(data) {
    var end = -1;
    if (data.length > 12288) throw new Error('Request too large');
    for (var i = 0; i < data.length - 3; i++) if (data[i] === 13 && data[i+1] === 10 && data[i+2] === 13 && data[i+3] === 10) { end = i; break; }
    if (end < 0) { if (data.length > 8192) throw new Error('Headers too large'); return null; }
    if (end > 8192) throw new Error('Headers too large');
    var lines = utf8(data.slice(0, end)).split('\r\n'), first = /^(GET|POST) ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift()), headers = {};
    if (!first) throw new Error('Invalid request');
    lines.forEach(function (line) {
      var match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (!match || headers[match[1].toLowerCase()] !== undefined) throw new Error('Invalid headers');
      headers[match[1].toLowerCase()] = match[2];
    });
    if (headers['transfer-encoding']) throw new Error('Transfer encoding unsupported');
    var length = headers['content-length'] || '0';
    if (!/^\d+$/.test(length) || +length > 4096) throw new Error('Body too large');
    if (data.length < end + 4 + +length) return null;
    return {method:first[1], path:first[2], headers:headers, body:utf8(data.slice(end+4, end+4 + +length))};
  }
  function response(status, body, html) { return {status:status, body:html ? body : JSON.stringify(body), html:!!html}; }
  function wire(result) {
    var body = bytes(result.body), labels = {200:'OK',400:'Bad Request',403:'Forbidden',404:'Not Found',409:'Conflict',410:'Gone',429:'Too Many Requests',503:'Unavailable'};
    return bytes('HTTP/1.1 ' + result.status + ' ' + (labels[result.status] || 'Error') + '\r\nContent-Type: ' +
      (result.html ? 'text/html' : 'application/json') + '; charset=utf-8\r\nContent-Length: ' + body.length +
      '\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; connect-src \'self\'; form-action \'self\'; frame-ancestors \'none\'\r\n\r\n').concat(body);
  }
  function session(options) {
    var active = true, busy = false, attempts = 0, pending = null, expires = Date.now() + 300000;
    var path = '/' + options.secret + '/', host = options.origin.replace(/^http:\/\//, '');
    function valid() { return active && Date.now() < expires; }
    function close() { active = false; if (pending && options.revoke) options.revoke(pending); pending = null; }
    function handle(req) {
      if (!valid()) return Promise.resolve(response(410, {error:'Login-siden er lukket. Lav en ny QR-kode på Xboxen.'}));
      if (req.headers.host !== host) return Promise.resolve(response(403, {error:'Ugyldig adresse.'}));
      if (req.method === 'GET' && req.path === path) return Promise.resolve(response(200, options.page, true));
      if (req.method !== 'POST' || req.path !== path + 'login') return Promise.resolve(response(404, {error:'Siden findes ikke.'}));
      if (req.headers.origin !== options.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return Promise.resolve(response(403, {error:'Ugyldig forespørgsel.'}));
      if (busy) return Promise.resolve(response(409, {error:'Et login er allerede i gang.'}));
      if (++attempts > 10) return Promise.resolve(response(429, {error:'For mange forsøg. Lav en ny QR-kode på Xboxen.'}));
      var data;
      try {
        data = JSON.parse(req.body);
        if (!data || typeof data.server !== 'string' || data.server.length > 256 || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 128 || typeof data.password !== 'string' || !data.password || data.password.length > 1024) throw new Error('Udfyld server, brugernavn og adgangskode.');
      } catch (error) { return Promise.resolve(response(400, {error:'Udfyld server, brugernavn og adgangskode.'})); }
      busy = true;
      return Promise.resolve().then(function () { return options.login(data); }).then(function (result) {
        data.password = ''; busy = false;
        if (!valid()) { if (options.revoke) options.revoke(result); return response(410, {error:'Login blev annulleret eller udløb. Lav en ny QR-kode.'}); }
        active = false;
        pending = result;
        var reply = response(200, {ok:true});
        reply.complete = function () { if (pending) { pending = null; options.accept(result); } };
        reply.abort = close; return reply;
      }, function (error) {
        data.password = ''; busy = false;
        return response(400, {error:error.message || 'Login mislykkedes.'});
      });
    }
    return {handle:handle, close:close, expires:expires};
  }
  function available() { return !!(root.Windows && root.Windows.Networking && root.Windows.Networking.Sockets); }
  function secret() {
    var buffer = new Uint8Array(32);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(buffer);
    else {
      var crypt = root.Windows.Security.Cryptography.CryptographicBuffer;
      return crypt.encodeToBase64String(crypt.generateRandom(32)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    }
    return root.btoa(String.fromCharCode.apply(null, buffer)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }
  function lanAddress() {
    var info = root.Windows.Networking.Connectivity.NetworkInformation, names = info.getHostNames(), candidates = [], profile = info.getInternetConnectionProfile();
    for (var i = 0; i < names.length; i++) {
      var name = names[i], ip = name.canonicalName;
      if (name.ipInformation && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        if (profile && profile.networkAdapter && name.ipInformation.networkAdapter.networkAdapterId === profile.networkAdapter.networkAdapterId) return ip;
        candidates.push(ip);
      }
    }
    if (!candidates.length) throw new Error('Xboxen har ingen lokal IPv4-adresse. Tilslut Xbox og telefon til samme lokalnetværk.');
    return candidates[0];
  }
  function start(options) {
    if (!available()) return Promise.reject(new Error('Den lokale login-side kræver Xbox-appen.'));
    var win = root.Windows, listener, state, sockets = [], closed = false, expiryTimer;
    function close() {
      if (closed) return; closed = true; clearTimeout(expiryTimer);
      if (state) state.close();
      if (listener) listener.close();
      sockets.slice().forEach(function (socket) { socket.close(); }); sockets = [];
    }
    function connection(event) {
      var socket = event.socket;
      if (closed || sockets.length >= 4) { socket.close(); return; }
      sockets.push(socket);
      var reader = new win.Storage.Streams.DataReader(socket.inputStream), writer, data = [], done = false;
      reader.inputStreamOptions = win.Storage.Streams.InputStreamOptions.partial;
      function finish() {
        if (done) return; done = true; clearTimeout(timeout);
        sockets = sockets.filter(function (item) { return item !== socket; });
        reader.close(); if (writer) writer.close(); socket.close();
      }
      var timeout = setTimeout(finish, 15000);
      function send(result) {
        if (done || closed) { if (result.abort) result.abort(); return; }
        writer = new win.Storage.Streams.DataWriter(socket.outputStream); writer.writeBytes(wire(result));
        return writer.storeAsync().then(function () {
          finish();
          if (result.complete) { try { result.complete(); } finally { close(); } }
        }, function () { if (result.abort) result.abort(); finish(); });
      }
      function read() {
        return reader.loadAsync(4096).then(function (length) {
          if (done || closed) return;
          if (!length) { finish(); return; }
          var chunk = new Uint8Array(length); reader.readBytes(chunk);
          for (var i = 0; i < chunk.length; i++) data.push(chunk[i]);
          var req = parse(data);
          if (!req) return read();
          return state.handle(req).then(send);
        });
      }
      read().then(null, function () { finish(); });
    }
    return Promise.resolve().then(function () {
      var ip = lanAddress(); listener = new win.Networking.Sockets.StreamSocketListener();
      listener.onconnectionreceived = connection;
      return listener.bindEndpointAsync(new win.Networking.HostName(ip), '').then(function () {
        var origin = 'http://' + ip + ':' + listener.information.localPort, code = secret();
        state = session({secret:code,origin:origin,page:root.FjordPhonePage,login:options.login,accept:options.accept,revoke:options.revoke});
        expiryTimer = setTimeout(function () { close(); if (options.expired) options.expired(); }, 300000);
        return {url:origin + '/' + code + '/',expires:state.expires,close:close};
      });
    }).then(null, function (error) { close(); throw error; });
  }
  var api = {available:available,start:start,session:session,parse:parse,wire:wire,bytes:bytes};
  root.FjordLocalPhoneServer = api;
  if (typeof module !== 'undefined') module.exports = api;
}(typeof window !== 'undefined' ? window : this));
