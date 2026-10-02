(() => {
  const dialog = $('admin-dialog');
  let folder = '', timer, poolTimer, poolPending = false, browsing = false;
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
        const reindex = document.createElement('button'); reindex.className = 'secondary small';
        reindex.textContent = 'Genindeksér'; reindex.disabled = data.scan.running || !source.available;
        reindex.setAttribute('aria-label', `Genindeksér mappen ${source.path}`);
        reindex.title = 'Gennemgå alle filer igen og hent oplysninger. Manuelle rettelser bevares.';
        reindex.onclick = async () => {
          reindex.disabled = true; $('source-error').textContent = '';
          try { await api(`/admin/library/${source.id}/reindex`, 'POST'); }
          catch (error) { fail(error); }
          await loadSources();
        };
        const actions = document.createElement('div'); actions.className = 'settings-actions';
        actions.append(reindex, remove);
        row.append(info, actions); $('source-list').append(row);
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
  let writeGuide = null, writeTrigger = null;
  function showWriteGuide(guide, trigger) {
    writeGuide = guide; writeTrigger = trigger;
    $('library-write-acl').checked = false;
    $('library-write-scope').textContent = `Proxmox: ${guide.source} → LXC ${guide.ctid}: ${guide.target}`;
    $('library-write-commands').textContent = guide.commands;
    $('library-write-status').textContent = 'Adgangen er ikke ændret. Kør guiden og kontrollér skrivetestens resultat i Proxmox.';
    $('library-write-guide').hidden = false;
    $('library-write-title').focus();
    $('library-write-guide').scrollIntoView({block: 'nearest'});
  }
  $('library-write-acl').onchange = () => {
    if (writeGuide) $('library-write-commands').textContent = $('library-write-acl').checked ? writeGuide.permissions_commands : writeGuide.commands;
  };
  $('library-write-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('library-write-commands').textContent);
      $('library-write-status').textContent = 'Kopieret. Kør kommandoerne i Proxmox Shell. Intet er udført her.';
    } catch (_) {
      $('library-write-status').textContent = 'Browseren tillader ikke kopiering her. Markér og kopiér kommandoerne manuelt.';
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents($('library-write-commands')); selection.removeAllRanges(); selection.addRange(range);
    }
  };
  $('library-write-close').onclick = () => { $('library-write-guide').hidden = true; writeTrigger?.focus(); };
  $('source-proxmox').onclick = async () => {
    clearTimeout(poolTimer);
    $('source-proxmox').disabled = true;
    $('proxmox-inventory').hidden = false;
    $('proxmox-status').textContent = 'Henter storage-pools, diske og partitioner fra Proxmox…';
    $('proxmox-selection').textContent = '';
    $('proxmox-guide').hidden = true;
    for (const id of ['proxmox-storages', 'proxmox-disks', 'proxmox-mounts', 'proxmox-pools']) $(id).replaceChildren();
    const size = value => value ? `${(value / 1024 ** 3).toLocaleString('da-DK', {maximumFractionDigits: 1})} GiB` : 'Ukendt størrelse';
    function entry(container, title, description, directories, reason, commands = '', access = null) {
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
      if (access) {
        const button = document.createElement('button'); button.className = 'secondary small';
        button.type = 'button'; button.textContent = 'Få fuld adgang';
        button.setAttribute('aria-label', `Få fuld adgang til ${access.target}`);
        button.onclick = () => showWriteGuide(access, button);
        actions.append(button);
      }
      row.append(actions); $(container).append(row);
    }
    try {
      const data = await api('/admin/library/proxmox');
      $('proxmox-status').textContent = data.errors.length ? data.errors.join(' ') : `Forbundet til Proxmox · LXC ${data.ctid}. Vælg en mediemappe fra et tilgængeligt lager.`;
      const hostStorage = data.host_storage || {available:false, pools:[]};
      const job = hostStorage.job || {state:'idle'};
      poolPending = ['queued','applying','restarting'].includes(job.state);
      $('proxmox-pool-status').textContent = hostStorage.error || (hostStorage.available
        ? (job.message || 'Vælg et lager. Tilslutningen kopierer ingen filer.')
        : 'Automatisk tilslutning er ikke sat op. Åbn Indstillinger → Lageradgang i FjordHub.');
      for (const pool of hostStorage.pools || []) {
        entry('proxmox-pools', pool.source, pool.type,
          pool.local_path ? [{name:pool.target,path:pool.local_path}] : [],
          'Lageret skal tilsluttes FjordHubs LXC.');
        const actions = $('proxmox-pools').lastElementChild.querySelector('.proxmox-actions');
        if (!pool.local_path) {
          actions.replaceChildren();
          const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary small';
          button.textContent = poolPending ? 'Tilslutning i gang…' : 'Tilslut lager';
          button.disabled = poolPending || job.state === 'interrupted' || !pool.allow_other;
          if (!pool.allow_other) button.title = 'FUSE-lageret mangler allow_other. Kontrollér opsætningen på Proxmox.';
          button.onclick = async () => {
            if (!confirm(`Tilslut ${pool.source} skrivebeskyttet? FjordHubs LXC og alle dens apps kan genstarte. Afslut aktive afspilninger og uploads først. Ingen filer kopieres.`)) return;
            poolPending = true;
            $('proxmox-pools').querySelectorAll('button').forEach(b => { b.disabled = true; });
            $('proxmox-pool-status').textContent = 'Starter tilslutningen. Vent mens FjordHub eventuelt genstarter…';
            try { await api('/admin/library/proxmox/connect', 'POST', {pool_id:pool.id,confirm_restart:true}); }
            catch (error) { $('proxmox-pool-status').textContent = error.message + ' Kontrollerer status; forespørgslen sendes ikke igen.'; }
            poolTimer = setTimeout(() => { if (dialog.open) $('source-proxmox').click(); }, 5000);
          };
          actions.append(button);
        }
      }
      for (const storage of data.storages) entry('proxmox-storages', storage.id,
        `${storage.type} · ${size(storage.total_bytes)} · ${size(storage.free_bytes)} ledigt · ${storage.directories.length ? 'Klar til valg' : storage.online ? 'Kræver tilslutning' : 'Offline'}`,
        storage.directories, storage.reason + (storage.path ? ` Sti på Proxmox: ${storage.path}.` : ''), storage.commands);
      for (const disk of data.disks) entry('proxmox-disks', disk.devpath,
        `${disk.parent ? 'Partition' : disk.model || disk.type || 'Disk'} · ${size(disk.size)} · ${disk.used || 'Intet filsystem oplyst'} · ${disk.mounted ? 'Monteret på Proxmox' : 'Ikke monteret på Proxmox'}`,
        disk.directories, disk.reason);
      for (const mount of data.mounts) entry('proxmox-mounts', mount.path, mount.source,
        mount.local_path ? [{name: mount.path, path: mount.local_path}] : [], 'Mappen er konfigureret i LXC, men er ikke tilgængelig i FjordFlix endnu.', '', mount.write_guide);
    } catch (error) { $('proxmox-status').textContent = error.message; }
    finally {
      $('source-proxmox').disabled = false;
      if (poolPending && dialog.open) poolTimer = setTimeout(() => $('source-proxmox').click(), 5000);
    }
  };
  $('mergerfs-form').onsubmit = async event => {
    event.preventDefault(); $('mergerfs-connect').disabled = true;
    $('mergerfs-status').textContent = 'Kontrollerer forbindelsen og LXC-monteringer…';
    $('mergerfs-paths').replaceChildren();
    try {
      const data = await api('/admin/library/proxmox?pool_path=' + encodeURIComponent($('mergerfs-path').value.trim()));
      const pool = data.custom_pool;
      if (!pool) throw new Error('Opdatér FjordHub for at få mergerfs-vejledningen. ' + (data.errors || []).join(' '));
      $('mergerfs-status').textContent = pool.reason;
      $('proxmox-inventory').hidden = false;
      $('proxmox-guide').hidden = !pool.commands;
      $('proxmox-guide').open = !!pool.commands;
      $('proxmox-commands').textContent = pool.commands;
      if (pool.commands) {
        $('proxmox-selection').textContent = pool.source + ': Kør vejledningen på Proxmox, og åbn derefter denne tilslutning igen. LXC og dens apps genstartes.';
        $('proxmox-guide').scrollIntoView({block:'nearest'});
      } else if (!pool.directories.length) {
        $('mergerfs-status').textContent += ' Mappen er delt med LXC, men kan endnu ikke læses i FjordFlix. Kontrollér læserettigheder og at LXC-stien ligger under appens biblioteksrod (normalt /mnt), og genstart FjordFlix.';
      }
      for (const directory of pool.directories) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
        button.textContent = 'Vælg mappe: ' + directory.name;
        button.onclick = () => browse(directory.path);
        $('mergerfs-paths').append(button);
      }
    } catch(error) { $('mergerfs-status').textContent = error.message; }
    finally { $('mergerfs-connect').disabled = false; }
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
      if (name === 'active-streams') window.loadActiveStreams();
    };
  }
  // Observe showModal as admin data is loaded asynchronously by the existing UI.
  new MutationObserver(() => {
    if (dialog.open) {
      dialog.querySelector('[data-settings-tab].active').click();
    } else { clearTimeout(timer); clearTimeout(poolTimer); }
  }).observe(dialog, {attributes: true, attributeFilter: ['open']});
})();
