(function (root) {
  'use strict';
  function normalize(value, useHttps) {
    value = value.trim();
    if (!value || /[\s\\]/.test(value)) throw new Error('Skriv en gyldig IP-adresse eller et domæne.');
    if (typeof useHttps === 'boolean') value = (useHttps ? 'https://' : 'http://') + value.replace(/^https?:\/\//i, '');
    if (!/^https?:\/\//i.test(value)) {
      // Never silently send credentials over HTTP to a public domain.
      var local = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?\/?$/i.test(value);
      value = (local ? 'http://' : 'https://') + value;
    }
    var match = /^(https?):\/\/([a-z0-9.-]+|\[[a-f0-9:]+\])(?::(\d+))?\/?$/i.exec(value);
    if (!match || match[3] && (+match[3] < 1 || +match[3] > 65535)) throw new Error('Brug kun http(s)://server:port uden sti, login eller andre tegn.');
    return value.replace(/\/$/, '');
  }
  root.FjordServerURL = normalize;
  if (typeof module !== 'undefined') module.exports = normalize;
}(typeof window !== 'undefined' ? window : this));
