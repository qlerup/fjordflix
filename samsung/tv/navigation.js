/* ES5 syntax and rectangle-based navigation for Samsung 3+ (Chromium 38+). */
(function () {
  'use strict';
  function visible(el) { return !el.disabled && el.getClientRects().length && el.offsetWidth > 0; }
  window.TVNavigation = {back: function () { window.close(); }, activity: function () {}};
  function textField(el) { return el && el.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'url', 'tel'].indexOf(el.type) >= 0; }
  function finishEditing(el) { el.blur(); el.readOnly = true; el.focus(); }
  function edit(el) {
    if (!el.readOnly) return;
    // Samsung opens its keyboard on editable focus, so navigation focus stays read-only.
    el.blur(); el.readOnly = false; el.focus();
  }
  Array.prototype.forEach.call(document.querySelectorAll('input'), function (el) {
    if (!textField(el)) return;
    el.readOnly = true;
    el.addEventListener('click', function () { edit(el); });
  });
  // The system keyboard can take focus away from the web app. That is not
  // the user leaving the field: making it read-only here closes the keyboard.
  document.addEventListener('focusin', function (event) {
    Array.prototype.forEach.call(document.querySelectorAll('input'), function (el) {
      if (textField(el) && el !== event.target) el.readOnly = true;
    });
  });
  document.addEventListener('keydown', function (event) {
    var key = event.keyCode, current = document.activeElement;
    window.TVNavigation.activity();
    if (textField(current)) {
      if (key === 13 || (((key === 461 || key === 10009) || key === 27) && !current.readOnly)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.repeat) return;
        if (current.readOnly) edit(current); else finishEditing(current);
        return;
      }
      // While editing, the keyboard owns arrows and cursor movement.
      if (!current.readOnly) return;
    }
    if (key === 13 && current && current.type === 'checkbox') { event.preventDefault(); current.click(); return; }
    if ((key === 461 || key === 10009) || key === 27) { event.preventDefault(); if (!window.TVWishes || !window.TVWishes.back()) window.TVNavigation.back(); return; }
    if ([37, 38, 39, 40].indexOf(key) < 0) return;
    // Leave horizontal cursor movement and native select interaction to the TV keyboard.
    if (current && current.tagName === 'SELECT') return;
    var wishPanel = document.getElementById('wishes-panel');
    var root = document.getElementById('player');
    if (!root || root.hidden) root = document.getElementById('detail');
    if (!root || root.hidden) root = document;
    if (wishPanel && !wishPanel.hidden) root = wishPanel;
    var items = Array.prototype.filter.call(root.querySelectorAll('button,input,select,a[href]'), visible);
    if (!items.length) return;
    event.preventDefault();
    if (items.indexOf(current) < 0) { items[0].focus(); return; }
    var box = current.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    var best = null, score = Infinity;
    items.forEach(function (item) {
      if (item === current) return;
      var r = item.getBoundingClientRect(), dx = r.left + r.width / 2 - x, dy = r.top + r.height / 2 - y;
      var forward = key === 37 ? -dx : key === 39 ? dx : key === 38 ? -dy : dy;
      var cross = key === 37 || key === 39 ? Math.abs(dy) : Math.abs(dx);
      if (forward > 1 && forward + cross * 3 < score) { score = forward + cross * 3; best = item; }
    });
    if (best) { best.focus(); if (best.scrollIntoViewIfNeeded) best.scrollIntoViewIfNeeded(false); }
  });
}());
