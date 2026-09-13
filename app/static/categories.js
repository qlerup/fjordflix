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

const categorySelection = {all:'all', series:'all', favorites:'all'};
function setupCategories() {
  const section = document.querySelector('.library');
  const content = document.createElement('div'); content.className = 'library-results';
  content.append(...section.childNodes); section.append(content);
  section.insertAdjacentHTML('afterbegin', `<aside id="library-categories" class="library-categories" hidden aria-labelledby="categories-title">
    <a class="sidebar-brand" href="/" aria-label="FjordFlix hjem"><img src="/static/logos/source/fjordflix-horizontal-dark.svg" alt="FjordFlix"></a>
    <section id="sidebar-library"><span class="sidebar-section-label">BIBLIOTEK</span><nav id="sidebar-browse" aria-label="Bibliotek">
    <button class="sidebar-view" data-side-view="home">Hjem</button><button class="sidebar-view" data-side-view="all">Film</button>
    <button class="sidebar-view" data-side-view="series">Serier</button><button class="sidebar-view" data-side-view="favorites">Min liste</button></nav></section>
    <button id="sidebar-back" class="sidebar-view" type="button" hidden aria-label="Tilbage til bibliotek"><span aria-hidden="true">←</span> Tilbage</button>
    <section id="sidebar-genres"><h2 id="categories-title">Genrer</h2><nav id="categories-links" aria-label="Genrer"></nav></section>
    <div class="sidebar-foot">Din biograf.<br>På dine præmisser.</div></aside>`);
  document.querySelectorAll('[data-side-view]').forEach(button => {
    button.onclick = () => document.querySelector(`header [data-view="${button.dataset.sideView}"]`)?.click();
  });
  $('sidebar-back').onclick = () => {
    document.querySelector('header [data-view="home"]')?.click();
    document.querySelector('[data-side-view="home"]').focus();
  };
}

function renderCategories(items, availableItems = items) {
  const container = $('library-categories');
  container.hidden = false;
  document.body.classList.add('has-library-sidebar');
  const genresVisible = ['all', 'series', 'favorites'].includes(view);
  $('sidebar-library').hidden = genresVisible;
  $('sidebar-back').hidden = !genresVisible;
  $('sidebar-genres').hidden = !genresVisible;
  document.querySelectorAll('[data-side-view]').forEach(button => {
    if (button.dataset.sideView === view) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  if (!genresVisible) return {items, label:null};
  const choices = FjordCategories.definitions.filter(([key]) => key === 'all' || FjordCategories.filter(availableItems, key).length);
  if (!choices.some(([key]) => key === categorySelection[view])) categorySelection[view] = 'all';
  const selectedKey = categorySelection[view], links = $('categories-links');
  $('categories-title').textContent = 'GENRER';
  const signature = view + ':' + choices.map(([key]) => key).join(',');
  if (links.dataset.choices !== signature) {
    links.replaceChildren(...choices.map(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'category-link'; button.dataset.category = key;
      button.textContent = key === 'all' ? (view === 'series' ? 'Alle serier' : view === 'favorites' ? 'Alle på min liste' : 'Alle film') : label;
      button.onclick = () => {categorySelection[view] = key; render();};
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
