(function () {
  'use strict';
  var api, page = 1, run = 0, current = null;
  function node(tag, text) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; }
  var button = node('button', 'Ønsker'), panel = node('section'), close = node('button', 'Tilbage til bibliotek'), heading = node('h1', 'Mine ønsker');
  button.id = 'wishes-open'; button.hidden = true; document.querySelector('header').appendChild(button);
  panel.id = 'wishes-panel'; panel.className = 'overlay wishes-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); heading.id = 'wishes-heading'; panel.setAttribute('aria-labelledby', heading.id);
  var form = node('form'), kind = node('input'), title = node('input'), note = node('input'), send = node('button', 'Send ønske'), message = node('p'), list = node('div'), previous = node('button', 'Nyere'), next = node('button', 'Ældre');
  kind.type = 'hidden'; kind.value = 'movie';
  var choices = node('div'), options = []; choices.setAttribute('role','group'); choices.setAttribute('aria-label','Film eller serie');
  function choose(value) { kind.value = value; options.forEach(function (option) { var active = option.value === value; option.setAttribute('aria-pressed',String(active)); option.className = active ? 'active' : ''; }); }
  [['movie','Film'],['series','Serie']].forEach(function (item) { var option = node('button', item[1]); option.type = 'button'; option.value = item[0]; option.onclick = function () { choose(item[0]); }; options.push(option); choices.appendChild(option); });
  choose('movie'); form.appendChild(kind); form.appendChild(choices);
  function field(caption, input) { var label = node('label', caption); label.appendChild(input); form.appendChild(label); }
  title.required = true; title.maxLength = 240; note.maxLength = 2000; title.id = 'wish-title'; note.id = 'wish-note';
  field('Titel og eventuelt årstal', title); field('Bemærkning (valgfri)', note); send.type = 'submit'; form.appendChild(send);
  message.setAttribute('role', 'status'); message.id = 'wish-message'; list.id = 'wish-list';
  [close, heading, form, message, list, previous, next].forEach(function (item) { panel.appendChild(item); }); document.body.appendChild(panel);
  function hide() { run++; panel.hidden = true; list.textContent = ''; form.reset(); choose('movie'); message.textContent = ''; if (!button.hidden) button.focus(); }
  function load() {
    var id = ++run; message.textContent = 'Henter ønsker…';
    previous.disabled = true; next.disabled = true;
    return api('/wishes?page=' + page).then(function (result) {
      if (id !== run || panel.hidden) return;
      list.textContent = '';
      if (!result.items.length) list.appendChild(node('p', 'Ingen ønsker endnu.'));
      result.items.forEach(function (wish) {
        var card = node('article'); card.className = 'wish-card';
        card.appendChild(node('h2', wish.title));
        card.appendChild(node('p', (wish.kind === 'series' ? 'Serie' : 'Film') + ' · ' + ({new:'Modtaget',fulfilled:'Opfyldt',declined:'Afvist'})[wish.status]));
        if (result.admin) card.appendChild(node('p', 'Fra ' + wish.sender));
        if (wish.note) card.appendChild(node('p', wish.note));
        if (wish.reply) card.appendChild(node('p', 'Svar: ' + wish.reply));
        list.appendChild(card);
      });
      previous.disabled = page === 1; next.disabled = !result.has_more; message.textContent = '';
    }).catch(function (error) { if (id === run) message.textContent = error.message; });
  }
  button.onclick = function () { panel.hidden = false; page = 1; heading.textContent = current.admin ? 'Brugernes ønsker' : 'Mine ønsker'; title.focus(); load(); };
  close.onclick = hide; previous.onclick = function () { page--; load(); }; next.onclick = function () { page++; load(); };
  form.onsubmit = function (event) {
    event.preventDefault(); send.disabled = true;
    api('/wishes','POST',{title:title.value,kind:kind.value,note:note.value}).then(function () {
      form.reset(); choose('movie'); page = 1; return load();
    }).then(function () { if (!panel.hidden) message.textContent = 'Dit ønske er sendt til administratoren.'; }, function (error) { message.textContent = error.message; }).then(function () { send.disabled = false; });
  };
  window.TVWishes = {
    sync: function (user, request) { api = request || api; if (!user || !user.can_request || current && current.id !== user.id) hide(); current = user; button.hidden = !user || !user.can_request; },
    back: function () { if (panel.hidden) return false; hide(); return true; }
  };
}());
