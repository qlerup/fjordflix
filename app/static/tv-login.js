/* The phone approves a visible Xbox code; it never receives the Xbox login token. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('pair-form'), code = $('user-code'), button = $('approve-button');
  const alphabet = /^[A-HJ-NP-Z2-9]{8}$/;
  let pending = false, approved = false;
  const compact = value => value.toUpperCase().replace(/[\s-]/g, '');
  const formatted = value => value.length > 4 ? value.slice(0,4) + '-' + value.slice(4) : value;
  function error(message, field) {
    $('pair-error').textContent = message;
    $('pair-error').hidden = !message;
    if (field) field.setAttribute('aria-invalid', 'true');
  }
  function editableCode() {
    code.readOnly = false;
    $('edit-code').hidden = true;
    $('code-help').textContent = 'Indtast de otte tegn, der vises på din Xbox.';
  }
  function busy(value) {
    pending = value;
    form.setAttribute('aria-busy', String(value));
    for (const field of form.querySelectorAll('input,button')) field.disabled = value;
    button.querySelector('.button-label').textContent = value ? 'Logger ind…' : 'Log ind på Xbox';
    $('pair-status').textContent = value ? 'Forbinder dit login med Xbox…' : '';
  }
  const supplied = new URLSearchParams(location.hash.slice(1)).get('code') || '';
  const initial = compact(supplied);
  if (alphabet.test(initial)) {
    code.value = formatted(initial);
    code.readOnly = true;
    $('edit-code').hidden = false;
  } else {
    editableCode();
    if (supplied) error('Koden i linket kunne ikke læses. Indtast koden fra din Xbox.', code);
  }
  // A second QR scan may only change the fragment. Start a fresh form for that code.
  window.addEventListener('hashchange', () => location.reload());
  $('edit-code').addEventListener('click', () => { editableCode(); code.focus(); code.select(); });
  code.addEventListener('input', () => {
    const cursor = code.selectionStart;
    const before = code.value.slice(0,cursor).replace(/[^A-Za-z0-9]/g, '').length;
    code.value = formatted(code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,8));
    const position = before + (before > 4 ? 1 : 0);
    code.setSelectionRange(position, position);
  });
  form.addEventListener('input', event => {
    event.target.removeAttribute('aria-invalid');
    error('');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || approved) return;
    error('');
    const normalized = compact(code.value);
    if (!alphabet.test(normalized)) {
      editableCode();
      error('Skriv de otte tegn fra din Xbox. Koden bruger ikke I, O, 1 eller 0.', code);
      code.focus(); return;
    }
    const name = $('username').value.trim();
    if (!name) { error('Skriv dit brugernavn.', $('username')); $('username').focus(); return; }
    const payload = {user_code:formatted(normalized), name, password:$('password').value};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let focusField;
    busy(true);
    try {
      const response = await fetch('/tv-api/pair/approve', {
        method:'POST', credentials:'omit', cache:'no-store', redirect:'error',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:controller.signal
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        let message;
        if (response.status === 401) {
          message = 'Brugernavn eller adgangskode er forkert. Prøv igen.'; focusField = $('password');
        } else if (response.status === 410 || response.status === 404) {
          message = response.status === 410 ? 'Koden er udløbet eller ikke længere gyldig. Åbn en ny QR-kode på din Xbox, og scan igen.' : 'Koden blev ikke fundet. Kontrollér de otte tegn på din Xbox.';
          editableCode(); focusField = code;
        } else if (response.status === 409) {
          message = 'Koden er allerede godkendt. Fortsæt på din Xbox.';
        } else if (response.status === 429) {
          message = 'For mange forsøg. Vent et øjeblik, og prøv igen.';
        } else if (response.status === 403) {
          message = typeof result?.detail === 'string' ? result.detail : 'Login kunne ikke godkendes fra denne side. Scan QR-koden på din Xbox igen.';
        } else if (response.status === 400 || response.status === 422) {
          message = 'Kontrollér koden og dine loginoplysninger, og prøv igen.';
        } else {
          message = 'Login-tjenesten svarer ikke lige nu. Prøv igen om lidt.';
        }
        error(message, focusField);
        return;
      }
      if (result?.status !== 'approved') throw new Error('unexpected-response');
      approved = true;
      $('password').value = '';
      $('success-code').textContent = formatted(normalized);
      form.hidden = true;
      $('pair-intro').hidden = true;
      $('pair-success').hidden = false;
      $('success-title').focus({preventScroll:true});
      window.scrollTo(0,0);
    } catch (failure) {
      error(failure.name === 'AbortError' ? 'Serveren svarede ikke i tide. Kontrollér forbindelsen, og prøv igen.' : failure.message === 'unexpected-response' ? 'Serveren kunne ikke bekræfte dit login. Prøv igen.' : 'Kunne ikke oprette forbindelse. Kontrollér dit netværk, og prøv igen.');
    } finally {
      clearTimeout(timeout);
      payload.password = '';
      busy(false);
      if (focusField) { focusField.focus(); focusField.select(); }
    }
  });
})();
