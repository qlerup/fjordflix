let detailScroll = 0, detailFocus;
function closeDetailPage(updateHistory = true) {
  const page = document.getElementById('detail');
  if (page.hidden) return;
  page.hidden = true;
  document.querySelector('#shell > main').hidden = false;
  document.body.classList.remove('on-detail-page');
  if (updateHistory) history.replaceState(null, '', location.pathname + location.search);
  window.scrollTo(0, detailScroll);
  detailFocus?.isConnected && detailFocus.focus({preventScroll:true});
}
function showDetailPage(movie) {
  const page = $('detail'), wasHidden = page.hidden;
  if (wasHidden) { detailScroll = window.scrollY; detailFocus = document.activeElement; }
  page.hidden = false;
  document.querySelector('#shell > main').hidden = true;
  document.body.classList.add('on-detail-page');
  const hash = '#title/' + movie.id;
  if (location.hash !== hash) history[wasHidden ? 'pushState' : 'replaceState']({detail:true}, '', hash);
  $('detail-poster').src = FjordLibrary.artwork(movie, 'poster');
  $('detail-title').textContent = movie.catalog?.series_title || movie.title;
  let episode = $('detail-episode');
  if (!episode) { episode = document.createElement('p'); episode.id = 'detail-episode'; $('detail-meta').after(episode); }
  episode.hidden = !movie.series_key;
  episode.textContent = movie.series_key ? `${FjordLibrary.code(movie)} · ${movie.catalog.episode_title || 'Afsnit ' + movie.catalog.episode}` : '';
  let tools = $('detail-tools');
  if (!tools) { tools = document.createElement('div'); tools.id = 'detail-tools'; tools.className = 'hero-actions'; document.querySelector('#detail .detail-body').append(tools); }
  for (const id of ['subtitle-find','library-edit','metadata-refresh','library-delete','library-delete-series']) if ($(id)) tools.append($(id));
  $('detail-kind').textContent = movie.series_key ? 'SERIE · FRA DIT BIBLIOTEK' : 'FILM · FRA DIT BIBLIOTEK';
  // Keep episode browsing and the cast rail outside the narrow information column.
  $('detail-extras').prepend($('episode-picker'));
  if (wasHidden) { window.scrollTo(0,0); $('detail-title').focus({preventScroll:true}); }
  loadDetailCast(movie);
}
async function loadDetailCast(movie) {
  const rail = $('detail-cast'); rail.replaceChildren();
  $('cast-status').textContent = 'Henter skuespillere…';
  try {
    const result = await api(`/movies/${movie.id}/credits`);
    if (selected !== movie) return;
    $('cast-status').textContent = result.cast?.length ? '' : 'Der er endnu ingen skuespilleroplysninger for denne titel.';
    for (const actor of result.cast || []) {
      const card = document.createElement('article'); card.className = 'cast-person';
      const portrait = document.createElement('div'); portrait.className = 'cast-portrait';
      portrait.textContent = actor.name.slice(0,1);
      if (actor.profile_url) {
        const img = document.createElement('img'); img.src = actor.profile_url; img.alt = ''; img.loading = 'lazy';
        img.onerror = () => img.remove(); portrait.append(img);
      }
      const name = document.createElement('h3'); name.textContent = actor.name;
      const role = document.createElement('p'); role.textContent = actor.character;
      card.append(portrait,name,role); rail.append(card);
    }
  } catch (_) { if (selected === movie) $('cast-status').textContent = 'Skuespillere kunne ikke hentes lige nu.'; }
}
function restoreDetailRoute() {
  const id = location.hash.match(/^#title\/([a-f0-9]{32})$/)?.[1];
  const movie = library.find(m => m.id === id);
  if (movie) openDetail(movie); else closeDetailPage(false);
}
window.addEventListener('popstate', () => { if (state?.user) restoreDetailRoute(); });
document.addEventListener('click', event => {
  if (event.target.closest('[data-view],.category-link,#sidebar-back')) closeDetailPage();
});

document.getElementById('detail-back').onclick = () => { if (history.state?.detail) history.back(); else closeDetailPage(); };
document.getElementById('search').addEventListener('input', () => closeDetailPage());
