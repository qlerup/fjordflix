function setupLibraryDeletion() {
  $('metadata-refresh').insertAdjacentHTML('afterend', '<button id="library-delete" class="secondary" hidden>Slet film</button><button id="library-delete-series" class="secondary" hidden>Slet hele serien</button>');
  document.body.insertAdjacentHTML('beforeend', `<dialog id="library-delete-confirm" class="compact" aria-labelledby="delete-title">
    <h2 id="delete-title">Slet fra biblioteket?</h2><p id="delete-description"></p>
    <p class="muted">Videofiler, billeder, favoritter og afspilningshistorik slettes for alle brugere. Det kan ikke fortrydes.</p>
    <p id="delete-error" class="error" role="alert"></p><div class="hero-actions">
    <button id="delete-cancel" class="secondary">Annuller</button><button id="delete-submit" class="primary">Slet permanent</button></div>
    </dialog>`);
  const dialog = $('library-delete-confirm');
  let pending = null, busy = false;
  function choose(wholeSeries) {
    if (!selected || !state.user.admin) return;
    const items = wholeSeries ? FjordLibrary.episodes(library, selected.series_key) : [selected];
    pending = {mid: selected.id, ids: items.map(item => item.id)};
    $('delete-description').textContent = wholeSeries
      ? `Slet hele “${selected.catalog.series_title}” med ${items.length} afsnit på tværs af alle sæsoner?`
      : `Slet ${selected.series_key ? `afsnit ${selected.catalog.episode} i sæson ${selected.catalog.season} af ` : ''}“${selected.series_key ? selected.catalog.series_title : selected.title}”?`;
    $('delete-error').textContent = '';
    dialog.showModal(); $('delete-cancel').focus();
  }
  $('library-delete').onclick = () => choose(false);
  $('library-delete-series').onclick = () => choose(true);
  $('delete-cancel').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('delete-submit').onclick = async () => {
    if (busy || !pending) return;
    busy = true;
    $('delete-submit').disabled = $('delete-cancel').disabled = true;
    $('delete-submit').textContent = 'Sletter…';
    $('delete-submit').setAttribute('aria-busy', 'true');
    try {
      const result = await api(`/movies/${pending.mid}`, 'DELETE', {ids: pending.ids});
      dialog.close(); $('detail').close(); selected = null;
      library = library.filter(item => !result.deleted.includes(item.id)); render();
      toast(result.deleted.length === 1 ? 'Slettet fra biblioteket.' : `${result.deleted.length} afsnit er slettet.`);
      if (result.cleanup_pending) toast('Fjernet fra biblioteket, men nogle filer kunne ikke ryddes fra disken. Kontakt administratoren.');
      try { await refresh(); } catch (_) { toast('Slettet. Genindlæs siden for at hente resten af biblioteket.'); }
    } catch (error) { $('delete-error').textContent = error.message; }
    finally {
      busy = false; $('delete-submit').disabled = $('delete-cancel').disabled = false;
      $('delete-submit').textContent = 'Slet permanent'; $('delete-submit').removeAttribute('aria-busy');
    }
  };
}
