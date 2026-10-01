/* Optional server setup: provider secrets are sent only to the existing APIs. */
(() => {
  const el = id => document.getElementById(id);
  const dialog = el('onboarding-dialog');
  let current = 'tmdb', busy = false;
  const clearSecrets = () => {
    for (const id of ['onboarding-tmdb-token','onboarding-os-key','onboarding-os-password']) el(id).value = '';
  };
  function render(data) {
    clearSecrets();
    if (!data.pending) { dialog.close(); return; }
    current = ['tmdb','subtitles'].find(step => data.steps[step] === 'pending');
    dialog.querySelectorAll('[data-onboarding-step]').forEach(panel => { panel.hidden = panel.dataset.onboardingStep !== current; });
    dialog.querySelectorAll('[data-onboarding-nav]').forEach(item => {
      if (item.dataset.onboardingNav === current) item.setAttribute('aria-current','step');
      else item.removeAttribute('aria-current');
    });
    el('onboarding-error').textContent = '';
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    dialog.querySelector(`[data-onboarding-step="${current}"] a`).focus({preventScroll:true});
  }
  async function run(action, message) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    el('onboarding-error').textContent = '';
    el('onboarding-status').textContent = message;
    try { await action(); }
    catch(error) { if (dialog.open) el('onboarding-error').textContent = error.message; }
    finally {
      busy = false;
      dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
      el('onboarding-status').textContent = '';
    }
  }
  async function choose(step, action) {
    render(await api('/admin/onboarding','POST',{step,action}));
  }
  el('onboarding-tmdb-form').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      await api('/admin/metadata','PUT',{token:el('onboarding-tmdb-token').value.trim()});
      clearSecrets();
      await choose('tmdb','done');
    }, 'Gemmer filmdataopsætningen…');
  };
  el('onboarding-os-form').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      await api('/admin/opensubtitles','PUT',{api_key:el('onboarding-os-key').value.trim(),
        username:el('onboarding-os-user').value.trim(),password:el('onboarding-os-password').value});
      clearSecrets();
      await choose('subtitles','done');
    }, 'Tester forbindelsen til OpenSubtitles…');
  };
  el('onboarding-skip').onclick = () => run(() => choose(current,'skip'),'Gemmer dit valg…');
  el('onboarding-skip-all').onclick = () => run(() => choose('all','skip'),'Gemmer dit valg…');
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!busy) el('onboarding-skip-all').click();
  });
  dialog.addEventListener('close', clearSecrets);
  window.FjordOnboarding = {
    async open() {
      try { render(await api('/admin/onboarding')); }
      catch(error) { toast('Opsætningsguiden kunne ikke hentes. ' + error.message); }
    },
    close() { if (dialog.open) dialog.close(); clearSecrets(); },
  };
})();
