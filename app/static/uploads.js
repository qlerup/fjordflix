/* Upload one file at a time; keep each result visible and never repeat successes. */
function createUploadQueue(send, changed = () => {}) {
  const queue = {items: [], running: false};
  queue.add = files => {
    if (queue.running) return;
    for (const file of files) {
      if (queue.items.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
      const error = !/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i.test(file.name) ? 'Filtypen understøttes ikke.'
        : file.size > 100 * 1024 ** 3 ? 'Filen er større end 100 GB.' : !file.size ? 'Filen er tom.' : '';
      queue.items.push({file, status: error ? 'invalid' : 'queued', message: error || 'Venter', progress: 0});
    }
    changed();
  };
  queue.run = async () => {
    if (queue.running) return;
    queue.running = true; changed();
    try {
      for (const item of queue.items.filter(item => item.status === 'queued')) {
        item.status = 'uploading'; item.message = 'Uploader…'; changed();
        try {
          const result = await send(item.file, (progress, processing) => {
            item.progress = progress;
            item.message = processing ? 'Henter oplysninger og billeder…' : `Uploader ${progress}%`;
            changed();
          });
          item.status = 'done'; item.progress = 100;
          item.message = result.metadata_message || 'Tilføjet til biblioteket.';
        } catch (error) {
          item.status = 'error'; item.message = error.message || 'Upload mislykkedes.';
        }
        changed();
      }
    } finally { queue.running = false; changed(); }
  };
  return queue;
}
if (typeof module !== 'undefined') module.exports = {createUploadQueue};

function setupUploads() {
  const input = $('upload-file'), zone = input.closest('.dropzone');
  zone.querySelector('strong').textContent = 'Vælg videoer eller træk dem hertil';
  zone.querySelector('span').textContent = 'MP4, MKV, MOV, WebM, M4V, AVI og TS · maks. 100 GB pr. fil';
  const list = document.createElement('ul'); list.className = 'upload-queue';
  $('upload-progress').before(list);
  const send = (file, progress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload?filename=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100), false);
    };
    xhr.upload.onload = () => progress(100, true);
    xhr.onload = () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(typeof result.detail === 'string' ? result.detail : `Upload mislykkedes (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Forbindelsen blev afbrudt. Kontrollér biblioteket, før du uploader filen igen.'));
    xhr.onabort = () => reject(new Error('Upload blev afbrudt.'));
    xhr.send(file);
  });
  const queue = createUploadQueue(send, render);
  function render() {
    const pending = queue.items.filter(item => item.status === 'queued');
    const complete = queue.items.filter(item => item.status === 'done').length;
    const failures = queue.items.filter(item => ['error', 'invalid'].includes(item.status)).length;
    input.disabled = queue.running;
    $('upload-submit').disabled = queue.running || !pending.length;
    $('upload-submit').textContent = queue.running ? 'Uploader…' : pending.length ? `Upload ${pending.length} ${pending.length === 1 ? 'fil' : 'filer'}` : 'Upload til biblioteket';
    $('upload-form').setAttribute('aria-busy', String(queue.running));
    $('upload-status').textContent = queue.items.length
      ? `${complete} af ${queue.items.length} tilføjet${failures ? ` · ${failures} med fejl` : ''}${queue.running ? ' · Du kan lukke dette vindue, men hold Fjordflix-fanen åben.' : ''}` : '';
    const active = queue.items.find(item => item.status === 'uploading');
    $('upload-progress').hidden = !active;
    if (active?.progress === 100) $('upload-progress').removeAttribute('value');
    else $('upload-progress').value = active?.progress || 0;
    list.replaceChildren(...queue.items.map(item => {
      const row = document.createElement('li'); row.dataset.status = item.status;
      const text = document.createElement('div'), name = document.createElement('strong'), status = document.createElement('span');
      name.textContent = item.file.name; status.textContent = item.message;
      text.append(name, status); row.append(text);
      if (!queue.running && item.status !== 'done') {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary small';
        remove.textContent = 'Fjern'; remove.setAttribute('aria-label', `Fjern ${item.file.name}`);
        remove.onclick = () => { queue.items.splice(queue.items.indexOf(item), 1); render(); };
        row.append(remove);
      }
      return row;
    }));
  }
  input.onchange = () => { queue.add(input.files); input.value = ''; };
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => {
    event.preventDefault();
    if (!queue.running) zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', event => {
    event.preventDefault(); zone.classList.remove('drag-over');
    queue.add(event.dataTransfer.files);
  });
  // Dropping outside the target must not navigate away from an active upload.
  for (const type of ['dragover', 'drop']) $('upload-dialog').addEventListener(type, event => event.preventDefault());
  $('upload-open').onclick = () => {
    if (!queue.running && queue.items.length && queue.items.every(item => item.status === 'done')) queue.items = [];
    render(); $('upload-dialog').showModal();
  };
  $('upload-form').onsubmit = async event => {
    event.preventDefault();
    if (queue.running || !queue.items.some(item => item.status === 'queued')) return;
    await queue.run();
    try { await refresh(); } catch { toast('Uploadkøen er færdig. Genindlæs biblioteket for at se filerne.'); }
  };
  render();
}
