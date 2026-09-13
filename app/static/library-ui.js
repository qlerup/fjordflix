/* Series grouping stays separate from per-file playback and progress. */
const FjordLibrary = {
  episodes(items, key) {
    return items.filter(m => m.series_key && m.series_key === key).sort((a,b) =>
      a.catalog.season - b.catalog.season || a.catalog.episode - b.catalog.episode || a.title.localeCompare(b.title));
  },
  initial(items) {
    return items.find(m => m.position > 1 && m.position < m.duration - 2)
      || items.find(m => !m.position || m.position < m.duration - 2) || items[0];
  },
  cards(items) {
    const groups = new Set(), cards = [];
    for (const item of items) {
      if (!item.series_key) { cards.push(item); continue; }
      if (groups.has(item.series_key)) continue;
      groups.add(item.series_key);
      const episodes = this.episodes(items, item.series_key), first = this.initial(episodes);
      cards.push({...first, title: first.catalog.series_title, isSeries: true, episodes,
        favorite: episodes.some(m => m.favorite), seasonCount: new Set(episodes.map(m => m.catalog.season)).size});
    }
    return cards;
  },
  matches(item, query) {
    return [item.title, item.catalog?.series_title, item.catalog?.episode_title,
      ...(item.episodes || []).map(m => m.title)].filter(Boolean).join(' ').toLocaleLowerCase('da').includes(query);
  },
  qualityLabels(item) {
    const q = item.quality || {};
    const height = Number(item.height), width = Number(item.width);
    const resolution = height >= 4320 || width >= 7680 ? '8K' : height >= 2160 || width >= 3840 ? '4K'
      : height >= 1080 || width >= 1920 ? '1080p' : height >= 720 || width >= 1280 ? '720p' : height > 0 ? `${height}p` : null;
    const codec = q.audio_codec || item.audio;
    const names = {ac3:'Dolby Digital', eac3:'Dolby Digital Plus', truehd:'Dolby TrueHD', dts:'DTS', aac:'AAC', flac:'FLAC', opus:'Opus', mp3:'MP3'};
    let sound = q.dolby_atmos ? 'Dolby Atmos' : names[codec] || (codec ? codec.toUpperCase() : 'Uden lyd');
    if (codec === 'dts' && /^DTS(?:-HD|:X)/.test(q.audio_profile || '')) sound = q.audio_profile;
    const channels = q.audio_channels;
    const layout = q.audio_layout || '';
    const channelLabel = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo'
      : layout.startsWith('5.1') ? '5.1' : layout.startsWith('7.1') ? '7.1' : channels > 2 ? `${channels} kanaler` : '';
    if (channelLabel && !q.dolby_atmos) sound += ` ${channelLabel}`;
    return [resolution, q.dynamic_range || (item.hdr ? 'HDR' : null), sound].filter(Boolean);
  },
  qualityBadges(item) {
    const labels = this.qualityLabels(item);
    const varies = item.episodes?.some(episode => this.qualityLabels(episode).join('|') !== labels.join('|'));
    return {labels: varies ? [...labels, 'Varierer'] : labels,
      description: `${item.isSeries ? 'Kildekvalitet for det valgte afsnit' : 'Filens kildekvalitet'}: ${labels.join(' · ')}.${varies ? ' Kvaliteten varierer mellem afsnit.' : ''}`};
  },
  code(item) { return `S${String(item.catalog.season).padStart(2,'0')}E${String(item.catalog.episode).padStart(2,'0')}`; },
  artwork(item, kind) { return `/api/movies/${item.id}/${kind}?v=${encodeURIComponent(item.catalog?.artwork_updated || 0)}`; }
};
if (typeof module !== 'undefined') module.exports = FjordLibrary;
const metadataRefreshPending = new Set();
let selectMetadataMatch;

function setupLibraryUI() {
  const seriesTab = document.createElement('button');
  seriesTab.className = 'nav-button'; seriesTab.dataset.view = 'series'; seriesTab.textContent = 'Serier';
  document.querySelector('[data-view="all"]').after(seriesTab);
  $('search').placeholder = 'Søg i film og serier';
  $('search').setAttribute('aria-label', 'Søg i film og serier');
  $('upload-open').textContent = '＋ Upload film / afsnit';
  $('upload-dialog').querySelector('h2').textContent = 'Tilføj film eller afsnit';
  $('upload-dialog').querySelector('p').textContent = 'Serier genkendes fra fx Serietitel 2014 S02E10.mkv. Vælg flere film eller afsnit, eller træk dem ind i feltet nedenfor.';
  $('detail-description').insertAdjacentHTML('beforebegin', `<section id="episode-picker" hidden aria-label="Sæson og afsnit">
    <p id="series-overview" class="muted"></p><div class="episode-carousel-header">
    <label>Sæson<select id="series-season"></select></label>
    <div class="episode-carousel-controls"><button type="button" id="episodes-prev" class="secondary small" aria-label="Scroll til tidligere afsnit" aria-controls="series-episodes">←</button>
    <button type="button" id="episodes-next" class="secondary small" aria-label="Scroll til senere afsnit" aria-controls="series-episodes">→</button></div></div>
    <div id="series-episodes" class="episode-carousel" role="group" aria-label="Afsnit"></div>
    <p class="fine">Kun uploadede afsnit vises. Sæson 0 indeholder specialafsnit.</p></section>`);
  $('favorite-button').insertAdjacentHTML('afterend', '<button id="episode-next" class="secondary" hidden>Næste afsnit →</button><button id="library-edit" class="secondary" hidden>Rediger oplysninger</button>');
  $('detail-description').insertAdjacentHTML('afterend', '<p id="detail-catalog-status" class="fine" role="status" hidden></p>');
  $('detail-catalog-status').insertAdjacentHTML('afterend', '<label id="metadata-search-label" hidden>Søgetitel og startår<input id="metadata-search-title" type="search" maxlength="200" placeholder="Fx Arrow 2012"><span class="fine">Sæson og afsnitsnummer bevares. Tryk Hent oplysninger igen.</span></label>');
  $('metadata-search-label').insertAdjacentHTML('afterend', '<section id="metadata-matches" hidden aria-label="Mulige matches fra TMDB"><p class="fine">Vælg den rigtige film eller serie:</p><div id="metadata-match-list"></div></section>');
  $('library-edit').insertAdjacentHTML('afterend', '<button id="metadata-refresh" class="secondary" hidden>Hent oplysninger igen</button>');
  selectMetadataMatch = async (tmdbId = null) => {
    const mid = selected.id;
    if (metadataRefreshPending.has(mid)) return;
    const query = $('metadata-search-label').hidden ? null : $('metadata-search-title').value.trim();
    if (query === '') { $('metadata-search-title').focus(); return; }
    metadataRefreshPending.add(mid);
    showCatalogStatus(selected);
    try {
      const result = await api(`/movies/${mid}/metadata/refresh`, 'POST', {
        ...(query ? {search_title:query} : {}), ...(tmdbId !== null ? {tmdb_id:tmdbId} : {})});
      await refresh();
      if (selected?.id === mid && $('detail').open) {
        await openDetail(library.find(m => m.id === mid));
      }
      toast(result.message);
    } catch (error) {
      if (selected?.id === mid) $('detail-catalog-status').textContent = error.message;
      toast(error.message);
    } finally {
      metadataRefreshPending.delete(mid);
      if (selected?.id === mid) {
        $('metadata-refresh').disabled = false;
        $('metadata-refresh').textContent = 'Hent oplysninger igen';
        $('metadata-refresh').removeAttribute('aria-busy');
        // Preserve a request error until the user closes the detail or retries.
        if ($('detail-catalog-status').textContent === 'Henter oplysninger, plakat og banner fra TMDB…') showCatalogStatus(selected);
      }
    }
  };
  $('metadata-refresh').onclick = () => selectMetadataMatch();
  setupLibraryDeletion();
  $('series-season').onchange = () => {
    const episodes = FjordLibrary.episodes(library, selected.series_key).filter(m => m.catalog.season === Number($('series-season').value));
    if (episodes.length) openDetail(FjordLibrary.initial(episodes));
  };
  for (const [id, direction] of [['episodes-prev', -1], ['episodes-next', 1]]) {
    $(id).onclick = () => $('series-episodes').scrollBy({left: direction * $('series-episodes').clientWidth * .8,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  }
  $('series-episodes').addEventListener('scroll', updateEpisodeArrows, {passive:true});
  window.addEventListener('resize', updateEpisodeArrows);
  $('series-episodes').addEventListener('keydown', event => {
    const cards = [...$('series-episodes').querySelectorAll('.episode-card')];
    const index = cards.indexOf(event.target);
    if (index < 0) return;
    const next = {ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: cards.length - 1}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, next))].focus();
  });
  $('episode-next').onclick = () => {
    const items = FjordLibrary.episodes(library, selected.series_key), next = items[items.findIndex(m => m.id === selected.id)+1];
    if (next) openDetail(next);
  };
  document.body.insertAdjacentHTML('beforeend', `<dialog id="library-editor" class="compact wide">
    <button class="close" id="library-edit-close" aria-label="Luk redigering">✕</button><h2>Rediger oplysninger</h2>
    <p class="muted">Ændrer denne fil. Videofil og afspilningshistorik bevares. Manuel information overskrives ikke automatisk.</p>
    <form id="library-edit-form"><label>Visningstitel<input id="edit-title" maxlength="160" required></label>
    <label>Type<select id="edit-kind"><option value="movie">Film</option><option value="tv">Serieafsnit</option></select></label>
    <div id="edit-series-fields"><label>Serienavn<input id="edit-series-title" maxlength="160"></label>
    <label>Seriens startår<input id="edit-series-year" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"></label>
    <div class="episode-selectors"><label>Sæson<input id="edit-season" type="number" min="0" max="999" step="1"></label>
    <label>Afsnit<input id="edit-episode" type="number" min="1" max="9999" step="1"></label></div>
    <label>Afsnitstitel<input id="edit-episode-title" maxlength="160"></label>
    <label>Seriebeskrivelse<textarea id="edit-series-overview" maxlength="10000" rows="3"></textarea></label></div>
    <label>Beskrivelse (film / afsnit)<textarea id="edit-overview" maxlength="10000" rows="4"></textarea></label>
    <label>Genrer (kommasepareret)<input id="edit-genres" maxlength="1600"></label>
    <label>Udgivelsesdato<input id="edit-date" type="date"></label>
    <label>Rating (0–10)<input id="edit-rating" type="number" min="0" max="10" step="0.1"></label>
    <section id="edit-audio-languages" aria-label="Sprog på lydspor"></section>
    <label>Erstat cover<input id="edit-poster" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <label>Erstat banner<input id="edit-backdrop" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <p class="fine">Billeder: højst 8 MB / 16 megapixel. Tomme billedfelter beholder eksisterende billeder. Serieændringer gælder dette afsnit; samme serienavn og startår samler lokale afsnit.</p>
    <button id="library-edit-refresh" type="button" class="secondary full">Hent oplysninger igen</button>
    <p class="fine">Søg med titlen og året ovenfor. Et match henter og gemmer oplysninger, cover og banner fra TMDB. Intet match? Ret felterne og prøv igen.</p>
    <p id="library-edit-lookup-status" class="fine" role="status"></p><div id="library-edit-matches"></div>
    <p id="library-edit-error" class="error" role="alert"></p><button id="library-edit-save" class="primary full">Gem ændringer</button></form></dialog>`);
  const toggle = () => {
    const tv = $('edit-kind').value === 'tv'; $('edit-series-fields').hidden = !tv;
    ['edit-series-title','edit-season','edit-episode'].forEach(id => $(id).required = tv);
  };
  $('edit-kind').onchange = toggle;
  function fillEditor() {
    const info = selected.catalog || {};
    $('edit-title').value = selected.title; $('edit-kind').value = info.media_type || 'movie';
    for (const [id,key] of [['series-title','series_title'],['series-year','series_year'],['season','season'],['episode','episode'],['episode-title','episode_title'],['series-overview','series_overview'],['overview','overview'],['date','release_date']]) {
      $(`edit-${id}`).value = info[key] ?? '';
    }
    $('edit-rating').value = info.rating == null ? '' : Number(info.rating).toFixed(1);
    $('edit-genres').value = (info.genres || []).join(', '); toggle();
    const audioFields = $('edit-audio-languages');
    audioFields.replaceChildren();
    for (const [number, track] of (selected.tracks?.audio || []).entries()) {
      const label = document.createElement('label');
      label.textContent = `Sprog på lydspor ${number + 1} · ${track.codec.toUpperCase()}`;
      const input = document.createElement('input'); input.dataset.audioIndex = track.index; input.maxLength = 80;
      const source = track.source_language || track.language || 'und';
      input.placeholder = FjordTracks.language(source);
      const override = selected.audio_language_overrides?.[track.index] || '';
      input.value = override ? FjordTracks.language(override) : '';
      const original = document.createElement('span'); original.className = 'fine';
      original.textContent = `Filens mærkning: ${FjordTracks.language(source)}. Tomt felt bruger filens mærkning.`;
      label.append(input, original); audioFields.append(label);
    }
    if (audioFields.children.length) {
      const hint = document.createElement('p'); hint.className = 'fine';
      hint.textContent = 'Ret sproget, hvis filens mærkning er forkert. Det ændrer kun visningen i FjordFlix; lyd og videofil bevares.';
      audioFields.append(hint);
    }
  }
  $('library-edit').onclick = async () => {
    const movie = selected;
    try {
      if (movie.tracks?.version !== 1) movie.tracks = await api(`/movies/${movie.id}/tracks`);
    } catch (error) { toast(error.message); return; }
    if (selected !== movie) return;
    $('library-edit-form').reset(); $('library-edit-error').textContent = '';
    $('library-edit-lookup-status').textContent = ''; $('library-edit-matches').replaceChildren();
    fillEditor();
    $('detail').close(); $('library-editor').showModal();
  };
  const editorDraft = () => {
    const tv = $('edit-kind').value === 'tv';
    return {
      audio_language_overrides: Object.fromEntries([...$('edit-audio-languages').querySelectorAll('input')].filter(input => input.value.trim()).map(input => [input.dataset.audioIndex, input.value.trim()])),
      title: $('edit-title').value, media_type: tv ? 'tv' : 'movie', overview: $('edit-overview').value,
      genres: $('edit-genres').value.split(',').map(x => x.trim()).filter(Boolean), release_date: $('edit-date').value,
      rating: $('edit-rating').value === '' ? null : Number($('edit-rating').value),
      series_title: tv ? $('edit-series-title').value : '', series_year: tv ? $('edit-series-year').value : '',
      series_overview: tv ? $('edit-series-overview').value : '', episode_title: tv ? $('edit-episode-title').value : '',
      season: tv ? Number($('edit-season').value) : null, episode: tv ? Number($('edit-episode').value) : null
    };
  };
  let editorLookupBusy = false;
  const lookupEditor = async (tmdbId = null) => {
    if (editorLookupBusy || !$('library-edit-form').reportValidity()) return;
    const mid = selected.id, draft = editorDraft();
    editorLookupBusy = true;
    const controls = [...$('library-editor').querySelectorAll('input,select,textarea,button')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => control.disabled = true);
    $('library-edit-refresh').textContent = 'Henter oplysninger…';
    $('library-edit-refresh').setAttribute('aria-busy', 'true');
    $('library-edit-error').textContent = ''; $('library-edit-matches').replaceChildren();
    $('library-edit-lookup-status').textContent = 'Søger i TMDB…';
    try {
      const result = await api(`/movies/${mid}/metadata/refresh`, 'POST', {draft, ...(tmdbId ? {tmdb_id:tmdbId} : {})});
      $('library-edit-lookup-status').textContent = result.message;
      if (result.ok) {
        await refresh(); selected = library.find(movie => movie.id === mid); fillEditor();
      } else {
        $('library-edit-matches').replaceChildren(...(result.candidates || []).map(candidate => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'metadata-match';
          button.textContent = `${candidate.title}${candidate.year ? ' (' + candidate.year + ')' : ''}`;
          button.onclick = () => lookupEditor(candidate.id);
          return button;
        }));
      }
    } catch (error) { $('library-edit-error').textContent = error.message; }
    finally {
      controls.forEach((control, index) => control.disabled = disabled[index]);
      $('library-edit-refresh').textContent = 'Hent oplysninger igen';
      $('library-edit-refresh').removeAttribute('aria-busy'); editorLookupBusy = false;
    }
  };
  $('library-edit-refresh').onclick = () => lookupEditor();
  $('library-editor').addEventListener('cancel', event => { if (editorLookupBusy) event.preventDefault(); });
  $('library-edit-close').onclick = () => { $('library-editor').close(); openDetail(selected); };
  $('library-edit-form').onsubmit = async event => {
    event.preventDefault(); const mid = selected.id;
    if (editorLookupBusy) return;
    $('library-edit-save').disabled = true; $('library-edit-error').textContent = '';
    $('library-edit-refresh').disabled = true;
    let metadataSaved = false;
    try {
      for (const kind of ['poster','backdrop']) {
        const file = $(`edit-${kind}`).files[0];
        if (file && file.size > 8 * 1024**2) throw new Error('Billedet må højst fylde 8 MB.');
      }
      await api(`/movies/${mid}/metadata`, 'PUT', editorDraft());
      metadataSaved = true;
      for (const kind of ['poster','backdrop']) {
        const file = $(`edit-${kind}`).files[0]; if (!file) continue;
        const response = await fetch(`/api/movies/${mid}/artwork/${kind}`, {method:'PUT', body:file});
        if (!response.ok) throw new Error((await response.json()).detail || 'Billedet kunne ikke gemmes.');
        $(`edit-${kind}`).value = '';
      }
      await refresh(); selected = library.find(m => m.id === mid);
      $('library-editor').close(); await openDetail(selected); toast('Oplysningerne er gemt.');
    } catch(e) { $('library-edit-error').textContent = (metadataSaved ? 'Teksten er gemt. ' : '') + e.message; }
    finally { $('library-edit-save').disabled = false; $('library-edit-refresh').disabled = false; }
  };
}

function showEpisodePicker(movie) {
  showCatalogStatus(movie);
  $('library-delete').hidden = !state.user.admin;
  $('library-delete').textContent = movie.series_key ? 'Slet afsnit' : 'Slet film';
  $('library-delete-series').hidden = !state.user.admin || !movie.series_key;
  const episodes = movie.series_key ? FjordLibrary.episodes(library, movie.series_key) : [];
  $('episode-picker').hidden = !episodes.length;
  $('library-edit').hidden = !state.user.admin;
  $('episode-next').hidden = !episodes.length || episodes[episodes.length-1].id === movie.id;
  if (!episodes.length) return;
  $('series-overview').textContent = movie.catalog.series_overview || '';
  const seasons = [...new Set(episodes.map(m => m.catalog.season))];
  $('series-season').replaceChildren(...seasons.map(n => new Option(n === 0 ? 'Specialafsnit' : `Sæson ${n}`, n)));
  $('series-season').value = movie.catalog.season;
  const carousel = $('series-episodes');
  const key = `${movie.series_key}:${movie.catalog.season}`;
  const scrollLeft = carousel.dataset.season === key ? carousel.scrollLeft : 0;
  carousel.dataset.season = key;
  carousel.replaceChildren(...episodes.filter(m => m.catalog.season === movie.catalog.season).map(m => {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'episode-card'; card.dataset.episodeId = m.id;
    card.setAttribute('aria-pressed', String(m.id === movie.id));
    const image = document.createElement('img');
    image.src = FjordLibrary.artwork(m, 'episode-still'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    image.addEventListener('error', () => { image.hidden = true; }, {once:true});
    const title = document.createElement('strong'); title.textContent = `Afsnit ${m.catalog.episode}`;
    const name = document.createElement('span'); name.className = 'episode-name'; name.textContent = m.catalog.episode_title || '';
    const duration = document.createElement('span'); duration.className = 'episode-duration';
    duration.textContent = `${clock(m.duration)}${m.position >= m.duration - 2 ? ' · Set' : m.position > 1 ? ' · Påbegyndt' : ''}`;
    card.append(image, title, name, duration);
    card.onclick = () => {
      openDetail(m);
      // Re-rendering selection must keep keyboard focus on the chosen episode.
      [...carousel.children].find(el => el.dataset.episodeId === m.id)?.focus({preventScroll:true});
    };
    return card;
  }));
  carousel.scrollLeft = scrollLeft;
  requestAnimationFrame(() => {
    const active = carousel.querySelector('[aria-pressed="true"]');
    if (active && (active.offsetLeft < carousel.scrollLeft || active.offsetLeft + active.offsetWidth > carousel.scrollLeft + carousel.clientWidth)) {
      carousel.scrollLeft = active.offsetLeft;
    }
    updateEpisodeArrows();
  });
}

function updateEpisodeArrows() {
  const carousel = $('series-episodes');
  $('episodes-prev').disabled = carousel.scrollLeft <= 1;
  $('episodes-next').disabled = carousel.scrollLeft + carousel.clientWidth >= carousel.scrollWidth - 1;
}

function showCatalogStatus(movie) {
  const pending = metadataRefreshPending.has(movie.id);
  const button = $('metadata-refresh');
  button.hidden = !state.user.admin || !!movie.catalog?.manual;
  button.disabled = pending;
  button.textContent = pending ? 'Henter fra TMDB…' : 'Hent oplysninger igen';
  button.setAttribute('aria-busy', String(pending));
  const status = $('detail-catalog-status');
  status.hidden = !state.user.admin || !!movie.catalog?.manual;
  status.textContent = pending ? 'Henter oplysninger, plakat og banner fra TMDB…' : (movie.catalog?.lookup_message || 'Der er endnu ikke hentet oplysninger fra TMDB.');
  const search = $('metadata-search-title');
  const unmatched = (movie.catalog?.last_lookup?.status || movie.catalog?.status) === 'unmatched';
  $('metadata-search-label').hidden = !state.user.admin || !!movie.catalog?.manual || !unmatched;
  search.disabled = pending;
  if (!pending) search.value = movie.catalog?.lookup_title
    || (movie.catalog?.media_type === 'tv' ? [movie.catalog.series_title, movie.catalog.series_year].filter(Boolean).join(' ')
      : movie.original_title || movie.title);
  const candidates = movie.catalog?.last_lookup?.candidates || movie.catalog?.candidates || [];
  $('metadata-matches').hidden = !state.user.admin || !!movie.catalog?.manual || !unmatched || !candidates.length;
  $('metadata-match-list').replaceChildren(...candidates.map(candidate => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'metadata-match'; button.disabled = pending;
    if (candidate.poster_url) {
      const image = document.createElement('img'); image.src = candidate.poster_url;
      image.alt = ''; image.loading = 'lazy';
      image.addEventListener('error', () => { image.hidden = true; }, {once:true});
      button.append(image);
    }
    const text = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = `${candidate.title}${candidate.year ? ' (' + candidate.year + ')' : ''}`;
    const overview = document.createElement('span'); overview.textContent = candidate.overview;
    text.append(title, overview); button.append(text);
    button.onclick = () => selectMetadataMatch(candidate.id);
    return button;
  }));
}
