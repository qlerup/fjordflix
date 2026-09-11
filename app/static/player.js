// All positions use the original movie timeline, including transcoded streams with an offset.
const playerDialog = $('player-dialog');
const playerIcons = {
  play:'<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  back:'<path d="m11 5-7 7 7 7M4 12h16"/>',
  rewind:'<path d="M4 9a8 8 0 1 1 0 7M4 4v5h5"/><text x="12" y="15" text-anchor="middle" font-family="Arial" font-size="8" fill="currentColor" stroke="none">10</text>',
  forward:'<path d="M20 9a8 8 0 1 0 0 7M20 4v5h-5"/><text x="12" y="15" text-anchor="middle" font-family="Arial" font-size="8" fill="currentColor" stroke="none">10</text>',
  volume:'<path d="m11 5-5 4H3v6h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  muted:'<path d="m11 5-5 4H3v6h3l5 4ZM16 9l5 6M21 9l-5 6"/>',
  fullscreen:'<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6"/>',
  exitFullscreen:'<path d="M3 9h6V3M15 3v6h6M9 21v-6H3M15 21v-6h6"/>'
};
function playerIcon(button, name) {
  button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${playerIcons[name]}</svg>`;
}
playerDialog.querySelectorAll('[data-icon]').forEach(b=>playerIcon(b,b.dataset.icon));
let playerIdleTimer, playerScrubbing=false;
function wakePlayerControls() {
  playerDialog.classList.remove('controls-hidden');
  clearTimeout(playerIdleTimer);
  if(!playerDialog.open) return;
  playerIdleTimer=setTimeout(()=>{
    if(!video.paused && !video.ended && !playerScrubbing && $('player-loading').hidden && !$('player-error').textContent && !playerDialog.querySelector(':focus-visible')) {
      playerDialog.classList.add('controls-hidden');
    }
  },3000);
}
function updatePlayerTimeline() {
  if(playerScrubbing) return;
  const value=position(), duration=selected?.duration || 0;
  $('timeline').value=value;
  $('timeline').style.setProperty('--played',`${duration ? value/duration*100 : 0}%`);
  $('timeline-time').textContent=`${clock(value)} / ${clock(duration)}`;
  $('timeline').setAttribute('aria-valuetext',`${clock(value)} af ${clock(duration)}`);
}
function togglePlayer() {
  if(!playerDialog.open || switching) return;
  if(video.paused) video.play().catch(()=>showPlayerError('Tryk på afspil på skærmen for at starte filmen.'));
  else video.pause();
  wakePlayerControls();
}
function seekPlayer(value) {
  if(!playback || switching) return;
  const target=Math.max(0,Math.min((selected?.duration || 0)-0.1,value));
  if(playback.mode==='Direct Play') video.currentTime=target;
  else startPlayback(target).catch(e=>showPlayerError(e.message));
  wakePlayerControls();
}
async function togglePlayerFullscreen() {
  try {
    if(document.fullscreenElement) await document.exitFullscreen();
    else if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else if(video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else toast('Fuld skærm understøttes ikke i denne browser.');
  } catch { toast('Tryk på fuld skærm direkte på skærmen.'); }
  wakePlayerControls();
}
$('player-toggle').onclick=togglePlayer;
$('player-rewind').onclick=()=>seekPlayer(position()-10);
$('player-forward').onclick=()=>seekPlayer(position()+10);
$('player-mute').onclick=()=>{video.muted=!video.muted;};
$('player-volume').oninput=()=>{video.volume=Number($('player-volume').value);video.muted=video.volume===0;};
$('player-fullscreen').onclick=togglePlayerFullscreen;
video.addEventListener('click',togglePlayer);
video.addEventListener('dblclick',togglePlayerFullscreen);
for(const name of ['play','pause','ended','waiting','playing']) video.addEventListener(name,()=>{
  playerIcon($('player-toggle'),video.paused?'play':'pause');
  $('player-toggle').setAttribute('aria-label',video.paused?'Afspil':'Pause');
  wakePlayerControls();
});
video.addEventListener('volumechange',()=>{
  playerIcon($('player-mute'),video.muted || !video.volume?'muted':'volume');
  $('player-mute').setAttribute('aria-label',video.muted?'Slå lyd til':'Slå lyd fra');
  $('player-volume').value=video.muted?0:video.volume;
});
$('timeline').addEventListener('pointerdown',()=>{playerScrubbing=true;});
$('timeline').addEventListener('pointercancel',()=>{playerScrubbing=false;updatePlayerTimeline();});
window.addEventListener('pointerup',()=>{
  if(playerScrubbing) setTimeout(()=>{playerScrubbing=false;updatePlayerTimeline();},0);
});
$('timeline').oninput=()=>{
  playerScrubbing=true;
  const value=Number($('timeline').value), duration=selected?.duration || 0;
  $('timeline').style.setProperty('--played',`${duration ? value/duration*100 : 0}%`);
  $('timeline-time').textContent=`${clock(value)} / ${clock(duration)}`;
};
$('timeline').onchange=()=>{playerScrubbing=false;seekPlayer(Number($('timeline').value));};
$('timeline').addEventListener('blur',()=>{playerScrubbing=false;updatePlayerTimeline();});
for(const name of ['pointermove','pointerdown','keydown','focusin']) playerDialog.addEventListener(name,wakePlayerControls);
playerDialog.addEventListener('close',()=>{clearTimeout(playerIdleTimer);playerScrubbing=false;playerDialog.classList.remove('controls-hidden');});
document.addEventListener('fullscreenchange',()=>{
  const full=!!document.fullscreenElement;
  playerIcon($('player-fullscreen'),full?'exitFullscreen':'fullscreen');
  $('player-fullscreen').setAttribute('aria-label',full?'Afslut fuld skærm':'Fuld skærm');
  wakePlayerControls();
});
playerDialog.addEventListener('keydown',event=>{
  if(event.target.closest('input,select,button') || event.ctrlKey || event.metaKey || event.altKey) return;
  if(event.code==='Space' || event.key.toLowerCase()==='k') {event.preventDefault();togglePlayer();}
  else if(event.key==='ArrowLeft') {event.preventDefault();seekPlayer(position()-10);}
  else if(event.key==='ArrowRight') {event.preventDefault();seekPlayer(position()+10);}
  else if(event.key.toLowerCase()==='m') video.muted=!video.muted;
  else if(event.key.toLowerCase()==='f') togglePlayerFullscreen();
});
