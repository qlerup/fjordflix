/* Upload one file at a time; keep each result visible and never repeat successes. */
function createUploadQueue(send, changed = () => {}) {
  const queue = {items: [], running: false};
  queue.add = files => {
    if (queue.running) return;
    for (const file of files) {
      if (queue.items.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
      const error = !/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i.test(file.name) ? 'Filtypen understøttes ikke.'
        : !file.size ? 'Filen er tom.' : '';
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
const UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;

function uploadRequest(method, url, body, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.timeout = 120000;
    if (body && !(body instanceof Blob)) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress?.(event.loaded); };
    const fail = (message, status = 0) => reject(Object.assign(new Error(message), {status}));
    xhr.onload = () => {
      let result;
      try { result = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && result) resolve(result);
      else fail(typeof result?.detail === 'string' ? result.detail : `Upload mislykkedes (${xhr.status}).`, xhr.status);
    };
    xhr.onerror = () => fail('Forbindelsen blev afbrudt. Tryk Prøv igen for at fortsætte.');
    xhr.ontimeout = () => fail('Serveren svarede ikke. Tryk Prøv igen for at fortsætte.');
    xhr.onabort = () => fail('Upload blev afbrudt.');
    xhr.send(body ?? null);
  });
}

function createChunkUploader(request = uploadRequest, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const sessions = new WeakMap();
  async function retry(...args) {
    for (let attempt = 0; ; attempt++) {
      try { return await request(...args); }
      catch (error) {
        if (attempt >= 3 || (error.status && ![408, 429].includes(error.status) && (error.status < 500 || error.status === 507))) throw error;
        await wait(1000 * 2 ** attempt);
      }
    }
  }
  return async (file, progress) => {
    let state;
    const saved = sessions.get(file);
    if (saved) {
      try { state = await retry('GET', `/api/uploads/${saved}`); }
      catch (error) { if (error.status !== 404) throw error; sessions.delete(file); }
    }
    if (!state) {
      state = await retry('POST', '/api/uploads', {filename: file.name, size: file.size});
      sessions.set(file, state.id);
    }
    const url = `/api/uploads/${state.id}`;
    while (state.offset < file.size) {
      const offset = state.offset;
      progress(Math.floor(offset / file.size * 100), false);
      state = await retry('PUT', `${url}?offset=${offset}`, file.slice(offset, offset + UPLOAD_CHUNK_SIZE),
        loaded => progress(Math.min(99, Math.floor((offset + loaded) / file.size * 100)), false));
      if (state.offset <= offset || state.offset > file.size) throw new Error('Serveren returnerede en ugyldig uploadposition.');
    }
    progress(100, true);
    state = await retry('POST', `${url}/complete`);
    while (state.status === 'processing') {
      await wait(1500);
      state = await retry('GET', url);
      // A restarted server makes an interrupted processing job available again.
      if (state.status === 'uploading') state = await retry('POST', `${url}/complete`);
    }
    if (state.status !== 'done') {
      sessions.delete(file);
      throw new Error(state.message || 'Videoen kunne ikke behandles.');
    }
    return state;
  };
}
if (typeof module !== 'undefined') module.exports = {createUploadQueue, createChunkUploader, UPLOAD_CHUNK_SIZE};

function setupUploads() {
  const input = $('upload-file'), zone = input.closest('.dropzone');
  zone.querySelector('strong').textContent = 'Vælg videoer eller træk dem hertil';
  zone.querySelector('span').textContent = 'MP4, MKV, MOV, WebM, M4V, AVI og TS';
  const list = document.createElement('ul'); list.className = 'upload-queue';
  $('upload-progress').before(list);
  const send = createChunkUploader();
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
        if (item.status === 'error') {
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary small';
          retry.textContent = 'Prøv igen';
          retry.onclick = () => { item.status = 'queued'; item.message = 'Venter'; $('upload-form').requestSubmit(); };
          row.append(retry);
        }
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
