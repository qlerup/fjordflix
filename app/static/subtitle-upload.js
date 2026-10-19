(() => {
  const el = id => document.getElementById(id);
  const dialog = el('subtitle-upload-dialog');
  const mobile = window.matchMedia('(max-width: 600px)');
  const languages = {und:'Ukendt sprog',da:'Dansk',en:'Engelsk',sv:'Svensk',no:'Norsk',fi:'Finsk',de:'Tysk',fr:'Fransk',es:'Spansk',it:'Italiensk',pt:'Portugisisk',nl:'Nederlandsk',pl:'Polsk',is:'Islandsk',ar:'Arabisk',ja:'Japansk',ko:'Koreansk',zh:'Kinesisk',ru:'Russisk',uk:'Ukrainsk',tr:'Tyrkisk',he:'Hebraisk'};
  let target = null, place = 'detail', queue = [], busy = false;
  function message(text, error = false) {
    el('subtitle-upload-status').textContent = text;
    el('subtitle-upload-status').classList.toggle('error', error);
  }
  function render() {
    el('subtitle-upload-files').replaceChildren(...queue.map(item => {
      const row = document.createElement('li'); row.className = 'subtitle-upload-file';
      const info = document.createElement('div'), title = document.createElement('strong'), status = document.createElement('span');
      title.textContent = item.file.name;
      status.textContent = item.error || (item.done ? 'Tilføjet' : (item.file.size / 1024).toFixed(1) + ' KiB');
      status.className = item.error ? 'error fine' : 'fine'; info.append(title, status);
      const label = document.createElement('label'); label.textContent = 'Sprog';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Sprog for ' + item.file.name);
      for (const [code, name] of Object.entries(languages)) select.add(new Option(name, code));
      select.value = item.language; select.disabled = busy || item.done;
      select.onchange = () => { item.language = select.value; };
      label.append(select);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button';
      remove.textContent = item.done ? 'Skjul' : 'Fjern'; remove.setAttribute('aria-label', remove.textContent + ' ' + item.file.name); remove.disabled = busy;
      remove.onclick = () => { queue = queue.filter(other => other !== item); render(); };
      row.append(info, label, remove); return row;
    }));
    el('subtitle-upload-save').disabled = busy || !queue.some(item => !item.done);
    el('subtitle-upload-save').textContent = busy ? 'Tilføjer…' : 'Tilføj undertekster';
    for (const id of ['subtitle-upload-close','subtitle-upload-cancel','subtitle-upload-drop']) el(id).disabled = busy;
  }
  function add(files) {
    if (busy) return;
    let rejected = false;
    for (const file of files) {
      if (!/\.srt$/i.test(file.name) || !file.size || file.size > 2 * 1024**2 || queue.length >= 20) { rejected = true; continue; }
      if (queue.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
      const suffix = file.name.replace(/\.srt$/i,'').split(/[. _-]+/);
      const aliases = {dan:'da',dk:'da',danish:'da',eng:'en',english:'en',swe:'sv',nor:'no',nob:'no',fin:'fi',ger:'de',deu:'de',fre:'fr',fra:'fr',spa:'es'};
      while (suffix.length && ['forced','sdh','hi','cc'].includes(suffix.at(-1).toLowerCase())) suffix.pop();
      const last = suffix.at(-1)?.toLowerCase(), guess = aliases[last] || last;
      const code = Object.hasOwn(languages,guess) ? guess : 'und';
      queue.push({file, language:code, done:false});
    }
    message(rejected ? 'Vælg op til 20 SRT-filer på højst 2 MiB hver.' : '', rejected);
    render();
  }
  window.FjordSubtitleUpload = {
    available: () => !mobile.matches,
    open(movie, from = 'detail') {
      if (!movie || !state?.user?.admin || busy || mobile.matches) return;
      target = movie; place = from; queue = [];
      const info = movie.catalog || {};
      const episode = info.media_type === 'tv' && info.season != null && info.episode != null
        ? ` · S${String(info.season).padStart(2,'0')}E${String(info.episode).padStart(2,'0')}` : '';
      el('subtitle-upload-target').textContent = movie.title + episode;
      el('subtitle-upload-input').value = ''; message(''); render(); dialog.showModal();
    }
  };
  mobile.addEventListener('change', () => {
    if (FjordTracks.movie?.tracks) FjordTracks.fill(FjordTracks.movie.tracks);
    if (mobile.matches && !busy) dialog.close();
  });
  const close = () => { if (!busy) dialog.close(); };
  el('subtitle-upload-close').onclick = close; el('subtitle-upload-cancel').onclick = close;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  el('subtitle-upload-drop').onclick = () => el('subtitle-upload-input').click();
  el('subtitle-upload-input').onchange = event => { add(event.target.files); event.target.value = ''; };
  const zone = el('subtitle-upload-drop');
  zone.addEventListener('dragover', event => { event.preventDefault(); if (!busy) zone.classList.add('is-dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('is-dragging'); add(event.dataTransfer.files); });
  dialog.addEventListener('dragover', event => event.preventDefault());
  dialog.addEventListener('drop', event => event.preventDefault());
  el('subtitle-upload-form').onsubmit = async event => {
    event.preventDefault(); if (busy || !target) return;
    busy = true; message('Tilføjer undertekster…'); render();
    let added = null, failed = false;
    try {
      for (const item of queue.filter(item => !item.done)) {
        try {
          const query = new URLSearchParams({filename:item.file.name,language:item.language});
          const response = await fetch(`/api/movies/${encodeURIComponent(target.id)}/subtitle-upload?${query}`, {
            method:'POST',headers:{'Content-Type':'application/octet-stream'},body:item.file});
          const result = await response.json();
          if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Underteksten kunne ikke tilføjes.');
          item.done = true; item.error = ''; added = result.index;
        } catch (error) { item.error = error.message; failed = true; }
        render();
      }
      if (added !== null) {
        const available = await api(`/movies/${target.id}/tracks`);
        target.tracks = available;
        if (FjordTracks.movie?.id === target.id) {
          FjordTracks.movie.tracks = available; FjordTracks.fill(available);
          const control = el(`${place}-subtitle`); control.value = String(added); await control.onchange();
          el('track-status').textContent = `${available.audio?.length || 0} lydspor · ${available.subtitles.length} undertekstspor`;
        }
      }
      if (failed) message('Nogle filer kunne ikke tilføjes. De færdige filer er gemt; ret fejlen og prøv igen.', true);
      else { dialog.close(); toast('Underteksterne er tilføjet.'); }
    } catch (error) { message('Filerne er gemt, men sporlisten kunne ikke opdateres. Åbn filmen igen. ' + error.message, true); }
    finally { busy = false; render(); }
  };
})();
