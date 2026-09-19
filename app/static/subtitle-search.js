/* Provider credentials stay on the server. Only administrators spend its quota. */
(() => {
  const button = document.createElement('button');
  button.className = 'secondary'; button.textContent = 'Undertekster · OpenSubtitles';
  $('media-settings-open').after(button);
  const showStatus = data => {
    $('os-status').textContent = data.configured ? `Tilsluttet som ${data.username}. Hentede undertekster gemmes lokalt.` : 'OpenSubtitles er ikke tilsluttet.';
    $('os-disconnect').disabled = !data.configured;
  };
  const clearSecrets = () => { $('os-key').value = ''; $('os-password').value = ''; };
  button.onclick = async () => {
    try {
      const data = await api('/admin/opensubtitles'); showStatus(data);
      clearSecrets(); $('os-username').value = data.username; $('os-error').textContent = '';
      $('admin-dialog').close(); $('os-settings').showModal();
    } catch(e) { toast(e.message); }
  };
  $('os-settings').addEventListener('close',clearSecrets);
  $('os-close').onclick = () => $('os-settings').close();
  $('os-form').onsubmit = async event => {
    event.preventDefault(); $('os-save').disabled = true; $('os-error').textContent = 'Tester forbindelsen…';
    try {
      showStatus(await api('/admin/opensubtitles','PUT',{api_key:$('os-key').value.trim(),username:$('os-username').value.trim(),password:$('os-password').value}));
      clearSecrets(); $('os-error').textContent = ''; toast('OpenSubtitles er tilsluttet.');
    } catch(e) { $('os-error').textContent = e.message; }
    finally { $('os-save').disabled = false; }
  };
  $('os-disconnect').onclick = async () => {
    try { showStatus(await api('/admin/opensubtitles','DELETE')); clearSecrets(); }
    catch(e) { $('os-error').textContent = e.message; }
  };
  let movie = null, generation = 0, downloading = false;
  $('subtitle-find').onclick = () => {
    movie = selected; ++generation;
    $('subtitle-search-title').textContent = `Find undertekster · ${movie.title}`;
    $('subtitle-results').replaceChildren(); $('subtitle-search-status').textContent = 'Vælg sprog og søg. Downloads bruger din OpenSubtitles-kvote.';
    $('subtitle-language').value = 'da'; $('subtitle-search-dialog').showModal();
  };
  $('subtitle-search-close').onclick = () => $('subtitle-search-dialog').close();
  $('subtitle-search-dialog').addEventListener('close',()=>{++generation;});
  $('subtitle-search-form').onsubmit = async event => {
    event.preventDefault(); if (downloading) return;
    const run = ++generation, target = movie;
    $('subtitle-results').replaceChildren(); $('subtitle-search-status').textContent = 'Søger hos OpenSubtitles…'; $('subtitle-search-submit').disabled = true;
    try {
      const data = await api(`/movies/${target.id}/subtitle-search?language=${encodeURIComponent($('subtitle-language').value)}`);
      if (run !== generation) return;
      $('subtitle-search-status').textContent = data.results.length ? data.message : 'Ingen undertekster fundet på det valgte sprog. Prøv et andet sprog, eller kontrollér filmoplysningerne.';
      for (const item of data.results) {
        const row = document.createElement('article'); row.className = 'subtitle-result';
        const label = document.createElement('strong'); label.textContent = item.release || 'Ukendt udgave';
        const info = document.createElement('p'); info.className = 'fine';
        info.textContent = [item.hash_match ? 'Match på filmfilens fingeraftryk' : 'Kontrollér udgave og timing', item.forced ? 'Kun tvungne undertekster' : '', item.hearing_impaired ? 'Hørehæmmede' : ''].filter(Boolean).join(' · ');
        const download = document.createElement('button'); download.className = 'secondary';
        download.textContent = item.downloaded ? 'Allerede hentet' : 'Hent SRT'; download.disabled = item.downloaded;
        download.onclick = async () => {
          if (downloading) return;
          downloading = true; download.disabled = true; $('subtitle-search-submit').disabled = true;
          $('subtitle-search-status').textContent = 'Henter og gemmer underteksten…';
          try {
            const result = await api(`/movies/${target.id}/subtitle-download`,'POST',{choice:item.choice});
            target.tracks = await api(`/movies/${target.id}/tracks`);
            if (selected?.id === target.id) {
              selected.tracks = target.tracks; FjordTracks.movie = selected;
              FjordTracks.subtitle = result.index; FjordTracks.fill(target.tracks); await updatePlan();
              $('track-status').textContent = `${(target.tracks.audio || []).length} lydspor · ${target.tracks.subtitles.length} undertekstspor`;
            }
            if (run !== generation) return;
            download.textContent = 'Gemt lokalt';
            $('subtitle-search-status').textContent = 'Underteksten er gemt og valgt. Den kan også vælges i TV-appen.' + (Number.isInteger(result.remaining) ? ` ${result.remaining} downloads tilbage i kvoten.` : '');
          } catch(e) {
            if (run === generation) { $('subtitle-search-status').textContent = e.message; download.disabled = false; }
          } finally { downloading = false; $('subtitle-search-submit').disabled = false; }
        };
        row.append(label,info,download); $('subtitle-results').append(row);
      }
    } catch(e) { if (run === generation) $('subtitle-search-status').textContent = e.message; }
    finally { $('subtitle-search-submit').disabled = false; }
  };
})();
