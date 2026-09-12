/* Native selects keep form values and app events; all visible controls are custom. */
(() => {
  const instances = new Map();
  let opened = null, serial = 0;
  function enhance(select) {
    if (instances.has(select) || select.multiple) return;
    const caption = select.getAttribute('aria-label') || [...(select.labels || [])].map(label =>
      [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('')).join(' ').trim() || 'Vælg';
    const wrap = document.createElement('div'); wrap.className = 'fx-select';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'fx-select-button';
    button.dataset.selectId = select.id;
    button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    const text = document.createElement('span'); button.append(text);
    const menu = document.createElement('div'); menu.className = 'fx-select-menu'; menu.hidden = true;
    menu.id = `fx-options-${++serial}`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', caption);
    button.setAttribute('aria-controls', menu.id);
    if (typeof menu.showPopover === 'function') menu.setAttribute('popover', 'manual');
    select.before(wrap); wrap.append(select, button, menu);
    select.classList.add('fx-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    let options = [], buffer = '', typedAt = 0;
    function close(focus = false) {
      if (opened !== api) return;
      if (menu.hasAttribute('popover') && menu.matches(':popover-open')) menu.hidePopover();
      menu.hidden = true; button.setAttribute('aria-expanded', 'false'); opened = null;
      if (focus && button.isConnected) button.focus({preventScroll:true});
    }
    function position() {
      const view = window.visualViewport;
      const x = view?.offsetLeft || 0, y = view?.offsetTop || 0;
      const width = view?.width || innerWidth, height = view?.height || innerHeight;
      const rect = button.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(rect.width, 180), width - 24)}px`;
      menu.style.maxHeight = `${Math.min(300, height - 24)}px`;
      const size = menu.getBoundingClientRect();
      const top = rect.bottom + size.height + 6 <= y + height - 12 ? rect.bottom + 6 : rect.top - size.height - 6;
      menu.style.left = `${Math.max(x + 12, Math.min(rect.left, x + width - size.width - 12))}px`;
      menu.style.top = `${Math.max(y + 12, Math.min(top, y + height - size.height - 12))}px`;
    }
    function sync() {
      text.textContent = select.options[select.selectedIndex]?.textContent || 'Vælg';
      button.setAttribute('aria-label', `${caption}: ${text.textContent}`);
      button.disabled = select.disabled;
      wrap.hidden = select.hidden || select.style.display === 'none';
      if (select.disabled || wrap.hidden) close();
      options.forEach((item, index) => item.setAttribute('aria-selected', String(index === select.selectedIndex)));
    }
    function rebuild() {
      close();
      options = [...select.options].map((option, index) => {
        const item = document.createElement('button'); item.type = 'button'; item.className = 'fx-select-option';
        item.dataset.selectId = select.id; item.setAttribute('role', 'option'); item.tabIndex = -1;
        item.textContent = option.textContent;
        item.disabled = option.disabled || option.parentElement?.disabled; item.hidden = option.hidden;
        item.onclick = () => {
          if (item.disabled || select.disabled) return;
          const changed = select.selectedIndex !== index;
          select.selectedIndex = index; close(true);
          if (changed) {
            select.dispatchEvent(new Event('input', {bubbles:true}));
            select.dispatchEvent(new Event('change', {bubbles:true}));
          }
          sync();
        };
        return item;
      });
      menu.replaceChildren(...options); sync();
    }
    function open(last = false) {
      if (button.disabled) return;
      if (opened === api) return;
      opened?.close(); opened = api; menu.hidden = false;
      if (menu.hasAttribute('popover')) menu.showPopover();
      button.setAttribute('aria-expanded', 'true'); position();
      const enabled = options.filter(item => !item.disabled && !item.hidden);
      const current = options[select.selectedIndex];
      (current && !current.disabled && !current.hidden ? current : last ? enabled.at(-1) : enabled[0])?.focus({preventScroll:true});
      document.activeElement?.scrollIntoView({block:'nearest'});
    }
    const api = {close, position, wrap, destroy() {close(); observer.disconnect(); instances.delete(select)}};
    instances.set(select, api);
    for (const property of ['value', 'selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
      Object.defineProperty(select, property, {configurable:true, get() {return descriptor.get.call(this)},
        set(value) {descriptor.set.call(this, value); sync()}});
    }
    const observer = new MutationObserver(rebuild);
    observer.observe(select, {childList:true, subtree:true, characterData:true, attributes:true});
    select.addEventListener('change', sync);
    select.form?.addEventListener('reset', () => setTimeout(sync, 0));
    button.onclick = () => opened === api ? close(true) : open();
    button.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); open(event.key === 'End' || event.key === 'ArrowUp');
      }
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(true); return}
      if (event.key === 'Tab') {close(true); return}
      const enabled = options.filter(item => !item.disabled && !item.hidden);
      const index = enabled.indexOf(document.activeElement);
      const next = {ArrowDown:index + 1, ArrowUp:index - 1, Home:0, End:enabled.length - 1}[event.key];
      if (next !== undefined) {
        event.preventDefault(); event.stopPropagation();
        enabled[Math.max(0, Math.min(enabled.length - 1, next))]?.focus();
      } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); buffer = Date.now() - typedAt > 700 ? event.key : buffer + event.key; typedAt = Date.now();
        enabled.find(item => item.textContent.toLocaleLowerCase().startsWith(buffer.toLocaleLowerCase()))?.focus();
      }
    });
    rebuild();
  }
  function scan() {
    if (!document?.body) return;
    document.querySelectorAll('select').forEach(enhance);
    for (const [select, api] of instances) if (!select.isConnected) api.destroy();
  }
  document.addEventListener('pointerdown', event => {if (opened && !opened.wrap.contains(event.target)) opened.close()});
  document.addEventListener('close', () => opened?.close(), true);
  document.addEventListener('scroll', event => {if (opened && !opened.wrap.contains(event.target)) opened.position()}, true);
  window.addEventListener('resize', () => opened?.position());
  window.visualViewport?.addEventListener('resize', () => opened?.position());
  window.visualViewport?.addEventListener('scroll', () => opened?.position());
  new MutationObserver(scan).observe(document.body, {childList:true, subtree:true});
  window.FjordSelects = {closeOpen() {if (!opened) return false; opened.close(true); return true}};
  scan();
})();
