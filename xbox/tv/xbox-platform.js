/* Xbox host integration. The browser simulator uses the standard Gamepad API. */
(function (root) {
  'use strict';
  function actionForKey(key) {
    return {195:'select',196:'back',197:'toggle',198:'search',199:'forward',200:'rewind',
      203:'up',204:'down',205:'left',206:'right',211:'up',212:'down',213:'right',214:'left',
      207:'toggle'}[key];
  }
  if (typeof module !== 'undefined') module.exports = {actionForKey:actionForKey};
  if (!root.document) return;
  var document = root.document, previousFocus, dialog, priorButtons = {}, repeats = {}, controls;
  var nativeHost = !!root.Windows;
  var viewManagement = nativeHost && root.Windows.UI.ViewManagement;
  if (viewManagement && viewManagement.ApplicationViewScaling) {
    if (!viewManagement.ApplicationViewScaling.trySetDisableLayoutScaling(true)) {
      root.console.warn('Xbox layout scaling could not be disabled.');
    }
  }
  function inputPane() {
    return viewManagement && viewManagement.InputPane && viewManagement.InputPane.getForCurrentView();
  }
  function showKeyboard() {
    var pane = inputPane();
    if (pane && !pane.tryShow()) root.console.warn('Xbox declined the on-screen keyboard request.');
  }
  function hideKeyboard() { var pane = inputPane(); if (pane) pane.tryHide(); }
  // Xbox keyboard mode emits Gamepad VirtualKey events instead of a mouse cursor.
  if ('gamepadInputEmulation' in root.navigator) root.navigator.gamepadInputEmulation = 'keyboard';
  function editing() { var el = document.activeElement; return el && el.tagName === 'INPUT' && !el.readOnly && el.type !== 'checkbox'; }
  function click(id) { var el = document.getElementById(id); if (el && !el.disabled) el.click(); }
  function key(code) {
    var event = document.createEvent('Event'); event.initEvent('keydown', true, true);
    Object.defineProperty(event, 'keyCode', {value:code});
    (document.activeElement || document).dispatchEvent(event);
  }
  function action(name) {
    if (dialog) {
      if (name === 'back') closeDialog();
      else if (name === 'select') document.activeElement.click();
      else if (name === 'left' || name === 'right') {
        var buttons = dialog.querySelectorAll('button');
        (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus();
      }
      return;
    }
    if (name === 'select') {
      var focused = document.activeElement;
      if (focused && (focused.tagName === 'BUTTON' || focused.tagName === 'A')) focused.click();
      else key(13);
    } else if (name === 'back') key(27);
    else if (!editing()) {
      if ({up:38,down:40,left:37,right:39}[name]) key({up:38,down:40,left:37,right:39}[name]);
      else if (name === 'search' && !document.getElementById('library').hidden) document.getElementById('search').focus();
      else if (!document.getElementById('player').hidden) {
        if (root.TVNavigation) root.TVNavigation.activity();
        if (name === 'toggle') click('toggle');
        if (name === 'rewind') click('rewind');
        if (name === 'forward') click('forward');
      }
    }
  }
  document.addEventListener('keydown', function (event) {
    var name = actionForKey(event.keyCode);
    if (name) {
      // The Xbox system keyboard must retain navigation and typing ownership.
      if (editing() && nativeHost) return;
      if (editing() && name !== 'back' && name !== 'select') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat || ['up','down','left','right'].indexOf(name) >= 0) action(name);
    } else if (dialog && event.keyCode === 27) {
      event.preventDefault(); event.stopImmediatePropagation(); closeDialog();
    }
  }, true);
  function closeDialog() {
    if (!dialog) return; document.body.removeChild(dialog); dialog = null;
    if (previousFocus) previousFocus.focus();
  }
  function requestExit() {
    if (dialog) return;
    previousFocus = document.activeElement;
    dialog = document.createElement('section'); dialog.className = 'exit-dialog';
    dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-label','Luk FjordFlix');
    var panel = document.createElement('div'), title = document.createElement('h1');
    title.textContent = 'Luk FjordFlix?'; panel.appendChild(title);
    var stay = document.createElement('button'), exit = document.createElement('button');
    stay.textContent = 'Bliv her'; stay.className = 'primary'; stay.onclick = closeDialog;
    exit.textContent = 'Luk appen'; exit.onclick = function () { root.close(); };
    panel.appendChild(stay); panel.appendChild(exit); dialog.appendChild(panel); document.body.appendChild(dialog); stay.focus();
  }
  root.XboxPlatform = {action:action, requestExit:requestExit, showKeyboard:showKeyboard, hideKeyboard:hideKeyboard, suspend:function () { return Promise.resolve(); }};
  // A normal browser has no Xbox VirtualKey events; poll standard-mapped controllers.
  if (!nativeHost && root.navigator.getGamepads) {
    function poll() {
      if (!document.hidden) {
        var pads = root.navigator.getGamepads(), current = {};
        for (var i = 0; i < pads.length; i++) {
          var pad = pads[i]; if (!pad || pad.mapping !== 'standard') continue;
          function pressed(index) { return pad.buttons[index] && pad.buttons[index].pressed; }
          [['select',0],['back',1],['toggle',2],['search',3],['rewind',4],['forward',5],
            ['up',12],['down',13],['left',14],['right',15]].forEach(function (pair) { if (pressed(pair[1])) current[pair[0]] = true; });
          if (pad.axes[0] < -.6) current.left = true; if (pad.axes[0] > .6) current.right = true;
          if (pad.axes[1] < -.6) current.up = true; if (pad.axes[1] > .6) current.down = true;
        }
        var now = Date.now();
        Object.keys(current).forEach(function (name) {
          if (!priorButtons[name]) { action(name); repeats[name] = now + 400; }
          else if (['up','down','left','right'].indexOf(name) >= 0 && now >= repeats[name]) { action(name); repeats[name] = now + 130; }
        });
        priorButtons = current;
      } else { priorButtons = {}; repeats = {}; }
      root.requestAnimationFrame(poll);
    }
    root.requestAnimationFrame(poll);
  }
  document.addEventListener('DOMContentLoaded', function () {
    if (!nativeHost) return;
    var video = document.getElementById('video');
    var application = root.Windows.UI.WebUI.WebUIApplication;
    application.addEventListener('suspending', function (event) {
      var deferral = event.suspendingOperation.getDeferral();
      video.pause();
      // Leave room in Xbox's suspension budget if a server is offline.
      var done = false, timer = setTimeout(finish, 2500);
      function finish() { if (!done) { done = true; clearTimeout(timer); deferral.complete(); } }
      root.XboxPlatform.suspend().then(finish, finish);
    });
    var media = root.Windows.Media;
    controls = media.SystemMediaTransportControls.getForCurrentView();
    controls.isPlayEnabled = true; controls.isPauseEnabled = true; controls.isStopEnabled = true;
    controls.addEventListener('buttonpressed', function (event) {
      if (event.button === media.SystemMediaTransportControlsButton.play) key(415);
      if (event.button === media.SystemMediaTransportControlsButton.pause) key(19);
      if (event.button === media.SystemMediaTransportControlsButton.stop) key(413);
    });
    function status(value) { controls.playbackStatus = value; controls.isEnabled = !document.getElementById('player').hidden; }
    video.addEventListener('playing', function () { status(media.MediaPlaybackStatus.playing); });
    video.addEventListener('pause', function () { status(media.MediaPlaybackStatus.paused); });
    video.addEventListener('emptied', function () { status(media.MediaPlaybackStatus.closed); });
    video.addEventListener('ended', function () { status(media.MediaPlaybackStatus.stopped); });
  });
}(typeof window !== 'undefined' ? window : this));
