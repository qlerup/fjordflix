document.querySelector('form').onsubmit = async event => {
  event.preventDefault(); const button = document.querySelector('button'); button.disabled = true;
  document.querySelector('#status').textContent = 'Forbinder…';
  try { await window.fjordDesktop.connect(document.querySelector('#server').value.trim()); }
  catch (error) { document.querySelector('#status').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { button.disabled = false; }
};
