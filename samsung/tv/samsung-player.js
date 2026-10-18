/* Adapt AVPlay to the small media interface used by the shared TV client.
 * Units at the API boundary are milliseconds; the shared client uses seconds.
 * The HTML video remains the browser-preview fallback, never a second player.
 */
(function (root) {
  'use strict';
  function parseVTT(text) {
    var cues = [];
    String(text).replace(/\r/g, '').split(/\n\s*\n/).forEach(function (block) {
      var lines = block.split('\n'), timing = -1;
      for (var i = 0; i < Math.min(2, lines.length); i++) if (lines[i].indexOf('-->') >= 0) timing = i;
      if (timing < 0) return;
      var match = /^(?:(\d+):)?(\d{2}):(\d{2}\.\d+)\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2}\.\d+)/.exec(lines[timing]);
      if (!match) return;
      var start = (+match[1] || 0) * 3600 + +match[2] * 60 + +match[3];
      var end = (+match[4] || 0) * 3600 + +match[5] * 60 + +match[6];
      if (end > start) cues.push({startTime:start,endTime:end,text:lines.slice(timing + 1).join('\n').replace(/\n+$/, '')});
    });
    return cues;
  }
  function create(element) {
    var api = root.webapis && root.webapis.avplay;
    if (!api) return element;
    var player = {}, run = 0, source = '', ready = 0, paused = true, seeking = false;
    var now = 0, duration = 0, width = 0, height = 0, error = null, tracks = [], pendingSeek = null;
    var overlay = document.getElementById('samsung-subtitles');
    element.style.display = 'none';
    function emit(name) { if (typeof player['on' + name] === 'function') player['on' + name](); }
    function screenSaver(enabled) { if (root.SamsungPlatform) root.SamsungPlatform.screenSaver(enabled); }
    function subtitles() {
      if (!overlay) return;
      var lines = [];
      tracks.forEach(function (track) {
        if (track.track.mode !== 'showing') return;
        track.track.cues.forEach(function (cue) { if (cue.startTime <= now && now < cue.endTime) lines.push(cue.text); });
      });
      // VTT is untrusted server content. Always render text, never markup.
      overlay.textContent = lines.join('\n').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|nbsp);/g, function (entity) {
        return {'&amp;':'&','&lt;':'<','&gt;':'>','&nbsp;':' '}[entity];
      });
      overlay.hidden = !lines.length;
    }
    function close() {
      try { if (['PLAYING','PAUSED'].indexOf(api.getState()) >= 0) api.stop(); } catch (ignored) {}
      try { if (api.getState() !== 'NONE') api.close(); } catch (ignored) {}
      ready = 0; paused = true; seeking = false; pendingSeek = null; screenSaver(true);
      if (overlay) { overlay.textContent = ''; overlay.hidden = true; }
    }
    function failed(reason, activeRun) {
      if (activeRun !== run) return;
      error = {code:4}; player.nativeError = String(reason && reason.name || reason || 'AVPlay');
      paused = true; seeking = false; screenSaver(true); emit('error');
    }
    function readInfo() {
      try {
        api.getCurrentStreamInfo().forEach(function (track) {
          if (track.type !== 'VIDEO') return;
          var info = JSON.parse(track.extra_info || '{}');
          width = +(info.Width || info.width) || 0; height = +(info.Height || info.height) || 0;
        });
      } catch (ignored) { /* Older models can omit decoder details; show server plan. */ }
    }
    player.load = function () {
      var activeRun = ++run; close(); now = 0; duration = 0; width = 0; height = 0; error = null;
      if (!source) return;
      try {
        api.open(source);
        api.setDisplayRect(0, 0, 1920, 1080);
        api.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        api.setSilentSubtitle(true);
        api.setListener({
          onbufferingstart:function () { if (activeRun === run) { ready = 2; emit('waiting'); } },
          onbufferingcomplete:function () { if (activeRun === run) ready = 4; },
          oncurrentplaytime:function (milliseconds) {
            if (activeRun !== run) return;
            now = milliseconds / 1000; subtitles(); emit('timeupdate');
          },
          onstreamcompleted:function () {
            if (activeRun !== run) return;
            now = duration; paused = true; subtitles(); screenSaver(true); emit('ended');
          },
          onerror:function (reason) { failed(reason, activeRun); }
        });
        api.prepareAsync(function () {
          if (activeRun !== run) return;
          ready = 4;
          try { duration = api.getDuration() / 1000; } catch (ignored) {}
          emit('loadedmetadata');
        }, function (reason) { failed(reason, activeRun); });
      } catch (reason) { failed(reason, activeRun); }
    };
    player.play = function () {
      try {
        if (ready < 2) return Promise.reject(new Error('AVPlay er ikke klar endnu.'));
        api.play(); paused = false; duration = api.getDuration() / 1000; readInfo(); screenSaver(false);
        // Async prepare's READY state cannot seek on the 2018 API. Start first.
        if (pendingSeek !== null) { var target = pendingSeek; pendingSeek = null; player.currentTime = target; }
        emit('playing'); return Promise.resolve();
      } catch (reason) { failed(reason, run); return Promise.reject(reason); }
    };
    player.pause = function () {
      if (!paused) {
        try { if (api.getState() === 'PLAYING') api.pause(); } catch (ignored) {}
        paused = true; screenSaver(true); emit('pause');
      }
    };
    player.canPlayType = function (type) {
      return /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(type) ? 'probably' : element.canPlayType(type);
    };
    player.removeAttribute = function (name) { if (name === 'src') source = ''; else element.removeAttribute(name); };
    player.nativeBufferUnknown = true;
    player.createSubtitleTrack = function () {
      var track = {track:{mode:'disabled',cues:[]}};
      track.track.removeCue = function (cue) { var i = track.track.cues.indexOf(cue); if (i >= 0) track.track.cues.splice(i, 1); };
      return track;
    };
    player.appendChild = function (track) {
      tracks.push(track);
      var xhr = new XMLHttpRequest(); track.request = xhr; xhr.open('GET', track.src); xhr.timeout = 15000;
      xhr.onload = function () {
        if (tracks.indexOf(track) < 0) return;
        if (xhr.status && xhr.status !== 200) { if (track.onerror) track.onerror(); return; }
        track.track.cues = parseVTT(xhr.responseText);
        if (track.onload) track.onload(); subtitles();
      };
      xhr.onerror = xhr.ontimeout = function () { if (tracks.indexOf(track) >= 0 && track.onerror) track.onerror(); };
      xhr.send(); return track;
    };
    player.querySelectorAll = function (selector) { return selector === 'track' ? tracks.slice() : []; };
    player.removeChild = function (track) {
      var i = tracks.indexOf(track); if (i >= 0) tracks.splice(i, 1);
      if (track.request) track.request.abort(); subtitles(); return track;
    };
    var properties = {
      src:{get:function () { return source; },set:function (value) { source = value; }},
      currentTime:{get:function () { return now; },set:function (seconds) {
        var activeRun = run; seeking = true;
        if (['PLAYING','PAUSED'].indexOf(api.getState()) < 0) { pendingSeek = seconds; return; }
        try {
          api.seekTo(Math.round(Math.max(0, seconds) * 1000), function () {
            if (activeRun !== run) return;
            now = api.getCurrentTime() / 1000; seeking = false; subtitles(); emit('seeked');
          }, function (reason) { failed(reason, activeRun); });
        } catch (reason) { failed(reason, activeRun); }
      }},
      duration:{get:function () { return duration; }}, paused:{get:function () { return paused; }},
      seeking:{get:function () { return seeking; }}, readyState:{get:function () { return ready; }},
      networkState:{get:function () { return ready ? 1 : source ? 2 : 0; }}, error:{get:function () { return error; }},
      videoWidth:{get:function () { return width; }}, videoHeight:{get:function () { return height; }},
      buffered:{get:function () { return {length:0}; }}
    };
    Object.keys(properties).forEach(function (name) { Object.defineProperty(player, name, properties[name]); });
    return player;
  }
  root.SamsungVideo = create;
  if (typeof module !== 'undefined') module.exports = {create:create,parseVTT:parseVTT};
}(typeof window !== 'undefined' ? window : this));
