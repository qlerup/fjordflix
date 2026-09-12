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
  code(item) { return `S${String(item.catalog.season).padStart(2,'0')}E${String(item.catalog.episode).padStart(2,'0')}`; },
  artwork(item, kind) { return `/api/movies/${item.id}/${kind}?v=${encodeURIComponent(item.catalog?.artwork_updated || 0)}`; }
};
if (typeof module !== 'undefined') module.exports = FjordLibrary;

function setupLibraryUI() {
  const seriesTab = document.createElement('button');
  seriesTab.className = 'nav-button'; seriesTab.dataset.view = 'series'; seriesTab.textContent = 'Serier';
  document.querySelector('[data-view="all"]').after(seriesTab);
  $('search').placeholder = 'Søg i film og serier';
  $('search').setAttribute('aria-label', 'Søg i film og serier');
  $('upload-open').textContent = '＋ Upload film / afsnit';
  $('upload-dialog').querySelector('h2').textContent = 'Tilføj film eller afsnit';
  $('upload-dialog').querySelector('p').textContent = 'Serier genkendes fra fx Serietitel S02E10.mkv. Upload én fil pr. afsnit.';
  $('detail-description').insertAdjacentHTML('beforebegin', `<section id="episode-picker" hidden aria-label="Sæson og afsnit">
    <p id="series-overview" class="muted"></p><div class="episode-selectors">
    <label>Sæson<select id="series-season"></select></label><label>Afsnit<select id="series-episode"></select></label></div>
    <p class="fine">Kun uploadede afsnit vises. Sæson 0 indeholder specialafsnit.</p></section>`);
  $('favorite-button').insertAdjacentHTML('afterend', '<button id="episode-next" class="secondary" hidden>Næste afsnit →</button><button id="library-edit" class="secondary" hidden>Rediger oplysninger</button>');
  $('series-season').onchange = () => {
    const episodes = FjordLibrary.episodes(library, selected.series_key).filter(m => m.catalog.season === Number($('series-season').value));
    if (episodes.length) openDetail(FjordLibrary.initial(episodes));
  };
  $('series-episode').onchange = () => openDetail(library.find(m => m.id === $('series-episode').value));
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
    <label>Erstat cover<input id="edit-poster" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <label>Erstat banner<input id="edit-backdrop" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <p class="fine">Billeder: højst 8 MB / 16 megapixel. Tomme billedfelter beholder eksisterende billeder. Serieændringer gælder dette afsnit; samme serienavn og startår samler lokale afsnit.</p>
    <p id="library-edit-error" class="error" role="alert"></p><button id="library-edit-save" class="primary full">Gem ændringer</button></form></dialog>`);
  const toggle = () => {
    const tv = $('edit-kind').value === 'tv'; $('edit-series-fields').hidden = !tv;
    ['edit-series-title','edit-season','edit-episode'].forEach(id => $(id).required = tv);
  };
  $('edit-kind').onchange = toggle;
  $('library-edit').onclick = () => {
    const info = selected.catalog || {};
    $('library-edit-form').reset(); $('library-edit-error').textContent = '';
    $('edit-title').value = selected.title; $('edit-kind').value = info.media_type || 'movie';
    for (const [id,key] of [['series-title','series_title'],['series-year','series_year'],['season','season'],['episode','episode'],['episode-title','episode_title'],['series-overview','series_overview'],['overview','overview'],['date','release_date']]) {
      $(`edit-${id}`).value = info[key] ?? '';
    }
    $('edit-rating').value = info.rating == null ? '' : Number(info.rating).toFixed(1);
    $('edit-genres').value = (info.genres || []).join(', '); toggle();
    $('detail').close(); $('library-editor').showModal();
  };
  $('library-edit-close').onclick = () => { $('library-editor').close(); openDetail(selected); };
  $('library-edit-form').onsubmit = async event => {
    event.preventDefault(); const mid = selected.id, tv = $('edit-kind').value === 'tv';
    $('library-edit-save').disabled = true; $('library-edit-error').textContent = '';
    let metadataSaved = false;
    try {
      for (const kind of ['poster','backdrop']) {
        const file = $(`edit-${kind}`).files[0];
        if (file && file.size > 8 * 1024**2) throw new Error('Billedet må højst fylde 8 MB.');
      }
      await api(`/movies/${mid}/metadata`, 'PUT', {
        title: $('edit-title').value, media_type: tv ? 'tv' : 'movie', overview: $('edit-overview').value,
        genres: $('edit-genres').value.split(',').map(x => x.trim()).filter(Boolean), release_date: $('edit-date').value,
        rating: $('edit-rating').value === '' ? null : Number($('edit-rating').value),
        series_title: tv ? $('edit-series-title').value : '', series_year: tv ? $('edit-series-year').value : '',
        series_overview: tv ? $('edit-series-overview').value : '', episode_title: tv ? $('edit-episode-title').value : '',
        season: tv ? Number($('edit-season').value) : null, episode: tv ? Number($('edit-episode').value) : null
      });
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
    finally { $('library-edit-save').disabled = false; }
  };
}

function showEpisodePicker(movie) {
  const episodes = movie.series_key ? FjordLibrary.episodes(library, movie.series_key) : [];
  $('episode-picker').hidden = !episodes.length;
  $('library-edit').hidden = !state.user.admin;
  $('episode-next').hidden = !episodes.length || episodes[episodes.length-1].id === movie.id;
  if (!episodes.length) return;
  $('series-overview').textContent = movie.catalog.series_overview || '';
  const seasons = [...new Set(episodes.map(m => m.catalog.season))];
  $('series-season').replaceChildren(...seasons.map(n => new Option(n === 0 ? 'Specialafsnit' : `Sæson ${n}`, n)));
  $('series-season').value = movie.catalog.season;
  $('series-episode').replaceChildren(...episodes.filter(m => m.catalog.season === movie.catalog.season).map(m =>
    new Option(`${FjordLibrary.code(m)}${m.catalog.episode_title ? ' · '+m.catalog.episode_title : ''} · ${clock(m.duration)}${m.position >= m.duration-2 ? ' · Set' : m.position > 1 ? ' · Påbegyndt' : ''}`, m.id)));
  $('series-episode').value = movie.id;
}
