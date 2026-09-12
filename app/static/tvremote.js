// A phone controls only FjordFlix's own browser UI. No OS input or arbitrary commands.
const remoteTV = {screen:null, socket:null, x:innerWidth/2, y:innerHeight/2, paired:false, timer:null};
const remoteCursor = document.createElement('div');
remoteCursor.id = 'remote-cursor'; remoteCursor.hidden = true;
remoteCursor.innerHTML = '<svg viewBox="0 0 24 30" aria-hidden="true"><path d="M2 2 L2 25 L8 19 L12 28 L17 26 L13 17 L22 17 Z"/></svg>';
document.body.append(remoteCursor);
let remoteHover;
function remoteTarget(element) {
  const dropdown = element?.closest('.fx-select-button,.fx-select-option');
  if (dropdown) return ['detail-quality','player-quality','series-season','library-genre'].includes(dropdown.dataset.selectId) && !dropdown.disabled ? dropdown : null;
  const target = element?.closest('.movie-card,[data-view],#play-button,#restart-button,#favorite-button,#player-close,[data-close="detail"],#detail-quality,#player-quality,#hero-action,#demo-button,#player-toggle,#player-rewind,#player-forward,#player-mute,#player-fullscreen,#timeline,#player-volume');
  if(!target || target.disabled) return null;
  if(target.id === 'hero-action' && !library.length) return null;
  if(target.id === 'demo-button' && !state?.user?.admin) return null;
  return target;
}
function remoteStatus(text) { $('remote-status').textContent = text; }
function placeRemoteCursor() {
  const host = document.querySelector('dialog[open]') || document.body;
  if(remoteCursor.parentElement !== host) host.append(remoteCursor);
  remoteTV.x = Math.max(4,Math.min(innerWidth-16,remoteTV.x)); remoteTV.y = Math.max(4,Math.min(innerHeight-20,remoteTV.y));
  remoteCursor.style.left = remoteTV.x+'px'; remoteCursor.style.top = remoteTV.y+'px';
  remoteCursor.hidden = !remoteTV.paired;
  const hit = remoteTarget(document.elementFromPoint(remoteTV.x,remoteTV.y));
  if(remoteHover !== hit) { remoteHover?.classList.remove('remote-hover'); hit?.classList.add('remote-hover'); remoteHover = hit; }
}
async function stopRemote() {
  const sid = remoteTV.screen; remoteTV.screen = null; remoteTV.paired = false;
  clearInterval(remoteTV.timer); remoteTV.socket?.close(); remoteTV.socket = null;
  remoteCursor.hidden = true; remoteHover?.classList.remove('remote-hover');
  $('remote-indicator').hidden = true; $('remote-disconnect').hidden = true;
  if(sid) await api(`/remote/screens/${sid}`, 'DELETE').catch(() => {});
}
async function showRemoteQR() {
  if(!state?.user) return;
  $('remote-dialog').showModal(); $('remote-refresh').disabled = true; $('remote-qr').hidden = true;
  remoteStatus('Gør din fjernbetjening klar…'); $('remote-address').textContent = '';
  await stopRemote();
  try {
    const result = await api('/remote/screens','POST'); remoteTV.screen = result.screen;
    $('remote-qr').src = result.qr; $('remote-qr').hidden = false;
    $('remote-address').textContent = new URL(result.link).origin;
    $('remote-local-warning').hidden = !result.local_only;
    $('remote-qr').alt = 'QR-kode til at forbinde telefonen med denne FjordFlix-skærm';
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/remote/ws/${result.screen}/tv`);
    remoteTV.socket = socket;
    let expires = Date.now() + result.expires_in*1000;
    socket.onmessage = e => {
      if(remoteTV.socket !== socket) return;
      const event = JSON.parse(e.data);
      if(event.type === 'ready') remoteStatus('Scan koden med kameraet på din telefon');
      else if(event.type === 'paired') {
        remoteTV.paired = true; $('remote-dialog').close(); $('remote-indicator').hidden = false;
        $('remote-indicator').textContent = '● Telefon forbundet'; $('remote-disconnect').hidden = false;
        remoteStatus('Telefonen er forbundet.'); placeRemoteCursor(); toast('Telefonen er nu din fjernbetjening.');
      } else if(event.type === 'phone_offline') {
        $('remote-indicator').textContent = '○ Telefonen mistede forbindelsen'; remoteTV.paired = false; remoteCursor.hidden = true;
      } else if(event.type !== 'pong') handleRemoteCommand(event);
    };
    socket.onclose = () => { if(remoteTV.socket !== socket) return; remoteTV.paired = false; remoteCursor.hidden = true; $('remote-indicator').hidden = false; $('remote-indicator').textContent = '○ Fjernbetjening afbrudt'; remoteStatus('Forbindelsen blev afbrudt. Vis en ny QR-kode.'); clearInterval(remoteTV.timer); };
    remoteTV.timer = setInterval(() => {
      const left = Math.max(0,Math.ceil((expires-Date.now())/1000));
      $('remote-expiry').textContent = remoteTV.paired ? 'Telefonen er tilsluttet denne browser.' : left ? `Koden kan bruges én gang · udløber om ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}` : 'Koden er udløbet. Tryk på Ny QR-kode.';
      if(socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'ping'}));
      if(!state?.user) stopRemote();
    }, 1000);
  } catch(error) { remoteStatus(error.message); }
  finally { $('remote-refresh').disabled = false; }
}
function remoteSelect(select) {
  select.selectedIndex = (select.selectedIndex+1)%select.options.length;
  select.dispatchEvent(new Event('change',{bubbles:true}));
}
function handleRemoteCommand(event) {
  if(!remoteTV.paired || !state?.user) return;
  if($('player-dialog').open) wakePlayerControls();
  if(event.type === 'move') { remoteTV.x += event.dx; remoteTV.y += event.dy; placeRemoteCursor(); return; }
  if(event.type === 'scroll') { (document.querySelector('dialog[open]') || document.scrollingElement).scrollBy({top:event.dy,behavior:'instant'}); placeRemoteCursor(); return; }
  if(event.type === 'back') {
    if(window.FjordSelects?.closeOpen()) return;
    if($('player-dialog').open) closePlayer();
    else { document.querySelector('dialog[open]')?.close(); }
  }
  if(event.type === 'play' && $('player-dialog').open) { if(video.paused) video.play().catch(()=>toast('Tryk én gang på afspilleren på pc’en for at tillade afspilning.')); else video.pause(); }
  if(event.type === 'seek' && playback && !switching) {
    const target = Math.max(0,Math.min(selected.duration-0.1,position()+event.delta));
    if(playback.mode === 'Direct Play') video.currentTime = target;
    else startPlayback(target).catch(e=>showPlayerError(e.message));
  }
  if(event.type === 'volume') { video.volume = Math.max(0,Math.min(1,video.volume+event.delta)); }
  if(event.type === 'quality') {
    if($('player-dialog').open && !switching) remoteSelect($('player-quality'));
    else if($('detail').open) remoteSelect($('detail-quality'));
  }
  if(event.type === 'search') {
    if($('player-dialog').open) return;
    document.querySelector('dialog[open]')?.close(); $('search').value = event.text; render();
  }
  if(event.type === 'click') {
    placeRemoteCursor();
    const element = document.elementFromPoint(remoteTV.x,remoteTV.y);
    // Browsing/playback and the admin's demo action; no account, upload or external-link actions.
    const allowed = remoteTarget(element);
    if(allowed && !allowed.disabled) {
      if(allowed.type === 'range') {
        const box=allowed.getBoundingClientRect(), fraction=Math.max(0,Math.min(1,(remoteTV.x-box.left)/box.width));
        if(allowed.id === 'timeline') seekPlayer(fraction*(selected?.duration || 0));
        else { video.volume=fraction;video.muted=fraction===0; }
      }
      else if(allowed.tagName === 'SELECT') { if(!switching) remoteSelect(allowed); }
      else allowed.click();
    } else if(element === video && $('player-dialog').open) handleRemoteCommand({type:'play'});
    else if(element?.closest('button,input,a,select')) toast('Brug pc’en til denne funktion. Telefonen styrer filmvalg og afspilning.');
    remoteCursor.classList.add('click'); setTimeout(()=>remoteCursor.classList.remove('click'),180);
  }
  requestAnimationFrame(placeRemoteCursor);
}
$('remote-open').onclick = () => {
  if(remoteTV.paired) { $('remote-qr').hidden = true; $('remote-disconnect').hidden = false; remoteStatus('Din telefon er allerede forbundet til denne browser.'); $('remote-dialog').showModal(); }
  else showRemoteQR();
};
$('remote-refresh').onclick = showRemoteQR;
$('remote-disconnect').onclick = async () => { await stopRemote(); $('remote-dialog').close(); toast('Telefonen er afbrudt.'); };
$('remote-dialog').addEventListener('close', () => { if(!remoteTV.paired) stopRemote(); });
addEventListener('resize',placeRemoteCursor);
addEventListener('pagehide', () => { if(remoteTV.screen) fetch(`/api/remote/screens/${remoteTV.screen}`,{method:'DELETE',keepalive:true}); });
// Native mouse activity and dialog changes keep the overlay in the right top layer.
new MutationObserver(() => { if(remoteTV.paired) placeRemoteCursor(); }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
