// Requires jsdom: npm install --prefix test-results/dropdown-deps jsdom
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('../test-results/dropdown-deps/node_modules/jsdom');
const script = fs.readFileSync(require.resolve('../app/static/selects.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const dom = new JSDOM('<form><label>Sæson<select id="season"><option value="1">Sæson 1</option><option value="2">Sæson 2</option><option value="3" disabled>Sæson 3</option></select></label></form>', {runScripts:'outside-only', pretendToBeVisual:true});
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
    return this.classList.contains('fx-select-menu') ? {width:200,height:140} : {left:950,top:690,bottom:736,width:200,height:46};
  };
  dom.window.eval(script);
  return dom;
}
test('custom selection updates the native field, sends one change and supports keyboard and disabled options', async () => {
  const dom=setup(), {document,KeyboardEvent}=dom.window;
  try {
    const select=document.querySelector('select'), button=document.querySelector('.fx-select-button');
    let changes=0;select.addEventListener('change',()=>changes++);
    assert.match(button.getAttribute('aria-label'),/Sæson: Sæson 1/);
    button.click();
    const menu=document.querySelector('.fx-select-menu');
    assert.equal(button.getAttribute('aria-expanded'),'true');
    assert.ok(parseFloat(menu.style.left)+200 <= dom.window.innerWidth-12);
    assert.ok(parseFloat(menu.style.top)+140 <= dom.window.innerHeight-12);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert.equal(document.activeElement.textContent,'Sæson 2');
    document.activeElement.click();
    assert.equal(select.value,'2');assert.equal(changes,1);assert.equal(menu.hidden,true);
    assert.equal(document.activeElement,button);
    select.value='1';assert.equal(button.textContent,'Sæson 1');
    select.selectedIndex=1;assert.equal(button.textContent,'Sæson 2');
    button.click();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    assert.equal(document.activeElement.textContent,'Sæson 2');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(menu.hidden,true);
    select.disabled=true;await tick();assert.equal(button.disabled,true);
  } finally {dom.window.close()}
});
test('dynamic selects, replaced options, hidden state and form resets stay synchronized', async () => {
  const dom=setup(), {document,Option}=dom.window;
  try {
    const select=document.querySelector('select'), button=document.querySelector('.fx-select-button');
    select.replaceChildren(new Option('Specialafsnit','0'),new Option('Sæson 4','4'));
    select.value='4';await tick();assert.equal(button.textContent,'Sæson 4');
    assert.equal(document.querySelectorAll('.fx-select-option').length,2);
    select.hidden=true;await tick();assert.equal(button.parentElement.hidden,true);
    select.hidden=false;await tick();assert.equal(button.parentElement.hidden,false);
    document.querySelector('form').reset();await tick();assert.equal(button.textContent,'Specialafsnit');
    const dialog=document.createElement('dialog');dialog.setAttribute('open','');
    dialog.innerHTML='<select aria-label="Type"><option>Film</option><option>Serieafsnit</option></select>';
    document.body.append(dialog);await tick();
    assert.equal(dialog.querySelectorAll('.fx-select-button').length,1);
    button.click();dialog.querySelector('button').click();
    assert.equal(button.getAttribute('aria-expanded'),'false');
    assert.equal(dialog.querySelector('button').getAttribute('aria-expanded'),'true');
    assert.equal(dom.window.FjordSelects.closeOpen(),true);
    assert.equal(dom.window.FjordSelects.closeOpen(),false);
  } finally {dom.window.close()}
});
