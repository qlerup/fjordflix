const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('../test-results/dropdown-deps/node_modules/jsdom');
const source=fs.readFileSync('app/static/wishes.js','utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const dom=new JSDOM('<header><nav></nav></header><aside id="library-categories"></aside><div id="users-list"></div>',{url:'https://test.local',runScripts:'outside-only'});
 const w=dom.window,calls=[];let items=[],admin=false,fail=false;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.toast=()=>{};
 w.api=async(path,method='GET',body)=>{calls.push({path,method,body});if(fail)throw new Error('Adgang fjernet');if(method==='GET')return {items,has_more:false,admin};return {ok:true};};
 w.eval(source);
 return {w,calls,close:()=>w.close(),items(value){items=value;},admin(value){admin=value;},fail(){fail=true;}};
}
test('request menu is opt-in and submission uses escaped text and own history',async()=>{
 const f=fixture(),w=f.w;
 try{
  w.FjordWishes.sync({id:'one',can_request:false});assert.equal(w.document.getElementById('wishes-open').hidden,true);
  w.FjordWishes.sync({id:'one',can_request:true});assert.equal(w.document.getElementById('wishes-sidebar').hidden,false);
  f.items([{id:'1',title:'<img src=x onerror=alert(1)>',note:'<script>bad()</script>',reply:'Tak',kind:'movie',status:'new',created:1}]);
  w.document.getElementById('wishes-open').click();await settle();
  const list=w.document.getElementById('wishes-list');assert.equal(list.querySelector('img,script'),null);assert.ok(list.textContent.includes('<img'));
  const form=w.document.getElementById('wish-form');form.elements.title.value='En film';form.elements.note.value='Danske tekster';
  form.dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
  assert.equal(f.calls.find(c=>c.method==='POST').body.title,'En film');assert.match(w.document.getElementById('wishes-message').textContent,/sendt/);
  w.FjordWishes.sync(null);assert.equal(w.document.getElementById('wishes-dialog').open,false);assert.equal(list.textContent,'');
 }finally{f.close();}
});
test('administrator can grant permission and save status; failed writes restore checkbox',async()=>{
 const f=fixture(),w=f.w;
 try{
  w.FjordWishes.users([{id:'one',name:'<img src=x>',admin:false,can_request:false}]);
  assert.equal(w.document.querySelector('#users-list img'),null);
  let checkbox=w.document.querySelector('input[type=checkbox]');checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change'));await settle();
  assert.equal(f.calls[0].path,'/admin/users/one/wishes');assert.equal(f.calls[0].body.enabled,true);
  f.admin(true);f.items([{id:'wish',title:'Film',kind:'movie',sender:'Anna',status:'new',created:1,reply:''}]);
  w.FjordWishes.sync({id:'admin',admin:true,can_request:true});w.document.getElementById('wishes-open').click();await settle();
  const form=w.document.querySelector('.wish-decision');form.querySelector('select').value='fulfilled';form.querySelector('textarea').value='Den er klar';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
  assert.equal(f.calls.find(c=>c.path==='/admin/wishes/wish').body.status,'fulfilled');
  f.fail();checkbox.checked=false;checkbox.dispatchEvent(new w.Event('change'));await settle();assert.equal(checkbox.checked,true);assert.equal(checkbox.disabled,false);
 }finally{f.close();}
});
