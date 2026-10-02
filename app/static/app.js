const $ = (id) => document.getElementById(id);
if (window.fjordDesktop) {
  $('desktop-download').hidden = true;
  if (window.fjordDesktop.checkUpdates) {
    const update = document.createElement('button');
    update.className = 'secondary small'; update.textContent = 'Søg efter opdateringer';
    update.onclick = () => window.fjordDesktop.checkUpdates().catch(e => toast(e.message));
    $('desktop-download').after(update);
  }
}
let state, library = [], selected, view = 'home', authMode = 'login', hls, playback, lastSaved = 0, switching = false, playGeneration = 0, planGeneration = 0;
const video = $('video');
const airplaySupported = typeof video.webkitShowPlaybackTargetPicker === 'function' && !!video.canPlayType('application/vnd.apple.mpegurl');
function airplayActive() { return !!video.webkitCurrentPlaybackTargetIsWireless; }
let hlsLibraryPromise;
function loadHlsLibrary() {
  if (window.Hls) return Promise.resolve();
  if (hlsLibraryPromise) return hlsLibraryPromise;
  hlsLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/static/vendor/hls.min.js';
    const timer = setTimeout(() => fail(), 15000);
    function fail() {
      clearTimeout(timer); script.remove(); hlsLibraryPromise = null;
      reject(new Error('Afspilleren kunne ikke indlæses. Prøv at starte filmen igen.'));
    }
    script.onload = () => { clearTimeout(timer); window.Hls ? resolve() : fail(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return hlsLibraryPromise;
}
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = (seconds) => { const s = Math.floor(seconds || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api${path}`, {method, headers: data === undefined ? {} : {'Content-Type':'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401 && state?.user) { state.user = null; await closePlayer(); showAuth(); } throw new Error(typeof result.detail === 'string' ? result.detail : 'Kontrollér oplysningerne, og prøv igen.'); }
  return result;
}
function badge(id, mode) { $(id).textContent = mode; $(id).className = `badge ${mode === 'Transcoding' ? 'transcode' : mode === 'Direct Stream' ? 'remux' : ''}`; }
function showAuth() {
  window.FjordOnboarding?.close();
  $('shell').hidden = true; $('auth').hidden = false;
  if (state.managed) authMode = 'login';
  else if (state.setup) authMode = 'setup';
  const setup = authMode === 'setup', register = authMode === 'register';
  $('auth-kicker').textContent = setup ? 'FØRSTE GANG · DIN ADMINISTRATOR' : register ? 'GØR DIG KLAR TIL FILMAFTEN' : 'GODT AT SE DIG IGEN';
  $('auth-title').textContent = setup ? 'Velkommen hjem.' : register ? 'Opret din bruger' : 'Log ind';
  $('auth-description').textContent = setup ? 'Gør FjordFlix til din egen. Opret serverens administrator, og tilføj derefter dine film.' : register ? 'Brug invitationen fra din administrator for at få adgang til biblioteket.' : 'Dit bibliotek og din næste film venter på dig.';
  $('auth-submit').textContent = setup ? 'Opret administrator →' : register ? 'Opret bruger →' : 'Log ind →';
  $('password').autocomplete = setup || register ? 'new-password' : 'current-password';
  $('invite-field').hidden = !register; $('invite').required = register;
  $('auth-switch').hidden = setup;
  if(state.managed) {
    $('auth-kicker').textContent = 'FORBUNDET TIL FJORDHUB';
    $('auth-description').textContent = 'Log ind med din FjordHub-bruger, eller åbn appen fra FjordHub. Brugere og adgang administreres i FjordHub.';
    $('auth-switch').hidden = true;
  }
  $('password').minLength = authMode === 'login' ? 1 : 10;
  $('password').placeholder = authMode === 'login' ? 'Din adgangskode' : 'Mindst 10 tegn';
  $('username').minLength = authMode === 'login' ? 1 : 2;
  $('username').maxLength = authMode === 'login' ? 128 : 40;
  $('auth-switch').textContent = register ? 'Har du allerede en bruger? Log ind' : 'Har du en invitation? Opret bruger';
}
$('auth-switch').onclick = () => { authMode = authMode === 'register' ? 'login' : 'register'; $('auth-error').textContent = ''; showAuth(); };
$('auth-form').onsubmit = async (event) => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-error').textContent = '';
  try { await api(`/${authMode}`, 'POST', {name: $('username').value, password: $('password').value, invite: $('invite').value.trim()}); $('password').value = ''; await boot(); }
  catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
};
async function boot() {
  state = await api('/state');
  if (!state.user) { showAuth(); return; }
  $('auth').hidden = true; $('shell').hidden = false;
  if (window.fjordDesktop) {
    updateWindowButton(true);
    window.fjordDesktop.getFullscreen?.().then(updateWindowButton).catch(() => {});
  } else {
    $('logout').textContent = state.user.name[0].toUpperCase(); $('logout').title = `${state.user.name} · Log ud`;
    $('logout').setAttribute('aria-label', 'Log ud');
  }
  ['admin-open','upload-open'].forEach(id => $(id).hidden = !state.user.admin);
  $('create-invite').hidden = state.managed;
  $('invite-result').hidden = true;
  let userNote = $('hub-user-note');
  if(!userNote) {userNote=document.createElement('p');userNote.id='hub-user-note';userNote.className='muted';$('users-list').before(userNote);}
  userNote.hidden = !state.managed;
  userNote.textContent = 'Konti, adgangskoder og roller styres i FjordHub → Brugere. Listen viser de brugere, der har adgang til FjordFlix.';
  await refresh();
  if (state.user.admin && window.FjordOnboarding) await window.FjordOnboarding.open();
}
async function refresh() { library = await api('/movies'); render(); }
function render() {
  const query = $('search').value.toLocaleLowerCase('da');
  const cards = FjordLibrary.cards(library);
  const matching = cards.filter(m => FjordLibrary.matches(m, query) && (view !== 'favorites' || m.favorite)
    && (view !== 'series' || m.isSeries) && (view !== 'all' || !m.isSeries));
  const category = renderCategories(matching, cards.filter(m => view === 'favorites' ? m.favorite : view === 'series' ? m.isSeries : !m.isSeries)), visible = category.items;
  const heading = view === 'series' ? 'Serier' : view === 'all' ? 'Film' : view === 'favorites' ? 'Min liste' : 'Dit bibliotek';
  $('library-title').innerHTML = `${query ? 'Søgeresultater' : heading}${category.label ? ` · ${escapeHtml(category.label)}` : ''} <span>${visible.length}</span>`;
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h3').textContent = query ? 'Ingen film matcher søgningen' : view === 'favorites' ? 'Din liste venter på favoritter' : 'Her begynder samlingen';
  $('empty').querySelector('p').textContent = query ? 'Prøv en anden filmtitel.' : view === 'favorites' ? 'Åbn en film, og tryk på Min liste for at gemme den her.' : state.user.admin ? 'Upload din første film, eller tilføj en mappe under Indstillinger.' : 'Din administrator kan tilføje film til det fælles bibliotek.';
  fillGrid('movie-grid', visible);
  if (!visible.length && category.label) {
    $('empty').querySelector('h3').textContent = `Ingen titler i ${category.label}`;
    $('empty').querySelector('p').textContent = query ? 'Prøv en anden søgning eller kategori.' : 'Vælg en anden kategori eller Alle for at se resten af biblioteket.';
  }
  const continuing = library.filter(m => m.position > 1 && m.position < m.duration - 2);
  $('continue-section').hidden = view !== 'home' || !!query || !continuing.length;
  fillGrid('continue-grid', continuing);
  $('hero').hidden = view !== 'home' || !!query;
  const featured = cards[0];
  $('hero').querySelector('h1').textContent = featured ? featured.title : 'Din næste filmaften starter her.';
  $('hero').querySelector('.hero-content>p').textContent = featured ? `${featured.height >= 2160 ? '4K Ultra HD' : featured.height + 'p'} · ${featured.video.toUpperCase()} · ${clock(featured.duration)} — Fra dit eget bibliotek. Tryk afspil, og find dig til rette.` : 'Gør plads til de store fortællinger. Tilføj din første film, og gør biblioteket til dit eget.';
  const summary = featured?.isSeries ? featured.catalog.series_overview : featured?.catalog?.overview;
  if (summary) $('hero').querySelector('.hero-content>p').textContent = summary;
  $('hero').querySelector('.hero-art').style.backgroundImage = featured ? `url('${FjordLibrary.artwork(featured, 'backdrop')}')` : '';
  $('hero').querySelector('.orb').hidden = !!featured;
  $('hero-action').textContent = featured ? featured.isSeries ? '☷ Se afsnit' : '▶ Se filmen' : '＋ Tilføj din første film';
  $('hero-action').hidden = !featured && !state.user.admin;
  $('hero-action').onclick = () => featured ? openDetail(featured) : $('upload-dialog').showModal();
}
function fillGrid(id, movies) {
  $(id).innerHTML = movies.map(m => {
    const quality = FjordLibrary.qualityBadges(m);
    const resolution = quality.labels.find(label => /^(?:\d+p|[48]K)$/.test(label));
    const details = quality.labels.filter(label => label !== resolution);
    return `<button class="movie-card${m.isSeries ? ' series-card' : ''}" data-id="${m.id}"><div class="movie-image"><img src="${FjordLibrary.artwork(m, 'poster')}" alt="" loading="lazy">${resolution ? `<span class="quality-badges"><span class="quality-badge">${escapeHtml(resolution)}</span></span>` : ''}<span class="card-play">${m.isSeries ? '☷' : '▶'}</span></div>${m.position && !m.isSeries ? `<div class="progress-bar"><div style="width:${Math.min(100,m.position/m.duration*100)}%"></div></div>` : ''}<h3>${escapeHtml(m.title)}</h3>${details.length ? `<p class="card-quality" title="${escapeHtml(quality.description)}">${details.map(escapeHtml).join(' &middot; ')}</p>` : ''}<p>${m.isSeries ? `${m.seasonCount} sæsoner · ${m.episodes.length} afsnit` : `${clock(m.duration)} · ${escapeHtml(m.video.toUpperCase())}`} ${m.favorite ? '&nbsp;·&nbsp; ♥' : ''}</p></button>`;
  }).join('');
  $(id).querySelectorAll('[data-id]').forEach(button => {
    button.onclick = () => openDetail(movies.find(m => m.id === button.dataset.id));
    const image = button.querySelector('.movie-image img');
    const updatePosterFormat = () => button.classList.toggle('poster-card', image.naturalHeight > image.naturalWidth);
    image.addEventListener('load', updatePosterFormat);
    if (image.complete) updatePosterFormat();
  });
}
setupLibraryUI();
setupCategories();
FjordTracks.setup();
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button)); render(); });
$('search').oninput = render;
function updateWindowButton(fullscreen) {
  const button = $('logout');
  button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${fullscreen ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6'}"/></svg>`;
  button.title = fullscreen ? 'Skift til vindue · F11' : 'Skift til fuldskærm · F11';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(fullscreen));
}
window.fjordDesktop?.onFullscreen?.(updateWindowButton);
$('logout').onclick = async () => {
  try {
    if (window.fjordDesktop) {
      if (!window.fjordDesktop.toggleFullscreen) { toast('Opdatér Windows-appen for at bruge knappen. F11 skifter også fuldskærm.'); return; }
      updateWindowButton(await window.fjordDesktop.toggleFullscreen());
      return;
    }
    await api('/logout', 'POST'); authMode = 'login'; await boot();
  } catch(e) { toast(e.message); }
};
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());

async function capabilities(movie, quality) {
  const mime = movie.format.includes('webm') ? 'video/webm' : 'video/mp4';
  const codecs = {h264: 'avc1.640033', hevc:'hvc1.1.6.L153.B0', av1:'av01.0.13M.08', vp9:'vp09.00.51.08', vp8:'vp8'};
  const details = movie.quality || {};
  const tenBit = movie.pix_fmt === 'yuv420p10le';
  const hevcProfile = movie.video === 'hevc' && ['yuv420p', 'yuv420p10le'].includes(movie.pix_fmt);
  const level = Number(details.video_level) || 153;
  const codec = hevcProfile ? `hvc1.${tenBit ? '2.4' : '1.6'}.L${level}.B0` : codecs[movie.video];
  const frameRateParts = String(details.frame_rate || '24').split('/').map(Number);
  const frameRate = frameRateParts[0] / (frameRateParts[1] || 1) || 24;
  let supported = !!codec && !!video.canPlayType(`${mime}; codecs="${codec}"`);
  const allowedContainer = mime === 'video/webm' || movie.format.includes('mp4');
  const audioType = movie.audio === 'aac' ? 'audio/mp4; codecs="mp4a.40.2"' : movie.audio === 'opus' ? 'audio/webm; codecs="opus"' : movie.audio === 'mp3' ? 'audio/mpeg' : null;
  const audioSupported = !movie.audio || !!audioType && !!video.canPlayType(audioType);
  if (navigator.mediaCapabilities && supported) {
    try { const info = await navigator.mediaCapabilities.decodingInfo({type:'file', video:{contentType:`${mime}; codecs="${codec}"`, width:movie.width, height:movie.height, bitrate:movie.bitrate || 8000000, framerate:24}}); supported = info.supported; } catch { supported = false; }
  }
  if (movie.video === 'h264' && movie.pix_fmt !== 'yuv420p') supported = false;
  // Probe the MSE route separately: an MKV container is not directly playable,
  // but hls.js can remux supported HEVC without re-encoding the video.
  let videoCopy = false;
  const mse = typeof MediaSource !== 'undefined' ? MediaSource : null;
  const dynamicRange = details.dynamic_range;
  const hdrAllowed = !movie.hdr || (['HDR10', 'HDR10+', 'HLG'].includes(dynamicRange)
    && typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches);
  if (hevcProfile && hdrAllowed && !airplaySupported && !video.canPlayType('application/vnd.apple.mpegurl')
      && mse?.isTypeSupported(`video/mp4; codecs="${codec}"`) && navigator.mediaCapabilities) {
    try {
      const config = {contentType:`video/mp4; codecs="${codec}"`, width:movie.width, height:movie.height,
        bitrate:movie.bitrate || 8000000, framerate:frameRate};
      if (movie.hdr) Object.assign(config, {colorGamut:'rec2020', transferFunction:dynamicRange === 'HLG' ? 'hlg' : 'pq'});
      const decoded = await navigator.mediaCapabilities.decodingInfo({type:'media-source', video:config});
      videoCopy = decoded.supported && decoded.smooth;
    } catch { videoCopy = false; }
  }
  // HDR direct-file playback remains conservative; the MSE route is checked above.
  if (movie.hdr) supported = false;
  // NetworkInformation estimates unrelated connections (and excludes private
  // address space). It is not a measurement of throughput to our media server.
  // Leave bandwidth unknown rather than forcing unnecessary transcoding in Auto.
  const capabilityReason = movie.video === 'hevc' && !videoCopy && !supported
    ? (movie.hdr ? 'Browseren kunne ikke bekræfte understøttelse af filmens HEVC/HDR-format.' : 'Browseren kunne ikke bekræfte flydende HEVC-afspilning.') : '';
  return {quality, airplay:airplaySupported, direct:supported && allowedContainer && audioSupported, video_copy:videoCopy,
    capability_reason:capabilityReason, h264:!!video.canPlayType('video/mp4; codecs="avc1.640028"'), bandwidth:0, ...FjordTracks.request()};
}
async function openDetail(movie) {
  if (movie?.isSeries) movie = FjordLibrary.initial(movie.episodes);
  if (!movie) return;
  for (const id of ['detail-quality', 'player-quality']) {
    const option = $(id).querySelector('[value="2160"]');
    option.hidden = option.disabled = !(movie.width >= 3840 || movie.height >= 2160);
  }
  selected = movie; $('detail-title').textContent = movie.title;
  $('subtitle-find').hidden = !state.user?.admin;
  $('detail-art').style.backgroundImage = `url('${FjordLibrary.artwork(movie, 'backdrop')}')`;
  $('detail-meta').innerHTML = [`${movie.width} × ${movie.height}`,movie.video.toUpperCase(),movie.hdr ? 'HDR' : 'SDR',clock(movie.duration)].map(t => `<span>${escapeHtml(t)}</span>`).join('');
  $('detail-description').textContent = `${(movie.size / 1024**3).toFixed(2)} GB · ${(movie.bitrate/1e6).toFixed(1)} Mbit/s · ${movie.audio?.toUpperCase() || 'Uden lyd'}. En film fra dit fælles bibliotek.`;
  $('detail-quality').value = 'auto'; $('favorite-button').textContent = movie.favorite ? '✓ På min liste' : '＋ Min liste';
  const info = movie.catalog;
  if (info?.status === 'matched' || info?.manual) {
    if (info.overview || info.manual) $('detail-description').textContent = info.overview || '';
    const labels = [info.release_date?.slice(0,4), ...(info.genres || [])];
    if (info.rating != null && (info.votes > 0 || info.manual)) labels.push(`${info.manual ? 'Rating' : 'TMDB'} ${Number(info.rating).toFixed(1)}/10`);
    $('detail-meta').insertAdjacentHTML('afterbegin', labels.filter(Boolean).map(t => `<span>${escapeHtml(t)}</span>`).join(''));
  }
  showEpisodePicker(movie);
  $('play-button').textContent = movie.position > 1 && movie.position < movie.duration - 2 ? `▶ Fortsæt fra ${clock(movie.position)}` : movie.series_key ? '▶ Afspil afsnit' : '▶ Afspil film';
  $('restart-button').hidden = !(movie.position > 1 && movie.position < movie.duration - 2);
  if (!$('detail').open) $('detail').showModal();
  await FjordTracks.prepare(movie);
  if (selected === movie) await updatePlan();
}
async function updatePlan() {
  const generation = ++planGeneration;
  if (window.fjordDesktop) {
    badge('plan-badge', 'Direct Play');
    $('plan-reason').textContent = 'Originalfilen afspilles på din pc med mpv. Ingen server-transcoding.';
    $('detail-quality').value = 'original'; $('detail-quality').disabled = true;
    return;
  }
  try { const movie = selected; const p = await api(`/movies/${movie.id}/plan`, 'POST', await capabilities(movie, $('detail-quality').value)); if (movie !== selected || generation !== planGeneration) return; badge('plan-badge', p.mode); $('plan-reason').textContent = `${p.height}p · ${p.mbps} Mbit/s. ${p.reason}`; } catch(e) { toast(e.message); }
}
$('detail-quality').onchange = updatePlan;
$('favorite-button').onclick = async () => { try { await api(`/movies/${selected.id}/favorite`, 'POST'); selected.favorite = !selected.favorite; $('favorite-button').textContent = selected.favorite ? '✓ På min liste' : '＋ Min liste'; await refresh(); } catch(e) { toast(e.message); } };
function playFromDetail(start) {
  if (window.fjordDesktop) {
    window.fjordDesktop.play({id:selected.id,start,audio_track:FjordTracks.audio,subtitle_track:FjordTracks.subtitle})
      .then(() => { $('detail').close(); toast('Afspiller originalfilen i FjordFlix til Windows.'); })
      .catch(e => toast(e.message));
    return;
  }
  document.activeElement?.blur(); $('detail').close(); $('player-dialog').showModal(); fitPlayerViewport(); $('player-quality').value = $('detail-quality').value; startPlayback(start).catch(e => showPlayerError(e.message));
}
window.fjordDesktop?.onEnded(() => refresh().catch(() => {}));
$('play-button').onclick = () => playFromDetail(selected.position < selected.duration - 2 ? selected.position : 0);
$('restart-button').onclick = () => playFromDetail(0);
function showPlayerError(message) { $('player-error').textContent = message; $('player-loading').hidden = true; }
async function release() {
  FjordTracks.clear();
  video.pause(); video.removeAttribute('src'); video.load();
  if (hls) { hls.destroy(); hls = null; }
  const old = playback; playback = null;
  if (old?.playback_id) await api(`/playbacks/${old.playback_id}/stop`, 'POST').catch(() => {});
  if (old?.media_ticket) await api('/media/revoke', 'POST', {ticket:old.media_ticket}).catch(() => {});
  if (old?.session) await api(`/streams/${old.session}`, 'DELETE').catch(() => {});
}
async function startPlayback(position = 0, fallback = false) {
  const generation = ++playGeneration; switching = true;
  await release();
  $('player-title').textContent = selected.title; $('player-error').textContent = ''; $('player-loading').textContent = 'Gør filmen klar…'; $('player-loading').hidden = false;
  badge('actual-badge', 'Forbereder'); $('playback-info').textContent = '';
  $('timeline').max = selected.duration;
  try {
    if (!video.canPlayType('application/vnd.apple.mpegurl')) await loadHlsLibrary();
    if (generation !== playGeneration || !$('player-dialog').open) return;
    const data = await capabilities(selected, $('player-quality').value);
    if (fallback) { data.direct = false; data.h264 = false; data.video_copy = false; }
    const result = await api(`/movies/${selected.id}/play`, 'POST', {...data, start:position});
    if (generation !== playGeneration || !$('player-dialog').open) { if(result.playback_id) await api(`/playbacks/${result.playback_id}/stop`, 'POST'); if(result.session) await api(`/streams/${result.session}`, 'DELETE'); return; }
    playback = result; lastSaved = 0;
    if(result.delivery === 'direct') video.crossOrigin = 'anonymous'; else video.removeAttribute('crossorigin');
    $('playback-info').textContent = `${selected.height}p → ${result.height}p · ${result.mbps} Mbit/s · ${result.encoder}${result.delivery === 'direct' ? ' · Direkte forbindelse' : ''}${result.airplay ? ' · AirPlay-klar' : ''}`;
    video.onloadedmetadata = () => { if (result.mode === 'Direct Play') video.currentTime = position; else if (result.initial_time) video.currentTime = result.initial_time; video.play().catch(() => { $('player-loading').hidden = true; toast('Tryk på afspil for at starte filmen.'); }); };
    if (!result.session || video.canPlayType('application/vnd.apple.mpegurl')) { video.src = result.url; }
    else if (window.Hls?.isSupported()) {
      hls = new Hls({startPosition:0, maxBufferLength:30, backBufferLength:30});
      hls.loadSource(result.url); hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, info) => {
        if (!info.fatal || generation !== playGeneration) return;
        if (!fallback && result.mode === 'Direct Stream' && data.video_copy && info.type === Hls.ErrorTypes.MEDIA_ERROR) {
          startPlayback(position + (video.currentTime || 0), true).catch(e => showPlayerError(e.message));
        } else showPlayerError('Streamen blev afbrudt. Vælg kvalitet igen for at genstarte.');
      });
    }
    else { showPlayerError('Denne browser understøtter ikke HLS. Prøv en nyere browser.'); }
    FjordTracks.attach(result).catch(e => { if (e.name !== 'AbortError' && generation === playGeneration) toast(e.message); });
  } finally { switching = false; }
}
video.onplaying = () => { $('player-loading').hidden = true; if(playback) badge('actual-badge', playback.mode); };
video.onwaiting = () => { if(playback) { $('player-loading').hidden = false; $('player-loading').textContent = 'Bufferer…'; } };
video.onerror = () => { if(switching || !playback) return; if(playback.mode === 'Direct Play') { toast('Originalformatet kunne ikke afspilles. Prøver transcoding.'); startPlayback(video.currentTime || 0, true).catch(e => showPlayerError(e.message)); } else showPlayerError('Videoen kunne ikke afspilles. Prøv en anden kvalitet.'); };
function position() { return Math.min(selected?.duration || 0, (video.currentTime || 0) + (playback?.offset || 0)); }
function reportPresence() {
  if (!playback?.playback_id) return;
  const status = video.ended ? 'ended' : video.error ? 'error' : video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing';
  api(`/playbacks/${playback.playback_id}/heartbeat`, 'POST', {position:position(), state:status, subtitle_track:playback.subtitle_track ?? null}).catch(() => {});
}
for (const event of ['playing','pause','waiting','ended','error']) video.addEventListener(event, reportPresence);
setInterval(reportPresence, 10000);
window.addEventListener('pagehide', () => {
  if (playback?.playback_id && !airplayActive()) fetch(`/api/playbacks/${playback.playback_id}/stop`, {method:'POST',keepalive:true});
});
async function saveProgress() { if(!selected || !playback) return; const p = position(); selected.position = p; await api(`/movies/${selected.id}/progress`, 'POST', {position:p}).catch(() => {}); }
video.ontimeupdate = () => { updatePlayerTimeline(); if(Date.now() - lastSaved > 5000 && playback) { lastSaved = Date.now(); saveProgress(); } };
video.onended = () => { saveProgress(); $('player-loading').hidden = true; };
$('player-quality').onchange = () => startPlayback(position()).catch(e => showPlayerError(e.message));
async function closePlayer() { ++playGeneration; if(document.fullscreenElement && $('player-dialog').open) await document.exitFullscreen().catch(()=>{}); await saveProgress(); await release(); $('player-dialog').close(); if(state?.user) await refresh(); }
$('player-close').onclick = closePlayer;
$('player-dialog').addEventListener('cancel', event => { event.preventDefault(); closePlayer(); });
setInterval(() => {
  if(playback?.session) api(`/streams/${playback.session}/heartbeat`, 'POST').catch(() => {});
  if(playback?.media_ticket) api('/media/heartbeat', 'POST', {ticket:playback.media_ticket}).catch(e => showPlayerError(e.message));
}, 30000);
window.addEventListener('pagehide', () => { if(playback && selected) { fetch(`/api/movies/${selected.id}/progress`, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({position:position()}),keepalive:true}); if(playback.session && !airplayActive()) fetch(`/api/streams/${playback.session}`, {method:'DELETE',keepalive:true}); } });

setupUploads();
$('admin-open').onclick = async () => { try { const data = await api('/admin'); $('server-stats').innerHTML = `<div><strong>${data.gpu ? 'NVIDIA NVENC' : 'CPU'}</strong>Transcoding-motor · ${data.gpu ? 'GPU-test bestået' : 'softwarekonvertering'}</div><div><strong>${data.free_gb} GB</strong>Ledig serverplads</div><div><strong>${data.streams} / ${data.max_streams}</strong>Aktive konverteringssessioner</div><div><strong>${data.users.length}</strong>Brugere på serveren</div>`; $('users-list').innerHTML = data.users.map(u => `<div class="user-row">${escapeHtml(u.name)}<span>${u.admin ? 'Administrator' : 'Bruger'}</span></div>`).join(''); $('admin-dialog').showModal(); } catch(e) { toast(e.message); } };
$('create-invite').onclick = async () => { try { const result = await api('/invites','POST'); $('invite-result').hidden = false; $('invite-code').value = result.token; } catch(e) { toast(e.message); } };
$('copy-invite').onclick = async () => { try { await navigator.clipboard.writeText($('invite-code').value); toast('Invitationskoden er kopieret.'); } catch { $('invite-code').select(); toast('Markér og kopiér invitationskoden.'); } };
async function loadMediaSettings() {
  try {
    const data=await api('/admin/media');
    $('media-web-url').value=data.web_url;
    $('media-direct-url').value=data.media_url;
    $('media-hub-source').textContent=data.hub_url ? `Adresse i FjordHub: ${data.hub_url}` : '';
    $('media-settings-error').textContent='';
  } catch(e) { toast(e.message); }
}
function showMetadataStatus(data) {
  $('metadata-status').textContent = data.configured
    ? (data.source === 'environment' ? 'API-nøgle er sat via serverens miljøvariabel.' : 'API-nøgle er gemt på serveren.')
    : 'Automatiske filmopslag er slået fra.';
  $('metadata-disable').disabled = !data.configured;
}
async function loadMetadataSettings() {
  try {
    showMetadataStatus(await api('/admin/metadata'));
    $('metadata-token').value = ''; $('metadata-error').textContent = '';
  } catch(e) { toast(e.message); }
}
$('admin-dialog').addEventListener('close', () => { $('metadata-token').value = ''; });
$('metadata-settings-form').onsubmit = async event => {
  event.preventDefault(); $('metadata-save').disabled = true; $('metadata-error').textContent = '';
  try {
    showMetadataStatus(await api('/admin/metadata', 'PUT', {token: $('metadata-token').value.trim()}));
    $('metadata-token').value = ''; toast('TMDB-nøglen er gemt. Bruges ved næste upload.');
  } catch(e) { $('metadata-error').textContent = e.message; }
  finally { $('metadata-save').disabled = false; }
};
$('metadata-disable').onclick = async () => {
  if (!confirm('Fjern den gemte nøgle og slå nye filmopslag fra? Eksisterende filmdata bevares.')) return;
  try {
    showMetadataStatus(await api('/admin/metadata', 'DELETE'));
    $('metadata-token').value = ''; $('metadata-error').textContent = '';
  } catch(e) { $('metadata-error').textContent = e.message; }
};
$('media-settings-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/admin/media','PUT',{web_url:$('media-web-url').value,media_url:$('media-direct-url').value});
    location.reload();
  } catch(e) { $('media-settings-error').textContent=e.message; }
};
boot().catch(error => { $('auth').hidden = false; $('auth-error').textContent = 'Serveren kunne ikke kontaktes. ' + error.message; });

