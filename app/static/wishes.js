(() => {
  const labels = {new:'Modtaget', fulfilled:'Opfyldt', declined:'Afvist'};
  let current=null, page=1, generation=0;
  const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
  const dialog=node('dialog',undefined,'wish-dialog');dialog.id='wishes-dialog';
  dialog.setAttribute('aria-labelledby','wishes-title');
  dialog.innerHTML='<button type="button" class="close" aria-label="Luk ønsker">✕</button><span class="eyebrow">DIT BIBLIOTEK</span><h2 id="wishes-title">Ønsker</h2><p id="wishes-intro" class="muted"></p><form id="wish-form"><label>Film eller serie<select name="kind"><option value="movie">Film</option><option value="series">Serie</option></select></label><label>Titel<input name="title" maxlength="240" required placeholder="Titel og eventuelt årstal"></label><label>Bemærkning (valgfri)<textarea name="note" maxlength="2000" rows="3" placeholder="Fx sæson, sprog eller et link til titlen"></textarea></label><button class="primary" type="submit">Send ønske</button></form><p id="wishes-message" role="status" aria-live="polite"></p><div id="wishes-list"></div><div class="wish-pages"><button type="button" id="wishes-prev">Nyere</button><span id="wishes-page"></span><button type="button" id="wishes-next">Ældre</button></div>';
  document.body.append(dialog);
  const el=id=>document.getElementById(id), form=el('wish-form');
  dialog.querySelector('.close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{generation++;form.reset();el('wishes-message').textContent='';});
  function message(value){el('wishes-message').textContent=value;}
  async function load(){
    const id=++generation;message('Henter ønsker…');
    el('wishes-prev').disabled=true;el('wishes-next').disabled=true;
    try {
      const result=await api('/wishes?page='+page);if(id!==generation||!dialog.open)return;
      el('wishes-list').replaceChildren();
      if(!result.items.length)el('wishes-list').append(node('p','Ingen ønsker endnu.','muted'));
      for(const wish of result.items){
        const card=node('article',undefined,'wish-card');card.append(node('h3',wish.title));
        card.append(node('p',`${wish.kind==='series'?'Serie':'Film'} · ${new Date(wish.created*1000).toLocaleDateString('da-DK')} · ${labels[wish.status]}`,'muted'));
        if(result.admin)card.append(node('p','Fra '+wish.sender));
        if(wish.note)card.append(node('p',wish.note,'wish-note'));
        if(wish.reply)card.append(node('p','Svar: '+wish.reply,'wish-note'));
        if(result.admin){
          const decision=node('form',undefined,'wish-decision'), status=node('select'), reply=node('textarea');
          status.setAttribute('aria-label','Status for '+wish.title);
          for(const [key,label] of Object.entries(labels)){const option=node('option',label);option.value=key;status.append(option);}
          status.value=wish.status;reply.value=wish.reply;reply.maxLength=2000;reply.rows=2;reply.placeholder='Svar til brugeren (valgfrit)';reply.setAttribute('aria-label','Svar til '+wish.sender);
          const save=node('button','Gem status','secondary');save.type='submit';decision.append(status,reply,save);
          decision.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await api('/admin/wishes/'+wish.id,'PUT',{status:status.value,reply:reply.value});await load();message('Status gemt.');}catch(error){message(error.message);save.disabled=false;}};
          card.append(decision);
        }
        el('wishes-list').append(card);
      }
      el('wishes-prev').disabled=page===1;el('wishes-next').disabled=!result.has_more;el('wishes-page').textContent='Side '+page;message('');
    }catch(error){if(id===generation)message(error.message);}
  }
  function open(){page=1;el('wishes-title').textContent=current?.admin?'Brugernes ønsker':'Mine ønsker';el('wishes-intro').textContent=current?.admin?'Se ønsker fra brugerne, og giv dem en status eller et svar.':'Savner du en film eller serie? Send et ønske til administratoren.';dialog.showModal();load();}
  form.onsubmit=async event=>{event.preventDefault();if(current?.admin)return;const button=form.querySelector('button[type=submit]');button.disabled=true;try{await api('/wishes','POST',{title:form.elements.title.value,kind:form.elements.kind.value,note:form.elements.note.value});form.reset();page=1;await load();message('Dit ønske er sendt til administratoren.');}catch(error){message(error.message);}finally{button.disabled=false;}};
  el('wishes-prev').onclick=()=>{page--;load();};el('wishes-next').onclick=()=>{page++;load();};
  function sync(user){
    if(current?.id!==user?.id || current?.admin!==user?.admin || !user?.can_request){generation++;if(dialog.open)dialog.close();el('wishes-list').replaceChildren();form.reset();}
    current=user;
    form.hidden=!!user?.admin || !user?.can_request;
    document.body.classList.toggle('wishes-enabled',!!user?.can_request);
    for(const [parent,id,cls] of [[document.querySelector('header nav'),'wishes-open','nav-button'],[el('library-categories'),'wishes-sidebar','sidebar-view']]){
      if(!parent)continue;
      let button=el(id);if(!button){button=node('button','Ønsker',cls);button.id=id;button.type='button';button.onclick=open;parent.insertBefore(button,parent.querySelector('.sidebar-foot'));if(id==='wishes-open')button.insertAdjacentHTML('afterbegin','<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/></svg>');}
      button.hidden=!user?.can_request;
    }
  }
  function users(rows){
    const list=el('users-list');list.replaceChildren();
    for(const user of rows){
      const row=node('div',undefined,'user-row'), title=node('div',user.name), role=node('span',user.admin?'Administrator':'Bruger');title.append(role);
      const label=node('label',undefined,'wish-permission'), checkbox=node('input');checkbox.type='checkbox';checkbox.checked=!!user.can_request&&!user.admin;checkbox.disabled=!!user.admin;checkbox.setAttribute('aria-label','Tillad ønsker for '+user.name);label.append(checkbox,document.createTextNode('Kan sende ønsker'));
      checkbox.onchange=async()=>{const enabled=checkbox.checked;checkbox.disabled=true;try{await api('/admin/users/'+encodeURIComponent(user.id)+'/wishes','PUT',{enabled});toast('Rettigheden er gemt.');}catch(error){checkbox.checked=!enabled;toast(error.message);}finally{checkbox.disabled=false;}};
      row.append(title,label);list.append(row);
    }
  }
  window.FjordWishes={sync,users};
  window.addEventListener('focus',()=>{if(current)api('/state').then(result=>sync(result.user)).catch(()=>{});});
})();
