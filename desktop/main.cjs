const {app, BrowserWindow, ipcMain, Menu, dialog, shell} = require('electron');
const {spawn} = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {serverUrl, selection, mediaUrl} = require('./validation.cjs');
const {createUpdates} = require('./updates.cjs');
const {createDiagnostics, clean} = require('./playback-diagnostics.cjs');
if (!app.isPackaged && process.env.FJORDFLIX_TEST_PROFILE) app.setPath('userData', process.env.FJORDFLIX_TEST_PROFILE);
let win, origin = '', active, launching = false;
let lastDiagnostics;
function saveDiagnostics(run) {
  lastDiagnostics = run.diagnostics?.snapshot();
  if (!lastDiagnostics) return;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'playback-diagnostics.json'), JSON.stringify(lastDiagnostics, null, 2)); }
  catch (error) { console.warn('Playback diagnostics could not be saved:', error.code); }
}
function playbackFailure(run, detail) {
  if (run.finished || run.failureShown) return;
  run.failureShown = true;
  run.diagnostics.record('failure', detail);
  saveDiagnostics(run);
  if (!win.isDestroyed()) dialog.showMessageBox(win, {type:'error', message:'Filmen kunne ikke afspilles.',
    detail:clean(detail) + '\nDu kan gemme fejloplysninger via FjordFlix → Gem afspilningsdiagnostik.'});
}
const setup = pathToFileURL(path.join(__dirname, 'setup.html')).href;
const configPath = () => path.join(app.getPath('userData'), 'server.json');
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');
function previousFullscreen() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath(),'utf8'));
    return typeof state.fullscreen === 'boolean' ? state.fullscreen : true;
  } catch { return true; }
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(windowStatePath(),JSON.stringify({fullscreen:win.isFullScreen()})); }
  catch (error) { console.warn('Window preference could not be saved:',error.code); }
}
function trusted(event, local = false) {
  const frame = event.senderFrame;
  return event.sender === win.webContents && frame === win.webContents.mainFrame &&
    (local ? frame.url === setup : origin && new URL(frame.url).origin === origin);
}
async function api(route, data) {
  const response = await win.webContents.session.fetch(origin + '/api' + route, {
    method: 'POST', credentials:'include', redirect: 'error', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data), signal:AbortSignal.timeout(15000)
  });
  if (!response.ok) throw Error(response.status === 401 ? 'Log ind på FjordFlix igen.' : `Serveren svarede ${response.status}. Opdater FjordFlix-serveren og prøv igen.`);
  return response.json();
}
async function finish(run) {
  if (run.finished) return;
  saveDiagnostics(run);
  run.finished = true; run.previews?.dispose(); clearInterval(run.timer); clearTimeout(run.statusTimer); run.socket?.destroy();
  if (run.playbackId) await api(`/playbacks/${run.playbackId}/stop`, {}).catch(()=>{});
  if (active === run) active = null;
  if (Number.isFinite(run.position)) await api(`/movies/${run.id}/progress`, {position:run.position}).catch(()=>{});
  await api('/media/revoke', {ticket:run.ticket}).catch(()=>{});
  if (!win.isDestroyed()) { win.show(); win.focus(); win.webContents.send('native-ended'); }
}
async function play(data) {
  if (active || launching) throw Error('Luk den aktuelle film, før du starter en ny.');
  launching = true;
  try {
    const chosen = selection(data);
    const result = await api(`/desktop/movies/${chosen.id}/play`, chosen);
    const run = {id:chosen.id, ticket:result.media_ticket, position:chosen.start, playbackId:result.playback_id, status:{}}; active = run;
    run.diagnostics = createDiagnostics({version:app.getVersion(), title:result.title, start:result.start});
    const report = () => run.playbackId && !run.finished ? api(`/playbacks/${run.playbackId}/heartbeat`, {
      position:run.position, state:run.status['paused-for-cache'] ? 'buffering' : run.status.pause ? 'paused' : 'playing',
      ...Object.fromEntries([['aid','audio_ordinal'],['sid','subtitle_ordinal']].flatMap(([key,name]) =>
        run.status[key] === false ? [[name,0]] : Number.isInteger(run.status[key]) ? [[name,run.status[key]]] : []))
    }).catch(()=>{}) : Promise.resolve();
    try {
      const url = mediaUrl(result.url, origin);
      const sub = result.subtitle_url ? mediaUrl(result.subtitle_url, origin) : null;
      const pipe = '\\\\.\\pipe\\fjordflix-' + crypto.randomUUID();
      const executable = path.join(app.isPackaged ? process.resourcesPath : __dirname + '/vendor', 'mpv', 'mpv.exe');
      const child = spawn(executable, ['--no-config','--load-scripts=no','--ytdl=no','--idle=yes','--force-window=yes',
        ...require('./subtitle-options.cjs'),
        ...require('./audio-options.cjs'),
        '--fullscreen=yes','--window-dragging=no','--input-builtin-dragging=no',
        '--hwdec=auto-safe','--vo=gpu-next','--gpu-api=d3d11','--target-colorspace-hint=yes',
        '--title=FjordFlix','--osc=no','--osd-color=#FFFFFF','--osd-border-color=#101014',
        '--script='+path.join(app.isPackaged ? process.resourcesPath : __dirname, 'player.lua'),
        '--input-ipc-server='+pipe],
        {windowsHide:true, stdio:'ignore'});
      run.child = child;
      let startError;
      child.once('error', error => { startError = error; playbackFailure(run, 'Afspilleren kunne ikke startes (' + error.code + ').'); finish(run); });
      child.once('exit', (code, signal) => {
        run.diagnostics.record('process-exit', `code=${code}, signal=${signal}`);
        if (code && !run.finished) playbackFailure(run, 'Afspilleren lukkede med fejlkode ' + code + '.');
        finish(run);
      });
      const socket = await new Promise((resolve,reject) => {
        const deadline = Date.now()+10000;
        function connect() {
          if (startError || run.finished || Date.now()>deadline) return reject(Error('Afspilleren kunne ikke starte. Geninstaller FjordFlix-appen.'));
          const s = net.connect(pipe);
          s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
          s.once('error', () => { s.destroy(); setTimeout(connect,100); });
        } connect();
      });
      run.socket = socket;
      const command = (command, request_id) => { if (!socket.destroyed) socket.write(JSON.stringify({command,request_id})+'\n'); };
      const audioFallback = require('./audio-fallback.cjs').createAudioFallback({
        send:command, record:run.diagnostics.record, audio:result.audio
      });
      run.previews = require('./previews.cjs').createPreviews({executable,url,send:command});
      socket.on('error', () => child.kill());
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 1024*1024) { child.kill(); return; }
        let end;
        while ((end=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,end); buffer=buffer.slice(end+1);
          let message; try { message=JSON.parse(line); } catch { continue; }
          const failure = run.diagnostics.receive(message) || audioFallback.receive(message);
          if (failure) { playbackFailure(run, failure); command(['quit']); }
          if (message.event === 'client-message' && message.args?.[0] === 'fjord-preview-request') run.previews.request(message.args[1],message.args[2]);
          if (message.event === 'property-change' && message.name === 'time-pos' && Number.isFinite(message.data)) run.position=message.data;
          if (message.event === 'property-change' && ['pause','paused-for-cache','aid','sid'].includes(message.name)) {
            run.status[message.name]=message.data;
            clearTimeout(run.statusTimer); run.statusTimer=setTimeout(report,200);
          }
          if (message.event === 'file-loaded' && sub) command(['sub-add',sub,'select']);
          if (message.event === 'end-file') {
            if (['eof','error'].includes(message.reason)) command(['quit']);
          }
        }
      });
      command(['observe_property',1,'time-pos']);
      command(['request_log_messages','warn']);
      ['demuxer-cache-duration','cache-speed','seeking'].forEach((name,i)=>command(['observe_property',i+20,name]));
      ['pause','paused-for-cache','aid','sid'].forEach((name,i)=>command(['observe_property',i+2,name]));
      command(['script-message','fjord-title',String(result.title || 'FjordFlix')]);
      command(['loadfile',url,'replace',-1,{start:String(result.start),aid:String(result.audio),sid:String(result.subtitle)}],100);
      run.timer = setInterval(async () => {
        try {
          await api('/media/heartbeat',{ticket:run.ticket});
          await api(`/movies/${run.id}/progress`,{position:run.position});
          await report();
        } catch (error) { playbackFailure(run, 'Forbindelsen til serveren blev afbrudt: ' + error.message); child.kill(); }
      },15000);
      return {ok:true};
    } catch (error) { run.child?.kill(); await finish(run); throw error; }
  } finally { launching=false; }
}
app.whenReady().then(async () => {
  win = new BrowserWindow({width:1440,height:940,minWidth:800,minHeight:600,backgroundColor:'#101014',
    fullscreen:previousFullscreen(),autoHideMenuBar:true,
    show:app.isPackaged || !process.env.FJORDFLIX_TEST_PROFILE,
    icon:path.join(__dirname,'assets/icon.ico'),title:'FjordFlix',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.on('close',saveWindowState);
  win.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  const updates = createUpdates({app, updater:require('electron-updater').autoUpdater, dialog, window:win, playing:()=>!!active || launching});
  ipcMain.handle('check-updates', event => {
    if (!trusted(event) && !trusted(event,true)) throw Error('Ikke tilladt.');
    return updates.check();
  });
  ipcMain.handle('toggle-fullscreen', event => {
    if (!trusted(event)) throw Error('Ikke tilladt.');
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });
  ipcMain.handle('get-fullscreen', event => {
    if (!trusted(event)) throw Error('Ikke tilladt.');
    return win.isFullScreen();
  });
  for (const event of ['enter-full-screen', 'leave-full-screen']) {
    win.on(event, () => { saveWindowState(); win.webContents.send('fullscreen-changed', win.isFullScreen()); });
  }
  win.webContents.setWindowOpenHandler(({url})=>{
    const target=new URL(url);
    if (['https:','http:'].includes(target.protocol) && !target.username && !target.password) shell.openExternal(target.href);
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url)=> { if (url !== setup && (!origin || new URL(url).origin !== origin)) event.preventDefault(); });
  win.webContents.on('will-redirect',(event,url)=> { if (!origin || new URL(url).origin !== origin) event.preventDefault(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'FjordFlix',submenu:[
    {label:'Søg efter opdateringer…',click:()=>updates.check()},
    {label:'Gem afspilningsdiagnostik…',click:async()=>{
      const diagnostics = active?.diagnostics?.snapshot() || lastDiagnostics;
      if (!diagnostics) { await dialog.showMessageBox(win,{message:'Start en film først for at indsamle fejloplysninger.'}); return; }
      const result = await dialog.showSaveDialog(win,{defaultPath:'FjordFlix-afspilningsdiagnostik.json',filters:[{name:'JSON',extensions:['json']}]});
      if (!result.canceled && result.filePath) {
        try { fs.writeFileSync(result.filePath,JSON.stringify(diagnostics,null,2)); }
        catch { await dialog.showMessageBox(win,{type:'error',message:'Fejloplysningerne kunne ikke gemmes.'}); }
      }
    }},
    {label:'Skift server',click:()=>{ if(active || launching) return; win.loadURL(setup); }},
    {label:'Genindlæs',role:'reload'}, {type:'separator'}, {label:'Afslut',role:'quit'}
  ]},{label:'Vis',submenu:[{role:'togglefullscreen'},{role:'zoomIn'},{role:'zoomOut'},{role:'resetZoom'}]}]));
  ipcMain.handle('connect',async (event,value)=> {
    if (!trusted(event,true)) throw Error('Ikke tilladt.');
    const next=serverUrl(value);
    const check=await win.webContents.session.fetch(next+'/api/state',{redirect:'error',signal:AbortSignal.timeout(10000)});
    if (!check.ok || !(check.headers.get('content-type')||'').includes('application/json')) throw Error('Adressen svarede ikke som en FjordFlix-server.');
    origin=next; fs.writeFileSync(configPath(),JSON.stringify({origin}));
    await win.loadURL(origin);
  });
  ipcMain.handle('native-play',(event,data)=> { if (!trusted(event)) throw Error('Ikke tilladt.'); return play(data); });
  try { origin=serverUrl(JSON.parse(fs.readFileSync(configPath(),'utf8')).origin); await win.loadURL(origin); }
  catch { await win.loadURL(setup); }
  win.on('closed',()=>active?.child?.kill());
  let closing = false;
  win.on('close', event => {
    if (!active || closing) return;
    event.preventDefault(); closing = true;
    const run = active;
    finish(run).finally(() => { run.child?.kill(); win.close(); });
  });
});
app.on('window-all-closed',()=>app.quit());
