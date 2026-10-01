(() => {
  const dialog = $('admin-dialog');
  let folder = '', timer, browsing = false;
  const fail = error => { $('source-error').textContent = error.message; };
  async function loadSources() {
    clearTimeout(timer);
    try {
      const data = await api('/admin/library');
      $('source-list').replaceChildren();
      for (const source of data.sources) {
        const row = document.createElement('div'); row.className = 'source-row';
        const info = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = source.path;
        const status = document.createElement('p'); status.className = source.available ? 'muted' : 'error';
        status.textContent = `${source.count} titler · ${source.available ? 'Tilgængelig' : 'Lager ikke tilgængeligt'}`;
        info.append(title, status);
        const remove = document.createElement('button'); remove.className = 'secondary small';
        remove.textContent = 'Fjern'; remove.disabled = data.scan.running;
        remove.setAttribute('aria-label', `Fjern mappen ${source.path}`);
        remove.onclick = async () => {
          if (!confirm(`Fjern “${source.path}” og dens titler, favoritter og afspilningshistorik fra FjordFlix? Originalfilerne på drevet bevares.`)) return;
          remove.disabled = true;
          try { await api(`/admin/library/${source.id}`, 'DELETE'); await loadSources(); await refresh(); }
          catch (error) { fail(error); remove.disabled = false; }
        };
        row.append(info, remove); $('source-list').append(row);
      }
      if (!data.sources.length) {
        const empty = document.createElement('p'); empty.className = 'source-empty';
        empty.textContent = 'Ingen biblioteksmapper endnu. Tilføj fx en mappe til film og en til serier.';
        $('source-list').append(empty);
      }
      $('source-scan').disabled = data.scan.running || !data.sources.length;
      $('source-status').textContent = `${data.scan.running ? 'Scanner i baggrunden — du kan lukke indstillingerne.' : 'Scanning afsluttet.'} ${data.scan.added} nye titler · ${data.scan.updated} opdaterede.`;
      if (data.scan.errors.length) $('source-status').textContent += ` Problemer: ${data.scan.errors.join(' · ')}`;
      if (data.scan.running && dialog.open) timer = setTimeout(loadSources, 2000);
      else if (!data.scan.running) await refresh();
    } catch (error) { fail(error); }
  }
  async function browse(path = '') {
    if (browsing) return;
    browsing = true; $('source-select').disabled = true;
    $('source-error').textContent = '';
    try {
      const data = await api(`/admin/library/browse?path=${encodeURIComponent(path)}`);
      folder = data.path; $('source-picker').hidden = false;
      $('source-path').textContent = folder || 'Tilgængelige biblioteksdrev';
      $('source-up').disabled = data.parent === null;
      $('source-up').onclick = () => browse(data.parent);
      $('source-directories').replaceChildren();
      for (const entry of data.directories) {
        const button = document.createElement('button'); button.className = 'source-directory';
        button.textContent = `▸ ${entry.name}`; button.onclick = () => browse(entry.path);
        $('source-directories').append(button);
      }
      if (!data.directories.length) $('source-directories').textContent = folder
        ? 'Ingen undermapper. Du kan tilføje denne mappe.'
        : 'Ingen biblioteksdrev er tilgængelige. Se vejledningen nedenfor om Proxmox-drev.';
      if (data.truncated) $('source-error').textContent = 'Der vises højst 1.000 undermapper. Opdel store samlinger i flere mapper.';
    } catch (error) { folder = ''; fail(error); }
    finally { browsing = false; $('source-select').disabled = !folder; }
  }
  $('source-browse').onclick = () => browse();
  $('source-proxmox').onclick = async () => {
    $('source-proxmox').disabled = true;
    $('proxmox-inventory').hidden = false;
    $('proxmox-status').textContent = 'Henter storage-pools, diske og partitioner fra Proxmox…';
    $('proxmox-selection').textContent = '';
    $('proxmox-guide').hidden = true;
    for (const id of ['proxmox-storages', 'proxmox-disks', 'proxmox-mounts']) $(id).replaceChildren();
    const size = value => value ? `${(value / 1024 ** 3).toLocaleString('da-DK', {maximumFractionDigits: 1})} GiB` : 'Ukendt størrelse';
    function entry(container, title, description, directories, reason, commands = '') {
      const row = document.createElement('div'); row.className = 'source-row';
      const info = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = title;
      const detail = document.createElement('p'); detail.className = 'muted'; detail.textContent = description;
      info.append(name, detail); row.append(info);
      const actions = document.createElement('div'); actions.className = 'proxmox-actions';
      if (directories.length) {
        for (const directory of directories) {
          const button = document.createElement('button'); button.className = 'secondary small';
          button.textContent = directories.length === 1 ? 'Vælg mappe' : directory.name;
          button.onclick = async () => {
            await browse(directory.path);
            $('source-picker').scrollIntoView({block: 'nearest', behavior: 'smooth'});
          };
          actions.append(button);
        }
      } else {
        const button = document.createElement('button'); button.className = 'secondary small';
        button.textContent = 'Vis tilslutning';
        button.onclick = () => {
          $('proxmox-guide').hidden = !commands;
          $('proxmox-commands').textContent = commands;
          $('proxmox-selection').textContent = `${title}: ${reason} Del mediemappen med FjordHubs LXC under /mnt, og genstart FjordFlix, så den bliver synlig. Klik derefter på Proxmox-diske og storage igen.`;
          $('proxmox-selection').scrollIntoView({block: 'nearest', behavior: 'smooth'});
        };
        actions.append(button);
      }
      row.append(actions); $(container).append(row);
    }
    try {
      const data = await api('/admin/library/proxmox');
      $('proxmox-status').textContent = data.errors.length ? data.errors.join(' ') : `Forbundet til Proxmox · LXC ${data.ctid}. Vælg en mediemappe fra et tilgængeligt lager.`;
      for (const storage of data.storages) entry('proxmox-storages', storage.id,
        `${storage.type} · ${size(storage.total_bytes)} · ${size(storage.free_bytes)} ledigt · ${storage.directories.length ? 'Klar til valg' : storage.online ? 'Kræver tilslutning' : 'Offline'}`,
        storage.directories, storage.reason + (storage.path ? ` Sti på Proxmox: ${storage.path}.` : ''), storage.commands);
      for (const disk of data.disks) entry('proxmox-disks', disk.devpath,
        `${disk.parent ? 'Partition' : disk.model || disk.type || 'Disk'} · ${size(disk.size)} · ${disk.used || 'Intet filsystem oplyst'} · ${disk.mounted ? 'Monteret på Proxmox' : 'Ikke monteret på Proxmox'}`,
        disk.directories, disk.reason);
      for (const mount of data.mounts) entry('proxmox-mounts', mount.path, mount.source,
        mount.local_path ? [{name: mount.path, path: mount.local_path}] : [], 'Mappen er konfigureret i LXC, men er ikke tilgængelig i FjordFlix endnu.');
    } catch (error) { $('proxmox-status').textContent = error.message; }
    finally { $('source-proxmox').disabled = false; }
  };
  $('source-picker-close').onclick = () => { $('source-picker').hidden = true; $('source-browse').focus(); };
  $('source-select').onclick = async () => {
    $('source-select').disabled = true; $('source-error').textContent = '';
    try {
      const added = await api('/admin/library', 'POST', {path: folder});
      $('source-picker').hidden = true;
      toast('Mappen er tilføjet. Originalfilerne bliver på drevet.');
      if (!added.queued) {
        try { await api('/admin/library/scan', 'POST'); }
        catch (error) { fail(error); }
      }
      await loadSources();
    } catch (error) { fail(error); }
    finally { $('source-select').disabled = !folder; }
  };
  $('source-scan').onclick = async () => {
    $('source-scan').disabled = true; $('source-error').textContent = '';
    try { await api('/admin/library/scan', 'POST'); }
    catch (error) { fail(error); }
    await loadSources();
  };
  for (const button of dialog.querySelectorAll('[data-settings-tab]')) {
    button.onclick = () => {
      const name = button.dataset.settingsTab;
      dialog.querySelectorAll('[data-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== name; });
      dialog.querySelectorAll('[data-settings-tab]').forEach(tab => {
        tab.classList.toggle('active', tab === button);
        if (tab === button) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
      });
      if (name === 'library') loadSources();
      if (name === 'media') loadMediaSettings();
      if (name === 'metadata') loadMetadataSettings();
      if (name === 'subtitles') window.loadSubtitleSettings();
    };
  }
  // Observe showModal as admin data is loaded asynchronously by the existing UI.
  new MutationObserver(() => {
    if (dialog.open) {
      dialog.querySelector('[data-settings-tab].active').click();
    } else clearTimeout(timer);
  }).observe(dialog, {attributes: true, attributeFilter: ['open']});
})();
