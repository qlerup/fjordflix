const $ = (id) => document.getElementById(id);
let state, library = [], selected, view = 'home', authMode = 'login', hls, playback, lastSaved = 0, switching = false, playGeneration = 0, planGeneration = 0;
const video = $('video');
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
  $('shell').hidden = true; $('auth').hidden = false;
  if (state.managed) authMode = 'login';
  else if (state.setup) authMode = 'setup';
  const setup = authMode === 'setup', register = authMode === 'register';
  $('auth-kicker').textContent = setup ? 'FØRSTE GANG · TRIN 1 AF 1' : register ? 'GØR DIG KLAR TIL FILMAFTEN' : 'GODT AT SE DIG IGEN';
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
  $('logout').textContent = state.user.name[0].toUpperCase(); $('logout').title = `${state.user.name} · Log ud`;
  ['admin-open','upload-open','demo-button'].forEach(id => $(id).hidden = !state.user.admin);
  $('create-invite').hidden = state.managed;
  $('invite-result').hidden = true;
  let userNote = $('hub-user-note');
  if(!userNote) {userNote=document.createElement('p');userNote.id='hub-user-note';userNote.className='muted';$('users-list').before(userNote);}
  userNote.hidden = !state.managed;
  userNote.textContent = 'Konti, adgangskoder og roller styres i FjordHub → Brugere. Listen viser de brugere, der har adgang til FjordFlix.';
  await refresh();
}
async function refresh() { library = await api('/movies'); render(); }
function render() {
  const query = $('search').value.toLocaleLowerCase('da');
  const cards = FjordLibrary.cards(library);
  const visible = cards.filter(m => FjordLibrary.matches(m, query) && (view !== 'favorites' || m.favorite)
    && (view !== 'series' || m.isSeries) && (view !== 'all' || !m.isSeries));
  $('library-title').innerHTML = `${query ? 'Søgeresultater' : view === 'favorites' ? 'Min liste' : view === 'series' ? 'Dine serier' : view === 'all' ? 'Dine film' : 'Dit bibliotek'} <span>${visible.length}</span>`;
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h3').textContent = query ? 'Ingen film matcher søgningen' : view === 'favorites' ? 'Din liste venter på favoritter' : 'Her begynder samlingen';
  $('empty').querySelector('p').textContent = query ? 'Prøv en anden filmtitel.' : view === 'favorites' ? 'Åbn en film, og tryk på Min liste for at gemme den her.' : state.user.admin ? 'Upload din første film, eller prøv afspilleren med den genererede 4K-testfilm.' : 'Din administrator kan tilføje film til det fælles bibliotek.';
  fillGrid('movie-grid', visible);
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
  $('demo-button').hidden = !state.user.admin || !!featured;
}
function fillGrid(id, movies) {
  $(id).innerHTML = movies.map(m => `<button class="movie-card${m.isSeries ? ' series-card' : ''}" data-id="${m.id}"><div class="movie-image"><img src="${FjordLibrary.artwork(m, 'poster')}" alt="" loading="lazy"><span class="resolution">${m.isSeries ? 'SERIE' : m.height >= 2160 ? '4K' : m.height+'p'}${m.hdr ? ' · HDR' : ''}</span><span class="card-play">${m.isSeries ? '☷' : '▶'}</span></div>${m.position && !m.isSeries ? `<div class="progress-bar"><div style="width:${Math.min(100,m.position/m.duration*100)}%"></div></div>` : ''}<h3>${escapeHtml(m.title)}</h3><p>${m.isSeries ? `${m.seasonCount} sæsoner · ${m.episodes.length} afsnit` : `${clock(m.duration)} · ${escapeHtml(m.video.toUpperCase())}`} ${m.favorite ? '&nbsp;·&nbsp; ♥' : ''}</p></button>`).join('');
  $(id).querySelectorAll('[data-id]').forEach(button => button.onclick = () => openDetail(movies.find(m => m.id === button.dataset.id)));
}
setupLibraryUI();
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button)); render(); });
$('search').oninput = render;
$('logout').onclick = async () => { try { await api('/logout', 'POST'); authMode = 'login'; await boot(); } catch(e) { toast(e.message); } };
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());

async function capabilities(movie, quality) {
  const mime = movie.format.includes('webm') ? 'video/webm' : 'video/mp4';
  const codecs = {h264: 'avc1.640033', hevc:'hvc1.1.6.L153.B0', av1:'av01.0.13M.08', vp9:'vp09.00.51.08', vp8:'vp8'};
  const codec = codecs[movie.video];
  let supported = !!codec && !!video.canPlayType(`${mime}; codecs="${codec}"`);
  const allowedContainer = mime === 'video/webm' || movie.format.includes('mp4');
  const audioType = movie.audio === 'aac' ? 'audio/mp4; codecs="mp4a.40.2"' : movie.audio === 'opus' ? 'audio/webm; codecs="opus"' : movie.audio === 'mp3' ? 'audio/mpeg' : null;
  const audioSupported = !movie.audio || !!audioType && !!video.canPlayType(audioType);
  if (navigator.mediaCapabilities && supported) {
    try { const info = await navigator.mediaCapabilities.decodingInfo({type:'file', video:{contentType:`${mime}; codecs="${codec}"`, width:movie.width, height:movie.height, bitrate:movie.bitrate || 8000000, framerate:24}}); supported = info.supported; } catch { supported = false; }
  }
  if (movie.video === 'h264' && movie.pix_fmt !== 'yuv420p') supported = false;
  // HDR passthrough is deliberately conservative until the full output chain is known.
  if (movie.hdr) supported = false;
  return {quality, direct:supported && allowedContainer && audioSupported, h264:!!video.canPlayType('video/mp4; codecs="avc1.640028"'), bandwidth:navigator.connection?.downlink || 0};
}
async function openDetail(movie) {
  if (movie?.isSeries) movie = FjordLibrary.initial(movie.episodes);
  if (!movie) return;
  selected = movie; $('detail-title').textContent = movie.title;
  $('detail-art').style.backgroundImage = `url('${FjordLibrary.artwork(movie, 'backdrop')}')`;
  $('detail-meta').innerHTML = [`${movie.width} × ${movie.height}`,movie.video.toUpperCase(),movie.hdr ? 'HDR' : 'SDR',clock(movie.duration)].map(t => `<span>${escapeHtml(t)}</span>`).join('');
  $('detail-description').textContent = `${(movie.size / 1024**3).toFixed(2)} GB · ${(movie.bitrate/1e6).toFixed(1)} Mbit/s · ${movie.audio?.toUpperCase() || 'Uden lyd'}. ${movie.title.includes('testfilm') ? 'Genereret testmønster med lyd til at teste 4K og transcoding.' : 'En film fra dit fælles bibliotek.'}`;
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
  if (!$('detail').open) $('detail').showModal(); await updatePlan();
}
async function updatePlan() {
  const generation = ++planGeneration;
  try { const movie = selected; const p = await api(`/movies/${movie.id}/plan`, 'POST', await capabilities(movie, $('detail-quality').value)); if (movie !== selected || generation !== planGeneration) return; badge('plan-badge', p.mode); $('plan-reason').textContent = `${p.height}p · ${p.mbps} Mbit/s. ${p.reason}`; } catch(e) { toast(e.message); }
}
$('detail-quality').onchange = updatePlan;
$('favorite-button').onclick = async () => { try { await api(`/movies/${selected.id}/favorite`, 'POST'); selected.favorite = !selected.favorite; $('favorite-button').textContent = selected.favorite ? '✓ På min liste' : '＋ Min liste'; await refresh(); } catch(e) { toast(e.message); } };
function playFromDetail(start) { document.activeElement?.blur(); $('detail').close(); $('player-dialog').showModal(); fitPlayerViewport(); $('player-quality').value = $('detail-quality').value; startPlayback(start).catch(e => showPlayerError(e.message)); }
$('play-button').onclick = () => playFromDetail(selected.position < selected.duration - 2 ? selected.position : 0);
$('restart-button').onclick = () => playFromDetail(0);
function showPlayerError(message) { $('player-error').textContent = message; $('player-loading').hidden = true; }
async function release() {
  video.pause(); video.removeAttribute('src'); video.load();
  if (hls) { hls.destroy(); hls = null; }
  const old = playback; playback = null;
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
    await loadHlsLibrary();
    if (generation !== playGeneration || !$('player-dialog').open) return;
    const data = await capabilities(selected, $('player-quality').value);
    if (fallback) { data.direct = false; data.h264 = false; }
    const result = await api(`/movies/${selected.id}/play`, 'POST', {...data, start:position});
    if (generation !== playGeneration || !$('player-dialog').open) { if(result.session) await api(`/streams/${result.session}`, 'DELETE'); return; }
    playback = result; lastSaved = 0;
    if(result.media_ticket) video.crossOrigin = 'anonymous'; else video.removeAttribute('crossorigin');
    $('playback-info').textContent = `${selected.height}p → ${result.height}p · ${result.mbps} Mbit/s · ${result.encoder}${result.delivery === 'direct' ? ' · Direkte forbindelse' : ''}`;
    video.onloadedmetadata = () => { if (result.mode === 'Direct Play') video.currentTime = position; video.play().catch(() => { $('player-loading').hidden = true; toast('Tryk på afspil for at starte filmen.'); }); };
    if (result.session && Hls.isSupported()) {
      hls = new Hls({startPosition:0, maxBufferLength:30, backBufferLength:30});
      hls.loadSource(result.url); hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, info) => { if (info.fatal) showPlayerError('Streamen blev afbrudt. Vælg kvalitet igen for at genstarte.'); });
    } else if (!result.session || video.canPlayType('application/vnd.apple.mpegurl')) { video.src = result.url; }
    else { showPlayerError('Denne browser understøtter ikke HLS. Prøv en nyere browser.'); }
  } finally { switching = false; }
}
video.onplaying = () => { $('player-loading').hidden = true; if(playback) badge('actual-badge', playback.mode); };
video.onwaiting = () => { if(playback) { $('player-loading').hidden = false; $('player-loading').textContent = 'Bufferer…'; } };
video.onerror = () => { if(switching || !playback) return; if(playback.mode === 'Direct Play') { toast('Originalformatet kunne ikke afspilles. Prøver transcoding.'); startPlayback(video.currentTime || 0, true).catch(e => showPlayerError(e.message)); } else showPlayerError('Videoen kunne ikke afspilles. Prøv en anden kvalitet.'); };
function position() { return Math.min(selected?.duration || 0, (video.currentTime || 0) + (playback?.offset || 0)); }
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
window.addEventListener('pagehide', () => { if(playback && selected) { fetch(`/api/movies/${selected.id}/progress`, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({position:position()}),keepalive:true}); if(playback.session) fetch(`/api/streams/${playback.session}`, {method:'DELETE',keepalive:true}); } });

$('upload-open').onclick = () => $('upload-dialog').showModal();
$('upload-form').onsubmit = event => {
  event.preventDefault(); const file = $('upload-file').files[0]; if(!file) return;
  $('upload-submit').disabled = true; $('upload-progress').hidden = false; $('upload-progress').value = 0;
  const xhr = new XMLHttpRequest(); xhr.open('PUT', `/api/upload?filename=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = e => { if(e.lengthComputable) { const p = Math.round(e.loaded/e.total*100); $('upload-progress').value = p; $('upload-status').textContent = p === 100 ? 'Upload færdig. Læser filmoplysninger og laver billede…' : `Uploader ${p}% · ${(e.loaded/1024**2).toFixed(0)} / ${(e.total/1024**2).toFixed(0)} MB`; } };
  xhr.onload = async () => { $('upload-submit').disabled = false; if(xhr.status >= 200 && xhr.status < 300) { $('upload-status').textContent = 'Filmen er klar.'; $('upload-dialog').close(); $('upload-form').reset(); await refresh(); const status = JSON.parse(xhr.responseText).metadata_status; toast(status === 'matched' ? 'Film tilføjet med oplysninger fra TMDB.' : status === 'disabled' ? 'Film tilføjet. Automatisk filmdata kræver et TMDB-token på serveren.' : status === 'unmatched' ? 'Film tilføjet. Intet sikkert match fundet i TMDB.' : 'Film tilføjet. TMDB kunne ikke kontaktes.'); } else { let message = 'Upload mislykkedes.'; try { message = JSON.parse(xhr.responseText).detail || message; } catch {} $('upload-status').textContent = message; } };
  xhr.onerror = () => { $('upload-submit').disabled = false; $('upload-status').textContent = 'Forbindelsen blev afbrudt. Prøv upload igen.'; };
  xhr.send(file);
};
let demoPackTimer;
let stressDemoTimer;
async function updateStressDemo() {
  clearTimeout(stressDemoTimer);
  try {
    const status = await api('/demo-stress');
    $('demo-stress-button').disabled = status.running;
    $('demo-stress-status').textContent = status.error || (status.running ? 'Opretter 4K ved 120 Mbit/s. Det kan tage flere minutter; du kan lukke vinduet imens.' : status.id ? 'Bitstorm er klar. Vælg Original for at teste den fulde bitrate, eller 1080p for at teste transcoding.' : 'Syntetisk testfilm med bevægelse og støj. Eksisterende testfilm genbruges.');
    if(status.running) stressDemoTimer = setTimeout(updateStressDemo, 2000);
    else if(status.id) await refresh();
  } catch(e) { $('demo-stress-button').disabled = false; $('demo-stress-status').textContent = e.message; }
}
$('demo-stress-button').onclick = async () => {
  $('demo-stress-button').disabled = true;
  try { await api('/demo-stress', 'POST'); await updateStressDemo(); }
  catch(e) { $('demo-stress-button').disabled = false; $('demo-stress-status').textContent = e.message; }
};
$('admin-open').addEventListener('click', updateStressDemo);
async function updateDemoPack() {
  clearTimeout(demoPackTimer);
  try {
    const status = await api('/demo-pack');
    $('demo-pack-button').disabled = status.running;
    $('demo-pack-status').textContent = status.error || (status.running ? `Opretter testfilm · ${status.completed} af 3 klar. Du kan lukke dette vindue imens.` : status.completed === 3 ? 'Alle tre testfilm er klar i biblioteket.' : 'Oprettes på serveren. Det kan tage nogle minutter. Eksisterende testfilm genbruges.');
    if(status.running) demoPackTimer = setTimeout(updateDemoPack, 2000);
    else if(status.completed) await refresh();
  } catch(e) { $('demo-pack-button').disabled = false; $('demo-pack-status').textContent = e.message; }
}
$('demo-pack-button').onclick = async () => {
  $('demo-pack-button').disabled = true;
  try { await api('/demo-pack', 'POST'); await updateDemoPack(); }
  catch(e) { $('demo-pack-button').disabled = false; $('demo-pack-status').textContent = e.message; }
};
$('admin-open').addEventListener('click', updateDemoPack);
$('demo-button').onclick = async () => { $('demo-button').disabled = true; $('demo-button').textContent = 'Genererer 4K-testfilm…'; try { await api('/demo', 'POST'); await refresh(); toast('4K-testfilmen er klar. Åbn den og prøv 1080p.'); } catch(e) { toast(e.message); } finally { $('demo-button').disabled = false; $('demo-button').textContent = 'Prøv med en 4K-testfilm'; } };
$('admin-open').onclick = async () => { try { const data = await api('/admin'); $('server-stats').innerHTML = `<div><strong>${data.gpu ? 'NVIDIA NVENC' : 'CPU'}</strong>Transcoding-motor · ${data.gpu ? 'GPU-test bestået' : 'softwarekonvertering'}</div><div><strong>${data.free_gb} GB</strong>Ledig serverplads</div><div><strong>${data.streams} / ${data.max_streams}</strong>Aktive konverteringssessioner</div><div><strong>${data.users.length}</strong>Brugere på serveren</div>`; $('users-list').innerHTML = data.users.map(u => `<div class="user-row">${escapeHtml(u.name)}<span>${u.admin ? 'Administrator' : 'Bruger'}</span></div>`).join(''); $('admin-dialog').showModal(); } catch(e) { toast(e.message); } };
$('create-invite').onclick = async () => { try { const result = await api('/invites','POST'); $('invite-result').hidden = false; $('invite-code').value = result.token; } catch(e) { toast(e.message); } };
$('copy-invite').onclick = async () => { try { await navigator.clipboard.writeText($('invite-code').value); toast('Invitationskoden er kopieret.'); } catch { $('invite-code').select(); toast('Markér og kopiér invitationskoden.'); } };
$('media-settings-open').onclick = async () => {
  try {
    const data=await api('/admin/media');
    $('media-web-url').value=data.web_url;
    $('media-direct-url').value=data.media_url;
    $('media-hub-source').textContent=data.hub_url ? `Adresse i FjordHub: ${data.hub_url}` : '';
    $('media-settings-error').textContent='';
    $('admin-dialog').close(); $('media-settings-dialog').showModal();
  } catch(e) { toast(e.message); }
};
const metadataButton = document.createElement('button');
metadataButton.className = 'secondary';
metadataButton.textContent = 'Filmoplysninger · TMDB';
$('media-settings-open').after(metadataButton);
function showMetadataStatus(data) {
  $('metadata-status').textContent = data.configured
    ? (data.source === 'environment' ? 'API-nøgle er sat via serverens miljøvariabel.' : 'API-nøgle er gemt på serveren.')
    : 'Automatiske filmopslag er slået fra.';
  $('metadata-disable').disabled = !data.configured;
}
metadataButton.onclick = async () => {
  try {
    showMetadataStatus(await api('/admin/metadata'));
    $('metadata-token').value = ''; $('metadata-error').textContent = '';
    $('admin-dialog').close(); $('metadata-settings-dialog').showModal();
  } catch(e) { toast(e.message); }
};
$('metadata-settings-dialog').addEventListener('close', () => { $('metadata-token').value = ''; });
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
