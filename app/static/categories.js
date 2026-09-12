const FjordCategories = {
  definitions: [
    ['all', 'Alle', []],
    ['action', 'Action og eventyr', ['action', 'action & adventure', 'action og eventyr', 'eventyr', 'adventure', 'war', 'krig', 'war & politics', 'krig og politik', 'western']],
    ['comedy', 'Komedie', ['komedie', 'comedy']],
    ['crime', 'Krimi og spænding', ['krimi', 'crime', 'kriminalitet', 'thriller', 'mystik', 'mystery', 'mysterium']],
    ['documentary', 'Dokumentar', ['dokumentar', 'documentary']],
    ['drama', 'Drama', ['drama', 'historie', 'history', 'historisk', 'soap']],
    ['family', 'Familie og animation', ['familie', 'family', 'kids', 'børn', 'animation']],
    ['horror', 'Gyser', ['gyser', 'horror', 'gys']],
    ['romance', 'Romantik', ['romantik', 'romance', 'romantisk']],
    ['scifi', 'Sci-fi og fantasy', ['science fiction', 'sci-fi', 'sci-fi & fantasy', 'sci-fi og fantasy', 'science fiction og fantasy', 'fantasy', 'fantasi']],
    ['reality', 'Reality og underholdning', ['reality', 'talk', 'musik', 'music', 'news', 'nyheder']],
    ['other', 'Øvrige', []],
    ['none', 'Uden kategori', []]
  ],
  keys(item) {
    const genres = new Set((item.episodes || [item]).flatMap(episode => episode.catalog?.genres || [])
      .filter(genre => typeof genre === 'string' && genre.trim()).map(genre => genre.trim().toLocaleLowerCase('da')));
    if (!genres.size) return new Set(['none']);
    const keys = new Set();
    for (const genre of genres) {
      const matches = this.definitions.filter(([, , aliases]) => aliases.includes(genre));
      if (!matches.length) keys.add('other');
      matches.forEach(([key]) => keys.add(key));
    }
    return keys;
  },
  filter(items, key) { return key === 'all' ? items : items.filter(item => this.keys(item).has(key)); }
};
if (typeof module !== 'undefined') module.exports = FjordCategories;

const categorySelection = {all:'all', series:'all'};
function setupCategories() {
  const title = $('library-title');
  const row = document.createElement('div'); row.className = 'library-title-row';
  title.before(row); row.append(title);
  row.insertAdjacentHTML('beforeend',
    '<div id="library-categories" class="library-categories" hidden><button id="categories-open" class="secondary" aria-haspopup="dialog" aria-controls="categories-panel" aria-expanded="false"><span aria-hidden="true">☰</span> Kategorier</button></div>');
  document.body.insertAdjacentHTML('beforeend', `<dialog id="categories-panel" aria-labelledby="categories-title">
    <div class="categories-panel-heading"><div><span class="eyebrow">UDFORSK BIBLIOTEKET</span><h2 id="categories-title">Serier</h2></div>
    <button id="categories-close" class="icon-button" aria-label="Luk kategorimenu">✕</button></div>
    <p class="muted">Find noget, du har lyst til at se.</p>
    <nav id="categories-links" aria-label="Kategorier"></nav></dialog>`);
  const panel = $('categories-panel'), trigger = $('categories-open');
  trigger.onclick = () => {
    panel.showModal(); trigger.setAttribute('aria-expanded', 'true');
    (panel.querySelector('[aria-current="page"]') || $('categories-close')).focus();
  };
  $('categories-close').onclick = () => panel.close();
  panel.addEventListener('close', () => {
    trigger.setAttribute('aria-expanded', 'false');
    if (!$('library-categories').hidden) trigger.focus();
  });
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const rect = panel.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) panel.close();
  });
}
function renderCategories(items, availableItems = items) {
  const container = $('library-categories');
  container.hidden = !['all', 'series'].includes(view);
  if (container.hidden) {
    if ($('categories-panel').open) $('categories-panel').close();
    return {items, label:null};
  }
  const choices = FjordCategories.definitions.filter(([key]) => key === 'all' || FjordCategories.filter(availableItems, key).length);
  if (!choices.some(([key]) => key === categorySelection[view])) categorySelection[view] = 'all';
  const selectedKey = categorySelection[view], links = $('categories-links');
  $('categories-title').textContent = view === 'series' ? 'Serier' : 'Film';
  const signature = view + ':' + choices.map(([key]) => key).join(',');
  if (links.dataset.choices !== signature) {
    links.replaceChildren(...choices.map(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'category-link'; button.dataset.category = key;
      button.textContent = key === 'all' ? (view === 'series' ? 'Alle serier' : 'Alle film') : label;
      button.onclick = () => {categorySelection[view] = key; render(); $('categories-panel').close();};
      return button;
    }));
    links.dataset.choices = signature;
  }
  for (const button of links.children) {
    if (button.dataset.category === selectedKey) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const label = FjordCategories.definitions.find(([key]) => key === selectedKey)[1];
  return {items:FjordCategories.filter(items, selectedKey), label:selectedKey === 'all' ? null : label};
}
