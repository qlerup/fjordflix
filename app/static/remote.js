const el = id => document.getElementById(id);
let socket, session, retry = 0, deliberate = false, sendTimer, heartbeat;
const fragment = location.hash.slice(1).split(':');
history.replaceState(null,'',location.pathname);
try { session = JSON.parse(sessionStorage.getItem('fjordflix-remote') || 'null'); } catch {}
if(fragment.length === 2) { session = null; sessionStorage.removeItem('fjordflix-remote'); }
el('connect').disabled = fragment.length !== 2 && !session;
if(!session && fragment.length !== 2) el('connect-error').textContent = 'Scan QR-koden på din pc for at forbinde.';
function showError(message) { el('connect-error').textContent = message; el('connect-panel').hidden = false; el('controller').hidden = true; }
function send(data) { if(socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
function status(text, online) { el('remote-connection-status').textContent = text; el('connection-dot').style.background = online ? '#69c39a' : '#d29967'; el('controller').classList.toggle('offline',!online); }
function connectSocket() {
  if(!session) return;
  el('connect-panel').hidden = true; el('controller').hidden = false;
  el('screen-name').textContent = session.name; status('Forbinder til skærmen…',false);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/remote/ws/${session.screen}/phone`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({key:session.key}));
  ws.onmessage = e => {
    if(ws !== socket) return;
    const data = JSON.parse(e.data);
    if(data.type === 'ready') { retry=0; status('Forbundet · klar til filmaften',true); }
  };
  ws.onclose = event => {
    if(ws !== socket || deliberate) return;
    status('Forbindelsen er afbrudt…',false);
    if([1008,4001].includes(event.code) || ++retry > 4) {
      sessionStorage.removeItem('fjordflix-remote'); session = null;
      el('connect').disabled = true; showError('Parringen er afsluttet. Vis en ny QR-kode på pc’en og scan den.');
    } else setTimeout(connectSocket,1000*retry);
  };
}
el('connect').onclick = async () => {
  el('connect').disabled = true; el('connect-error').textContent = '';
  try {
    const response = await fetch('/api/remote/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({screen:fragment[0],token:fragment[1]})});
    const result = await response.json(); if(!response.ok) throw new Error(result.detail || 'Kunne ikke forbinde.');
    session = result; sessionStorage.setItem('fjordflix-remote',JSON.stringify(session)); connectSocket();
  } catch(error) { showError(error.message); el('connect').disabled = false; }
};
if(session) connectSocket();
el('disconnect').onclick = () => { deliberate = true; socket?.close(); sessionStorage.removeItem('fjordflix-remote'); session = null; showError('Telefonen er afbrudt. Scan en ny QR-kode for at forbinde igen.'); el('connect').disabled = true; };
el('click').onclick = () => send({type:'click'});
document.querySelectorAll('[data-command]').forEach(button => button.onclick = () => {
  const kind = button.dataset.command, delta=Number(button.dataset.delta);
  send(kind === 'scroll' ? {type:kind,dy:delta} : {type:kind,delta});
});
el('remote-search').onsubmit = event => { event.preventDefault(); send({type:'search',text:el('search-text').value}); el('search-text').blur(); };
const pad = el('touchpad'), points = new Map();
let pendingX=0,pendingY=0,pendingScroll=0,startTime=0,distance=0,multi=false;
function averageY() { return [...points.values()].reduce((n,p)=>n+p.y,0)/points.size; }
pad.addEventListener('pointerdown',event => {
  event.preventDefault(); pad.setPointerCapture(event.pointerId);
  if(!points.size) {startTime=Date.now();distance=0;multi=false;}
  points.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(points.size>1) multi=true;
  pad.classList.add('touching');
});
pad.addEventListener('pointermove',event => {
  const previous=points.get(event.pointerId); if(!previous) return;
  event.preventDefault(); const oldAverage=averageY();
  const dx=event.clientX-previous.x,dy=event.clientY-previous.y;
  points.set(event.pointerId,{x:event.clientX,y:event.clientY}); distance+=Math.abs(dx)+Math.abs(dy);
  if(points.size>1) pendingScroll+=(oldAverage-averageY())*3;
  else if(!multi) {const speed=Number(el('sensitivity').value); pendingX+=dx*speed; pendingY+=dy*speed;}
});
function flush() {
  if(pendingX||pendingY) send({type:'move',dx:pendingX,dy:pendingY});
  if(pendingScroll) send({type:'scroll',dy:pendingScroll});
  pendingX=pendingY=pendingScroll=0;
}
function endPointer(event) {
  if(!points.has(event.pointerId)) return;
  points.delete(event.pointerId);
  if(!points.size) {
    flush(); pad.classList.remove('touching');
    if(event.type === 'pointerup' && !multi && distance<9 && Date.now()-startTime<450) send({type:'click'});
  }
}
pad.addEventListener('pointerup',endPointer); pad.addEventListener('pointercancel',endPointer);
pad.addEventListener('contextmenu',e=>e.preventDefault());
pad.addEventListener('keydown',event => {
  const moves={ArrowUp:[0,-30],ArrowDown:[0,30],ArrowLeft:[-30,0],ArrowRight:[30,0]};
  if(moves[event.key]) {event.preventDefault();send({type:'move',dx:moves[event.key][0],dy:moves[event.key][1]});}
  else if(event.key==='Enter'||event.key===' ') {event.preventDefault();send({type:'click'});}
});
sendTimer=setInterval(flush,33); heartbeat=setInterval(()=>send({type:'ping'}),10000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden && session && socket?.readyState===WebSocket.CLOSED) {retry=0;connectSocket();}});
addEventListener('pagehide',()=>{deliberate=true;socket?.close();});
addEventListener('pageshow',event=>{if(event.persisted && session) {deliberate=false;connectSocket();}});
