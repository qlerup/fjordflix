/* Standalone Xbox client. No desktop client or remote scripts. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var movies = [], selected, filter = 'all', page = 0, playback, generation = 0, busy = false;
  var lastSaved = 0, hideTimer, startTimer, cardFocus, video = $('video');
  var planGeneration = 0, selectedAudio = null, selectedSubtitle = null, subtitleURL = null, subtitleXHR = null;
  var server = '', token = '', images = [], imageGeneration = 0, backdropURL;
  var serverFeatures = [], fallbackStage = '', lastRequest, lastFailure = '', lastPlan;
  var runtime = null, streamProgress = null, waitingCount = 0, stalledCount = 0;
  function samplePlayback() {
    if (!playback) return;
    var ahead = 0, now = video.currentTime || 0;
    for (var i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= now && video.buffered.end(i) >= now) ahead = video.buffered.end(i) - now;
    }
    var frames = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    runtime = 'Buffer: ' + ahead.toFixed(1) + ' s · Vent på data: ' + waitingCount +
      ' · Stalled: ' + stalledCount + ' · Tabte billeder: ' + (frames ? frames.droppedVideoFrames + '/' + frames.totalVideoFrames : 'ikke tilgængeligt') +
      ' · readyState: ' + video.readyState + ' · networkState: ' + video.networkState;
  }
  function streamHeartbeat() {
    if (!playback || !playback.session) return;
    var current = playback;
    api('/streams/' + current.session + '/heartbeat', 'POST').then(function (result) {
      if (playback !== current) return;
      streamProgress = result.transcoding || null; diagnostics();
    }).catch(function (e) { if (playback === current) playerError(e.message); });
  }
  function diagnostics() {
    var probe = window.TVCapabilities.diagnostics(), lines = ['FjordFlix Xbox 0.1.10'];
    lines.push(probe.source || '');
    lines.push('HEVC-format: ' + (probe.hevcFormat ? 'inden for grænserne' : 'ikke bekræftet') + ' · Xbox decoder: ' + probe.native + ' · HTML HEVC: ' + (probe.htmlHEVC || '?'));
    lines.push('Server Xbox/fMP4: ' + (serverFeatures.indexOf('xbox-hevc-fmp4') >= 0 ? 'klar' : 'serveropdatering mangler'));
    lines.push('4K HEVC-output: ' + (probe.nativeOutput || 'ikke forespurgt') + ' · Server 4K-konvertering: ' + (serverFeatures.indexOf('xbox-hevc-transcode') >= 0 ? 'klar' : 'serveropdatering mangler'));
    if (lastPlan) lines.push('Plan: ' + lastPlan.mode + ' ' + lastPlan.height + 'p · ' + (lastPlan.reason || ''));
    if (playback) lines.push('Afspiller: ' + playback.mode + ' · ' + (playback.encoder || '') + ' · ' + video.videoWidth + 'x' + video.videoHeight);
    samplePlayback();
    if (runtime) lines.push(runtime);
    if (streamProgress) {
      lines.push('Serverhastighed: ' + (streamProgress.speed === undefined ? 'måles endnu' : streamProgress.speed.toFixed(2) + 'x') +
        ' · Klargjort: ' + (streamProgress.encoded_seconds === undefined ? '?' : streamProgress.encoded_seconds.toFixed(1)) + ' s' + (streamProgress.finished ? ' · færdig' : ''));
      if (!streamProgress.finished && streamProgress.speed !== undefined && streamProgress.speed < 1) lines.push('Serveren konverterer langsommere end afspilningen; bufferen kan løbe tør.');
    }
    if (lastFailure) lines.push('Seneste afspilningsfejl: ' + lastFailure);
    text('playback-diagnostics', lines.join('\n'));
  }
  try { var saved = JSON.parse(localStorage.getItem('fjordflix.connection') || '{}'); server = saved.server || ''; token = saved.token || ''; } catch (e) {}
  function remember() { try { localStorage.setItem('fjordflix.connection', JSON.stringify({server:server, token:token})); } catch (e) {} }
  function text(id, value) { $(id).textContent = value; }
  function message(value) { text('message', value); $('message').hidden = !value; }
  function clock(value) { value = Math.max(0, Math.floor(value || 0)); return Math.floor(value / 60) + ':' + ('0' + value % 60).slice(-2); }
  function ignore() {}
  function api(path, method, data) {
    return new Promise(function (resolve, reject) {
      var requestServer = server, requestToken = token;
      var xhr = new XMLHttpRequest(); xhr.open(method || 'GET', server + '/tv-api' + path); xhr.timeout = 30000;
      if (token && path !== '/login') xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      if (data !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        var result; try { result = JSON.parse(xhr.responseText); } catch (e) { result = {}; }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(result); return; }
        if (xhr.status === 401 && token && token === requestToken && server === requestServer) { token = ''; remember(); showLogin(); }
        if (xhr.status === 404) { reject(new Error('Kontrollér serveradressen, og opdatér FjordFlix-serveren for at bruge TV-login.')); return; }
        reject(new Error(typeof result.detail === 'string' ? result.detail : 'Handlingen mislykkedes (' + xhr.status + ').'));
      };
      xhr.onerror = function () { reject(new Error('Ingen forbindelse til FjordFlix. Kontrollér server og netværk.')); };
      xhr.ontimeout = function () { reject(new Error('Serveren svarede ikke i tide. Prøv igen.')); };
      xhr.send(data === undefined ? null : JSON.stringify(data));
    });
  }
  function artwork(path, apply, valid) {
    var xhr = new XMLHttpRequest(); xhr.open('GET', server + '/tv-api' + path); xhr.timeout = 15000;
    xhr.responseType = 'blob'; xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () { if (xhr.status === 200 && valid()) { var url = URL.createObjectURL(xhr.response); images.push(url); apply(url); } };
    xhr.send();
  }
  function clearImages() { ++imageGeneration; images.forEach(function (url) { URL.revokeObjectURL(url); }); images = []; }
  function showLogin() {
    window.TVPhoneLogin.cancel();
    document.body.classList.add('auth-screen');
    ++generation; busy = false; $('login').hidden = false; release(); $('player').hidden = true;
    $('detail').hidden = true; $('library').hidden = true;
    $('server-address').value = server.replace(/^https?:\/\//i, '');
    $('login-https').checked = !/^http:\/\//i.test(server); $('username').focus();
  }
  function loadLibrary() {
    text('count', 'Henter dit bibliotek…');
    return api('/movies').then(function (items) { movies = items; render(); });
  }
  function boot() {
    message('');
    text('address', server);
    if (!token) { showLogin(); if (!server) $(window.FjordLocalPhoneServer.available() ? 'phone-login' : 'server-address').focus(); return Promise.resolve(); }
    return api('/state').then(function (state) {
      if (!state.user) {
        showLogin();
        text('login-description', state.setup ? 'Opret først server og bruger i FjordFlix fra din computer.' : state.managed ? 'Log ind med din FjordHub-bruger.' : 'Log ind med din FjordFlix-bruger.');
        $('login-submit').disabled = state.setup; return;
      }
      window.TVPhoneLogin.cancel(); document.body.classList.remove('auth-screen'); $('login').hidden = true; $('library').hidden = false;
      return api('/info').then(function (info) { serverFeatures = info.features || []; }, function () { serverFeatures = []; })
        .then(loadLibrary).then(function () { $('search').focus(); });
    }).catch(function (error) { message(error.message); });
  }
  function render() {
    var query = $('search').value.toLowerCase();
    var visible = movies.filter(function (m) {
      return (!query || (m.title + ' ' + ((m.catalog || {}).series_title || '')).toLowerCase().indexOf(query) >= 0) &&
        (filter !== 'movies' || !m.series_key) && (filter !== 'series' || !!m.series_key) &&
        (filter !== 'favorites' || m.favorite) && (filter !== 'continue' || m.position > 1 && m.position < m.duration - 2);
    });
    page = Math.max(0, Math.min(page, Math.ceil(visible.length / 20) - 1)); clearImages(); var imageRun = imageGeneration; $('grid').textContent = '';
    visible.slice(page * 20, (page + 1) * 20).forEach(function (m) {
      var button = document.createElement('button'), poster = document.createElement('div'), img = document.createElement('img');
      var badge = document.createElement('span'), title = document.createElement('strong'), info = document.createElement('small');
      button.className = 'card'; button.setAttribute('data-movie', m.id); poster.className = 'poster'; img.alt = '';
      img.hidden = true;
      artwork('/movies/' + encodeURIComponent(m.id) + '/poster', function (url) { img.src = url; img.hidden = false; }, function () { return imageRun === imageGeneration; });
      badge.textContent = m.height >= 2160 || m.width >= 3840 ? '4K' : (m.height || '') + 'p'; title.textContent = m.title;
      info.textContent = clock(m.duration) + (m.favorite ? ' · På min liste' : '') + (m.position > 1 ? ' · Set ' + clock(m.position) : '');
      poster.appendChild(img); poster.appendChild(badge); button.appendChild(poster); button.appendChild(title); button.appendChild(info);
      button.onclick = function () {
        cardFocus = m.id; openDetail(m);
        api('/movies/' + m.id + '/tracks').then(function (available) {
          if (!available || !Array.isArray(available.subtitles)) return;
          if (selected !== m || $('detail').hidden || !$('player').hidden) return;
          var current = document.activeElement;
          // Refresh newly downloaded subtitles without disturbing an open menu or a selection.
          if (!$('subtitle-options').hidden || current !== $('play')) return;
          m.tracks = available; openDetail(m);
        }).catch(ignore);
      }; $('grid').appendChild(button);
    });
    text('count', visible.length ? visible.length + ' titler i dit bibliotek' : movies.length ? 'Ingen titler matcher. Prøv en anden søgning eller kategori.' : 'Dit bibliotek er tomt. Tilføj film fra FjordFlix på din computer.');
    $('previous').disabled = page === 0; $('next').disabled = (page + 1) * 20 >= visible.length;
    text('page-number', visible.length ? 'Side ' + (page + 1) + ' af ' + Math.ceil(visible.length / 20) : '');
  }
  function focusCard() {
    var cards = $('grid').querySelectorAll('button');
    for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-movie') === cardFocus) { cards[i].focus(); return; }
    $('search').focus();
  }
  function closeSubtitleMenu(restoreFocus) {
    $('subtitle-options').hidden = true;
    $('subtitle-toggle').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('subtitle-toggle').focus();
  }
  $('subtitle-toggle').onclick = function () {
    if (!$('subtitle-options').hidden) { closeSubtitleMenu(true); return; }
    $('subtitle-options').hidden = false;
    $('subtitle-toggle').setAttribute('aria-expanded', 'true');
    var option = $('subtitle-options').querySelector('[aria-selected="true"]') || $('subtitle-options').querySelector('button:not(:disabled)');
    if (option) { option.focus(); if (option.scrollIntoViewIfNeeded) option.scrollIntoViewIfNeeded(false); }
  };
  $('subtitle-dropdown').addEventListener('keydown', function (event) {
    if ($('subtitle-options').hidden) return;
    var key = event.keyCode;
    if ([27,461,37,39,9].indexOf(key) >= 0) {
      event.preventDefault(); event.stopPropagation(); closeSubtitleMenu(true); return;
    }
    if (key !== 38 && key !== 40 && key !== 36 && key !== 35) return;
    event.preventDefault(); event.stopPropagation();
    var options = Array.prototype.filter.call($('subtitle-options').children, function (option) { return !option.disabled; });
    var index = options.indexOf(document.activeElement);
    index = key === 36 ? 0 : key === 35 ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (key === 40 ? 1 : -1)));
    if (options[index]) { options[index].focus(); if (options[index].scrollIntoViewIfNeeded) options[index].scrollIntoViewIfNeeded(false); }
  });
  document.addEventListener('click', function (event) {
    if (!$('subtitle-options').hidden && !$('subtitle-dropdown').contains(event.target)) closeSubtitleMenu(false);
  });
  function openDetail(m) {
    var previousSubtitle = selected === m ? selectedSubtitle : null;
    if (selected !== m) { runtime = null; streamProgress = null; lastFailure = ''; lastPlan = null; $('playback-diagnostics').hidden = true; $('diagnostics-toggle').setAttribute('aria-expanded', 'false'); }
    selected = m; message(''); $('detail').hidden = false;
    text('detail-title', m.title); text('description', (m.catalog || {}).overview || 'Fra dit eget FjordFlix-bibliotek.');
    text('detail-meta', clock(m.duration) + ' · ' + (m.video || '').toUpperCase() + ' · ' + m.height + 'p');
    selectedAudio = null;
    $('audio-options').textContent = '';
    var audioTracks = m.tracks && m.tracks.audio || [], defaultTrack = audioTracks[0];
    audioTracks.forEach(function (track) { if (track.default) defaultTrack = track; });
    if (defaultTrack) selectedAudio = defaultTrack.index;
    audioTracks.forEach(function (track) {
      var button = document.createElement('button');
      button.textContent = (track.language || 'Lyd') + ' - ' + track.codec.toUpperCase() + ' - ' + (track.channels || '?') + ' kanaler';
      button.setAttribute('aria-pressed', String(track.index === selectedAudio));
      button.className = track.index === selectedAudio ? 'active' : '';
      button.onclick = function () {
        selectedAudio = track.index;
        Array.prototype.forEach.call($('audio-options').children, function (b) { b.className = b === button ? 'active' : ''; b.setAttribute('aria-pressed', String(b === button)); });
        updateQualityHint();
      };
      $('audio-options').appendChild(button);
    });
    $('audio-label').hidden = !audioTracks.length;
    selectedSubtitle = null;
    closeSubtitleMenu(false);
    $('subtitle-options').textContent = '';
    var subtitleTracks = m.tracks && m.tracks.subtitles || [];
    subtitleTracks.forEach(function (track) { if (track.index === previousSubtitle) selectedSubtitle = previousSubtitle; });
    [{index:null, language:'Fra'}].concat(subtitleTracks).forEach(function (track) {
      var button = document.createElement('button');
      button.textContent = track.index === null ? 'Fra' : (track.language || 'Ukendt sprog') + (track.title ? ' · ' + track.title : '') + (track.forced ? ' · Tvungne' : '') + (track.hearing_impaired ? ' · Hørehæmmede' : '') + (track.delivery === 'burn' ? ' · Indbrændes' : '');
      button.disabled = track.delivery === 'unsupported';
      button.setAttribute('data-subtitle', track.index === null ? 'off' : String(track.index));
      button.setAttribute('role', 'option'); button.tabIndex = -1;
      button.setAttribute('aria-selected', String(track.index === selectedSubtitle));
      button.setAttribute('aria-pressed', String(track.index === selectedSubtitle));
      button.className = track.index === selectedSubtitle ? 'active' : '';
      if (track.index === selectedSubtitle) text('subtitle-value', button.textContent);
      button.onclick = function () {
        selectedSubtitle = track.index;
        Array.prototype.forEach.call($('subtitle-options').children, function (b) { b.className = b === button ? 'active' : ''; b.setAttribute('aria-pressed', String(b === button)); b.setAttribute('aria-selected', String(b === button)); });
        text('subtitle-value', button.textContent);
        closeSubtitleMenu(true);
        updateQualityHint();
      };
      $('subtitle-options').appendChild(button);
    });
    text('subtitle-hint', subtitleTracks.length ? 'Vælg et spor eller Fra. Billedbaserede spor indbrændes i videoen.' : 'Denne fil har ingen registrerede undertekstspor.');
    var is4K = m.width >= 3840 || m.height >= 2160;
    $('quality-4k').hidden = !is4K;
    text('quality-original', (is4K ? '4K · ' : '') + 'Original (' + m.height + 'p)');
    updateQualityHint();
    $('detail-art').style.backgroundImage = '';
    if (backdropURL) { URL.revokeObjectURL(backdropURL); backdropURL = null; }
    artwork('/movies/' + encodeURIComponent(m.id) + '/backdrop', function (url) { backdropURL = url; $('detail-art').style.backgroundImage = 'url("' + url + '")'; }, function () { return selected === m && !$('detail').hidden; });
    text('play', m.position > 1 && m.position < m.duration - 2 ? '▶ Fortsæt fra ' + clock(m.position) : '▶ Afspil');
    text('favorite', m.favorite ? '✓ På min liste' : '＋ Min liste'); $('restart').hidden = !m.position; $('play').focus();
  }
  function updateQualityHint() {
    text('quality-hint', $('quality').value === 'original' ? 'Bevarer videoen uden genkodning. Dolby Vision med HDR10-basislag kan leveres som HDR10. Vælg 4K, hvis videoen skal konverteres.' : $('quality').value === '2160' || $('quality').value === 'auto' ? 'Bevarer original video når muligt. Ved nødvendig konvertering bevares 4K med HEVC; HDR bliver SDR. Serverens hastighed afgør, om konverteringen kan følge med.' : 'Serveren tilpasser videoen til højst ' + $('quality').value + 'p.');
    if (!selected) return;
    var id = ++planGeneration;
    text('quality-plan', 'Undersøger afspilning…'); text('quality-reason', '');
    var request = window.TVCapabilities(selected, video, $('quality').value, false, {features:serverFeatures}, selectedAudio);
    request.subtitle_track = selectedSubtitle;
    api('/movies/' + selected.id + '/plan', 'POST', request).then(function (plan) {
      if (id !== planGeneration || $('detail').hidden) return;
      lastPlan = plan; diagnostics();
      text('quality-plan', plan.mode + ' · ' + (plan.height >= 2160 || plan.width >= 3840 || plan.mode !== 'Transcoding' && selected.width >= 3840 ? '4K · ' : '') + plan.height + 'p' + (plan.dynamic_range ? ' · ' + plan.dynamic_range : ''));
      text('quality-reason', plan.reason || '');
    }).catch(function (error) {
      if (id !== planGeneration || $('detail').hidden) return;
      text('quality-plan', 'Kunne ikke beregne afspilningen'); text('quality-reason', error.message);
    });
  }
  function playbackStatus() {
    if (!playback) return;
    var height = video.videoHeight || playback.height, width = video.videoWidth;
    text('play-status', playback.mode + ' · ' + (height >= 2160 || width >= 3840 || playback.width >= 3840 ? '4K · ' : '') + height + 'p' + (playback.dynamic_range ? ' · ' + playback.dynamic_range : '') + (fallbackStage === 'remux' ? ' · Video bevaret; indpakning og lyd tilpasset' : fallbackStage === 'transcode' ? ' · Skiftet til kompatibel kvalitet' : ''));
    diagnostics();
  }
  function position() { return Math.min(selected ? selected.duration : 0, (video.currentTime || 0) + (playback ? playback.offset || 0 : 0)); }
  function save() {
    if (!selected || !playback) return Promise.resolve();
    selected.position = position(); return api('/movies/' + selected.id + '/progress', 'POST', {position:selected.position});
  }
  function dispose(old) {
    if (!old) return Promise.resolve(); var tasks = [];
    if (old.session) tasks.push(api('/streams/' + old.session, 'DELETE').catch(ignore));
    if (old.media_ticket) tasks.push(api('/media/revoke', 'POST', {ticket:old.media_ticket}).catch(ignore));
    return Promise.all(tasks);
  }
  function release() {
    samplePlayback();
    clearTimeout(startTimer); var old = playback; playback = null;
    clearSubtitles();
    video.pause(); video.removeAttribute('src'); video.load(); return dispose(old);
  }
  function clearSubtitles() {
    if (subtitleXHR) { subtitleXHR.abort(); subtitleXHR = null; }
    Array.prototype.forEach.call(video.querySelectorAll('track'), function (track) { track.track.mode = 'disabled'; video.removeChild(track); });
    if (subtitleURL) { URL.revokeObjectURL(subtitleURL); subtitleURL = null; }
  }
  function loadSubtitles(movie, result, id) {
    if (selectedSubtitle === null || result.subtitle_delivery !== 'text') return;
    var xhr = new XMLHttpRequest(); subtitleXHR = xhr;
    xhr.open('GET', server + '/tv-api/movies/' + movie.id + '/subtitles/' + selectedSubtitle + '.vtt');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token); xhr.timeout = 90000;
    function failed() { if (id === generation) message('Underteksterne kunne ikke hentes. Opdatér FjordFlix-serveren, eller prøv et andet spor.'); }
    xhr.onerror = failed; xhr.ontimeout = failed;
    xhr.onload = function () {
      if (id !== generation) return;
      subtitleXHR = null;
      if (xhr.status !== 200) { failed(); return; }
      subtitleURL = URL.createObjectURL(new Blob([xhr.responseText], {type:'text/vtt'}));
      var track = document.createElement('track'); track.kind = 'subtitles'; track.label = 'FjordFlix';
      track.src = subtitleURL;
      track.onload = function () {
        if (id !== generation) return;
        var cues = track.track.cues, offset = result.offset || 0;
        if (!cues) { failed(); return; }
        // TextTrackCueList reorders itself when cue times change.
        cues = Array.prototype.slice.call(cues);
        for (var i = cues.length - 1; i >= 0; i--) {
          var cue = cues[i];
          if (cue.endTime <= offset) track.track.removeCue(cue);
          else { cue.startTime = Math.max(0, cue.startTime - offset); cue.endTime -= offset; }
        }
        track.track.mode = 'showing';
      };
      track.onerror = failed; video.appendChild(track); track.track.mode = 'hidden';
    };
    xhr.send();
  }
  function showControls() {
    clearTimeout(hideTimer); $('player-controls').style.opacity = '1';
    if (!video.paused && !busy) hideTimer = setTimeout(function () { $('player-controls').style.opacity = '0'; }, 6000);
  }
  function playerError(value) { clearTimeout(startTimer); busy = false; showControls(); message(value); text('play-status', 'Afspilning afbrudt'); }
  function playVideo() {
    var promise = video.play(); if (promise && promise.catch) promise.catch(function () { showControls(); text('play-status', 'Tryk OK på Pause / afspil for at starte.'); });
  }
  function start(at, force) {
    if (busy) return;
    busy = true; fallbackStage = force === 'remux' ? 'remux' : force ? 'transcode' : '';
    if (!force) lastFailure = '';
    var id = ++generation, movie = selected;
    $('player').hidden = false; $('detail').hidden = true; message(''); text('player-title', movie.title); text('play-status', 'Gør filmen klar…');
    $('toggle').focus(); showControls();
    release().then(function () {
      if (id !== generation) return null;
      var request = window.TVCapabilities(movie, video, $('quality').value, force, {features:serverFeatures}, selectedAudio); request.start = at;
      request.subtitle_track = selectedSubtitle;
      lastRequest = request;
      return api('/movies/' + movie.id + '/plan', 'POST', request).then(function (plan) {
        if (id !== generation) return null;
        lastPlan = plan; diagnostics();
        var wants4K = ($('quality').value === '2160' || $('quality').value === 'auto') && (movie.width > 1920 || movie.height > 1080);
        if (plan.mode === 'Transcoding' && request.quality === 'original') {
          throw new Error('Original video kunne ikke bevares. ' + (plan.reason || '') + ' Vælg tekstundertekster/Fra eller 1080p for konvertering.');
        }
        if (plan.mode === 'Transcoding' && wants4K && (!request.hevc_output || plan.video_codec !== 'hevc')) {
          throw new Error('4K kunne ikke leveres. Opdater FjordFlix-serveren, og kontrollér 4K HEVC-output under Afspilningsdetaljer. Videoen sænkes ikke til 1080p.');
        }
        if (plan.mode === 'Direct Stream' && movie.video === 'hevc' && serverFeatures.indexOf('xbox-hevc-fmp4') < 0) {
          throw new Error('FjordFlix-serveren skal opdateres til Xbox/fMP4 for at bevare denne HEVC-video. Opdater både server og app.');
        }
        return api('/movies/' + movie.id + '/play', 'POST', request);
      });
    }).then(function (result) {
      if (!result) return;
      if (id !== generation) { dispose(result); return; }
      var wants4K = ($('quality').value === '2160' || $('quality').value === 'auto') && (movie.width > 1920 || movie.height > 1080);
      if (result.mode === 'Transcoding' && (lastRequest.quality === 'original' || wants4K && (!lastRequest.hevc_output || result.video_codec !== 'hevc'))) {
        dispose(result); throw new Error('Serveren forsøgte videokonvertering ved Original. Opdater serveren, eller vælg 1080p.');
      }
      runtime = null; streamProgress = null; waitingCount = 0; stalledCount = 0;
      playback = result; playbackStatus(); streamHeartbeat();
      video.onloadedmetadata = function () { if (id !== generation) return; playbackStatus(); if (!result.session && at) video.currentTime = at; playVideo(); };
      if (result.session && !video.canPlayType('application/vnd.apple.mpegurl')) {
        playerError('Denne browser mangler native HLS. Test konverteret video i Xbox-appen.'); release(); return;
      }
      video.src = result.url; video.load();
      loadSubtitles(movie, result, id);
      startTimer = setTimeout(function () { if (id === generation) recover('Videoen kom ikke i gang.'); }, 25000);
    }).catch(function (error) { if (id === generation) playerError(error.message); }).then(function () { if (id === generation) busy = false; });
  }
  function recover(reason) {
    if (!playback || $('player').hidden) return;
    var at = position();
    lastFailure = reason + (video.error ? ' (mediefejl ' + video.error.code + ')' : ''); diagnostics();
    if (!fallbackStage && lastRequest && lastRequest.video_copy && (playback.mode === 'Direct Play' || playback.mode === 'Direct Stream' && lastRequest.audio_copy)) {
      busy = false; start(at, 'remux');
    } else if (fallbackStage !== 'transcode' && playback.mode !== 'Transcoding' && $('quality').value !== 'original') {
      busy = false; start(at, true);
    } else { playerError(lastFailure + (playback.mode === 'Transcoding' ? ' Den konverterede video kunne ikke afspilles. Se Afspilningsdetaljer.' : ' Original video kunne ikke afspilles. Vælg 1080p for konvertering, eller se Afspilningsdetaljer.')); release(); }
  }
  function closePlayer() {
    ++generation; busy = false; save().catch(function (e) { message(e.message); });
    release(); $('player').hidden = true;
    if (!$('library').hidden) { openDetail(selected); render(); }
  }
  function seek(delta) {
    if (!playback || busy) return;
    var at = Math.max(0, Math.min(selected.duration - 1, position() + delta));
    if (playback.session) start(at, fallbackStage === 'remux' ? 'remux' : fallbackStage === 'transcode'); else video.currentTime = at; showControls();
  }
  $('login-form').onsubmit = function (event) {
    window.TVPhoneLogin.cancel();
    event.preventDefault(); message(''); $('login-submit').disabled = true; $('phone-login').disabled = true;
    try { server = window.FjordServerURL($('server-address').value, $('login-https').checked); } catch (e) { message(e.message); $('login-submit').disabled = false; $('phone-login').disabled = false; return; }
    token = ''; remember();
    api('/login', 'POST', {name:$('username').value, password:$('password').value}).then(function (result) { token = result.token; remember(); $('password').value = ''; return boot(); })
      .catch(function (e) { message(e.message); }).then(function () { $('login-submit').disabled = false; $('phone-login').disabled = false; });
  };
  window.TVPhoneLogin.setup(function (value, address) {
    server = address; token = value; remember(); $('password').value = ''; boot();
  });
  $('phone-login').onclick = function () {
    message('');
    if (window.FjordLocalPhoneServer.available()) { window.TVPhoneLogin.start(); return; }
    try { server = window.FjordServerURL($('server-address').value, $('login-https').checked); }
    catch (error) { message(error.message); $('server-address').focus(); return; }
    token = ''; remember(); window.TVPhoneLogin.start(server);
  };
  $('logout').onclick = function () { api('/logout', 'POST').then(function () { token = ''; remember(); movies = []; clearImages(); $('grid').textContent = ''; showLogin(); }).catch(function (e) { message(e.message); }); };
  $('refresh').onclick = function () { message(''); loadLibrary().catch(function (e) { message(e.message); }); };
  $('diagnostics-toggle').onclick = function () { var panel = $('playback-diagnostics'); panel.hidden = !panel.hidden; this.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) panel.scrollIntoView(false); };
  $('search').oninput = function () { page = 0; render(); };
  Array.prototype.forEach.call(document.querySelectorAll('[data-quality]'), function (button) {
    button.onclick = function () {
      $('quality').value = button.getAttribute('data-quality');
      Array.prototype.forEach.call(document.querySelectorAll('[data-quality]'), function (b) { b.className = b === button ? 'active' : ''; b.setAttribute('aria-pressed', b === button ? 'true' : 'false'); });
      updateQualityHint();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (button) {
    button.onclick = function () { filter = button.getAttribute('data-filter'); page = 0;
      Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) { b.className = b === button ? 'active' : ''; }); render(); };
  });
  function changePage(delta) { page += delta; render(); var first = $('grid').querySelector('button'); if (first) first.focus(); }
  $('previous').onclick = function () { changePage(-1); }; $('next').onclick = function () { changePage(1); };
  $('detail-back').onclick = function () { $('detail').hidden = true; message(''); focusCard(); };
  $('favorite').onclick = function () {
    $('favorite').disabled = true;
    api('/movies/' + selected.id + '/favorite', 'POST').then(function () { selected.favorite = !selected.favorite; text('favorite', selected.favorite ? '✓ På min liste' : '＋ Min liste'); render(); })
      .catch(function (e) { message(e.message); }).then(function () { $('favorite').disabled = false; $('favorite').focus(); });
  };
  $('play').onclick = function () { start(selected.position < selected.duration - 2 ? selected.position : 0, false); };
  $('restart').onclick = function () { start(0, false); };
  $('stop').onclick = closePlayer;
  $('toggle').onclick = function () { if (!playback || busy) return; if (video.paused) playVideo(); else video.pause(); showControls(); };
  $('rewind').onclick = function () { seek(-30); }; $('forward').onclick = function () { seek(30); };
  video.onplaying = function () { clearTimeout(startTimer); message(''); playbackStatus(); showControls(); };
  video.onpause = showControls;
  video.onwaiting = function () { if (playback && !busy) { waitingCount++; text('play-status', 'Bufferer…'); diagnostics(); } };
  video.onstalled = function () { if (playback && !busy) { stalledCount++; diagnostics(); } };
  video.onerror = function () { if (!busy) recover('TV’et kunne ikke afspille formatet.'); };
  video.ontimeupdate = function () {
    text('timeline', clock(position()) + ' / ' + clock(selected ? selected.duration : 0));
    if (playback && Date.now() - lastSaved > 10000) { lastSaved = Date.now(); save().catch(function (e) { message(e.message); }); }
  };
  video.onended = function () { save().catch(ignore); showControls(); };
  $('player').onmousemove = showControls;
  window.TVNavigation.activity = function () { if (!$('player').hidden) showControls(); };
  window.TVNavigation.back = function () {
    if (window.TVPhoneLogin.active()) { window.TVPhoneLogin.cancel(); $('phone-login').focus(); }
    else if (!$('player').hidden) closePlayer();
    else if (!$('detail').hidden) $('detail-back').click();
    else if ($('search').value) { $('search').value = ''; page = 0; render(); $('search').focus(); }
    else window.XboxPlatform.requestExit();
  };
  document.addEventListener('keydown', function (event) {
    if ($('player').hidden) return;
    if ([415,19,413,417,412].indexOf(event.keyCode) >= 0) event.preventDefault();
    if (event.keyCode === 415) playVideo(); if (event.keyCode === 19) video.pause();
    if (event.keyCode === 413) closePlayer(); if (event.keyCode === 417) seek(30); if (event.keyCode === 412) seek(-30);
  });
  setInterval(function () {
    if (!playback) return;
    diagnostics(); streamHeartbeat();
    if (playback.media_ticket) api('/media/heartbeat', 'POST', {ticket:playback.media_ticket}).catch(function (e) { playerError(e.message); });
  }, 10000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && playback) { save().catch(ignore); video.pause(); } });
  window.addEventListener('pagehide', function () { window.TVPhoneLogin.cancel(); save().catch(ignore); release(); });
  $('server').onclick = function () {
    if (token) { api('/logout', 'POST').catch(ignore); }
    token = ''; remember(); movies = []; clearImages(); $('grid').textContent = ''; showLogin(); $('server-address').focus();
  };
  window.XboxPlatform.suspend = function () {
    ++generation; busy = false; video.pause();
    var pendingSave = save().catch(ignore), pendingRelease = release();
    $('player').hidden = true;
    if (selected) { $('detail').hidden = false; $('play').focus(); }
    return Promise.all([pendingSave, pendingRelease, window.TVPhoneLogin.cancel()]);
  };
  window.TVCapabilities.init().then(boot);
}());
