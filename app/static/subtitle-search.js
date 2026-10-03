/* Provider credentials stay on the server. Only administrators spend its quota. */
(() => {
  let settings = null;
  const providerName = value => value === 'subdl' ? 'SubDL' : 'OpenSubtitles';
  const selectedProvider = () => $('subtitle-provider').value;
  const providerFields = () => {
    const subdl = selectedProvider() === 'subdl';
    $('os-login-fields').hidden = subdl;
    $('os-username').disabled = $('os-password').disabled = subdl;
    $('os-username').value = '';
    $('os-disconnect').disabled = !settings?.configured || selectedProvider() !== settings.provider;
  };
  const showStatus = data => {
    settings = data;
    $('os-status').textContent = data.configured ? `${providerName(data.provider)} er aktiv. ${data.automatic ? 'Automatisk hentning er slået til.' : 'Automatisk hentning er slået fra.'}` : `${providerName(data.provider)} er ikke tilsluttet.`;
    $('os-disconnect').disabled = !data.configured;
    $('subtitle-provider').value = data.provider;
    $('subtitle-automatic').checked = data.automatic;
    $('subtitle-primary-language').value = data.language;
    $('subtitle-fallback-language').value = data.fallback_language;
    providerFields();
  };
  const clearSecrets = () => { $('os-key').value = ''; $('os-password').value = ''; };
  window.loadSubtitleSettings = async () => {
    try {
      const data = await api('/admin/subtitles'); showStatus(data);
      clearSecrets(); $('os-error').textContent = '';

    } catch(e) { toast(e.message); }
  };
  $('admin-dialog').addEventListener('close',clearSecrets);
  $('subtitle-provider').onchange = () => { clearSecrets(); providerFields(); };
  $('os-form').onsubmit = async event => {
    event.preventDefault(); $('os-save').disabled = true; $('os-error').textContent = 'Tester forbindelsen…';
    try {
      showStatus(await api('/admin/subtitles','PUT',{provider:selectedProvider(),automatic:$('subtitle-automatic').checked,
        language:$('subtitle-primary-language').value,fallback_language:$('subtitle-fallback-language').value,
        api_key:$('os-key').value.trim(),username:selectedProvider()==='opensubtitles' ? $('os-username').value.trim() : '',
        password:selectedProvider()==='opensubtitles' ? $('os-password').value : ''}));
      clearSecrets(); $('os-error').textContent = ''; toast('Undertekstindstillingerne er gemt.');
    } catch(e) { $('os-error').textContent = e.message; }
    finally { $('os-save').disabled = false; }
  };
  $('os-disconnect').onclick = async () => {
    try { showStatus(await api('/admin/subtitles','DELETE')); clearSecrets(); }
    catch(e) { $('os-error').textContent = e.message; }
  };
  let movie = null, generation = 0, downloading = false;
  $('subtitle-fetch').onclick = async () => {
    if (downloading || !selected) return;
    const target = selected, button = $('subtitle-fetch');
    downloading = true; button.disabled = true; button.textContent = 'Henter undertekster…';
    $('track-status').textContent = 'Søger med dine gemte sprogindstillinger…';
    try {
      const result = await api(`/movies/${target.id}/subtitle-fetch`,'POST');
      target.subtitle_fetch = result;
      const messages = {
        downloaded:'Underteksten er hentet, gemt og valgt. Kontrollér timing ved afspilning.',
        available:'Filmen har allerede et passende tekstspor. Det er nu valgt.',
        not_found:'Ingen undertekster fundet på dine valgte sprog. Prøv Find undertekster for at søge manuelt.'
      };
      if (result.index !== undefined) {
        target.tracks = await api(`/movies/${target.id}/tracks`);
        if (selected?.id === target.id) {
          selected.tracks = target.tracks; FjordTracks.movie = selected;
          FjordTracks.subtitle = result.index; FjordTracks.fill(target.tracks); await updatePlan();
        }
      }
      if (selected?.id === target.id) $('track-status').textContent = result.message || messages[result.status] || 'Hentningen er afsluttet.';
    } catch(e) { if (selected?.id === target.id) $('track-status').textContent = e.message; }
    finally { downloading = false; button.disabled = false; button.textContent = 'Hent undertekster'; }
  };
  $('subtitle-find').onclick = () => {
    movie = selected; ++generation;
    $('subtitle-search-title').textContent = `Find undertekster · ${movie.title}`;
    $('subtitle-results').replaceChildren(); $('subtitle-search-status').textContent = 'Vælg sprog og søg. Downloads bruger den aktive udbyders kvote.';
    $('subtitle-language').value = 'da'; $('subtitle-search-dialog').showModal();
  };
  $('subtitle-search-close').onclick = () => $('subtitle-search-dialog').close();
  $('subtitle-search-dialog').addEventListener('close',()=>{++generation;});
  $('subtitle-search-form').onsubmit = async event => {
    event.preventDefault(); if (downloading) return;
    const run = ++generation, target = movie;
    $('subtitle-results').replaceChildren(); $('subtitle-search-status').textContent = 'Søger hos den valgte udbyder…'; $('subtitle-search-submit').disabled = true;
    try {
      const data = await api(`/movies/${target.id}/subtitle-search?language=${encodeURIComponent($('subtitle-language').value)}`);
      if (run !== generation) return;
      $('subtitle-search-status').textContent = providerName(data.provider) + ': ' + (data.results.length ? data.message : 'Ingen undertekster fundet på det valgte sprog. Prøv et andet sprog, eller kontrollér filmoplysningerne.');
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
