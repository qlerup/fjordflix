/* Spatial navigation for Xbox controller, media remote and keyboard. */
(function () {
  'use strict';
  function visible(el) { return !el.disabled && el.getClientRects().length && el.offsetWidth > 0; }
  window.TVNavigation = {back: function () { window.close(); }, activity: function () {}};
  function textField(el) { return el && el.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'url', 'tel'].indexOf(el.type) >= 0; }
  function finishEditing(el) {
    if (window.XboxPlatform) window.XboxPlatform.hideKeyboard();
    el.blur(); el.readOnly = true; el.focus();
  }
  function edit(el) {
    // Navigation focus alone must not open the keyboard. Request it on activation.
    if (el.readOnly) { el.blur(); el.readOnly = false; el.focus(); }
    if (window.XboxPlatform) window.XboxPlatform.showKeyboard();
  }
  Array.prototype.forEach.call(document.querySelectorAll('input'), function (el) {
    if (!textField(el)) return;
    el.readOnly = true;
    el.addEventListener('click', function () { edit(el); });
  });
  if (window.Windows && window.Windows.UI.ViewManagement && window.Windows.UI.ViewManagement.InputPane) {
    window.Windows.UI.ViewManagement.InputPane.getForCurrentView().addEventListener('hiding', function () {
      var el = document.activeElement;
      // Restore D-pad navigation when Xbox dismisses its keyboard.
      if (textField(el)) el.readOnly = true;
    });
  }
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
      if (key === 13 || ((key === 461 || key === 27) && !current.readOnly)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.repeat) return;
        if (current.readOnly) edit(current); else finishEditing(current);
        return;
      }
      // While editing, the keyboard owns arrows and cursor movement.
      if (!current.readOnly) return;
    }
    if (key === 13 && current && current.type === 'checkbox') { event.preventDefault(); current.click(); return; }
    if (key === 461 || key === 27) { event.preventDefault(); window.TVNavigation.back(); return; }
    if ([37, 38, 39, 40].indexOf(key) < 0) return;
    // Leave horizontal cursor movement and native select interaction to the TV keyboard.
    if (current && current.tagName === 'SELECT') return;
    var root = document.getElementById('player');
    if (!root || root.hidden) root = document.getElementById('detail');
    if (!root || root.hidden) root = document;
    var items = Array.prototype.filter.call(root.querySelectorAll('button,input,select,a[href]'), visible);
    if (!items.length) return;
    event.preventDefault();
    if (items.indexOf(current) < 0) { items[0].focus(); return; }
    var box = current.getBoundingClientRect(), horizontal = key === 37 || key === 39;
    var best = null, score = Infinity, bestAligned = false;
    items.forEach(function (item) {
      if (item === current) return;
      var r = item.getBoundingClientRect();
      // Use rectangle edges: a wide control still lies directly below a small button.
      // Reject overlapping rows/columns so different button heights cannot cause sideways jumps.
      var forward = key === 37 ? box.left - r.right : key === 39 ? r.left - box.right :
        key === 38 ? box.top - r.bottom : r.top - box.bottom;
      if (forward < -1) return;
      var cross = horizontal ? Math.max(0, box.top - r.bottom, r.top - box.bottom) :
        Math.max(0, box.left - r.right, r.left - box.right);
      var aligned = cross === 0;
      var distance = Math.max(0, forward) + cross * 3 +
        Math.abs(horizontal ? r.top - box.top : r.left - box.left) * 0.01;
      if (!best || (aligned && !bestAligned) || (aligned === bestAligned && distance < score)) {
        score = distance; best = item; bestAligned = aligned;
      }
    });
    if (best) { best.focus(); if (best.scrollIntoViewIfNeeded) best.scrollIntoViewIfNeeded(false); else best.scrollIntoView(false); }
  });
}());
