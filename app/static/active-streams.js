(() => {
  const dialog = $('admin-dialog'), panel = $('active-streams-panel'), list = $('active-streams-list'), status = $('active-streams-status');
  let timer, loading = false;
  const visible = () => dialog.open && !panel.hidden;
  const node = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const codec = value => ({hdmv_pgs_subtitle:'PGS',subrip:'SRT',dvd_subtitle:'VobSub',dvb_subtitle:'DVB',hevc:'HEVC',h264:'H.264'}[value] || value?.toUpperCase() || 'Ukendt');
  const stamp = seconds => { const n = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(n/3600) ? Math.floor(n/3600)+':' : ''}${Math.floor(n/3600) ? String(Math.floor(n/60)%60).padStart(2,'0') : Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`; };
  const track = item => item ? [FjordTracks.language(item.language), item.title, codec(item.codec)].filter(Boolean).join(' · ') : 'Fra';
  function card(s) {
    const article = node('article','stream-card');
    const cover = node('img','stream-cover'); cover.src = s.poster; cover.alt = ''; cover.loading = 'lazy';
    cover.onerror = () => { cover.hidden = true; };
    const art = node('div','stream-art'); art.append(cover);
    const body = node('div','stream-body');
    const heading = node('div','stream-heading');
    heading.append(node('span','stream-user',`${s.user} · ${s.client}`), node('span',`stream-mode ${s.mode === 'Transcoding' ? 'converting' : ''}`,s.mode));
    body.append(heading,node('h3','',s.title));
    const state = {starting:'Starter',playing:'Afspiller',paused:'På pause',buffering:'Bufferer',error:'Afspilningsfejl',connected:'Tilsluttet'}[s.state] || 'Afventer status';
    const percent = s.duration > 0 ? Math.min(100,Math.max(0,s.position/s.duration*100)) : 0;
    const progress = node('progress','stream-progress'); progress.max = 100; progress.value = percent; progress.setAttribute('aria-label',`Afspillet: ${Math.round(percent)} %`);
    body.append(progress,node('p','stream-position',`${state} · ${stamp(s.position)} / ${stamp(s.duration)} · ${Math.round(percent)} %`));
    const details = node('dl','stream-details');
    const detail = (name,value) => { const group=node('div',''); group.append(node('dt','',name),node('dd','',value)); details.append(group); };
    detail('Kvalitet',`${s.height || '?'}p · ${s.mbps || '?'} Mbit/s${s.mode === 'Transcoding' ? ' (mål)' : ' (kilde)'}`);
    detail('Video',`${codec(s.video.source)}${s.video.transcoded ? ' → '+codec(s.video.output)+' · konverteres' : ' · original video'}${s.video.tonemapped ? ' · HDR → SDR' : ''}`);
    detail('Lyd',s.audio ? `${track(s.audio)}${s.audio_transcoded ? ' → AAC · stereo · konverteres' : ' · original lyd'}` : 'Intet lydspor');
    detail('Undertekster',s.subtitle ? `${track(s.subtitle)} · ${{burn:'brændes ind i videoen',local:'vises lokalt',text:'separat tekstspor',hls:'separat HLS-tekstspor'}[s.subtitle_delivery] || 'ukendt levering'}` : 'Fra');
    detail('Behandling',s.encoder);
    if(s.reason) detail('Afspilningsvalg',s.reason);
    body.append(details);
    if(s.limited_status) body.append(node('p','fine','TV’et rapporterer forbindelse og position. Pause og lokale sporskift rapporteres ikke; sporene ovenfor er valgene ved start.'));
    const age = Math.max(0,Math.floor(Date.now()/1000-s.touch));
    if(age>30) body.append(node('p','fine',`Seneste status for ${age} sekunder siden`));
    article.append(art,body); return article;
  }
  window.loadActiveStreams = async () => {
    clearTimeout(timer);
    if(!visible() || loading) return;
    loading = true;
    try {
      const data = await api('/admin/active-streams');
      if(!visible()) return;
      list.replaceChildren(...data.streams.map(card));
      if(!data.streams.length) list.append(node('div','stream-empty','Ingen aktive streams lige nu.'));
      status.textContent = `${data.streams.length} aktive streams · Opdateres automatisk hvert 5. sekund`;
    } catch(error) { if(visible()) { list.replaceChildren(); status.textContent = `Kunne ikke hente aktive streams: ${error.message}`; } }
    finally { loading = false; if(visible()) timer=setTimeout(window.loadActiveStreams,5000); }
  };
  const observer = new MutationObserver(() => { if(!visible()) clearTimeout(timer); });
  observer.observe(dialog,{attributes:true,attributeFilter:['open']});
  observer.observe(panel,{attributes:true,attributeFilter:['hidden']});
})();
