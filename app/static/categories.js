const FjordCategories = {
  definitions: [
    ['all', 'Alle', []],
    ['action', 'Action', ['action', 'action & adventure']],
    ['adventure', 'Eventyr', ['eventyr', 'adventure', 'action & adventure']],
    ['animation', 'Animation', ['animation']],
    ['comedy', 'Komedie', ['komedie', 'comedy']],
    ['crime', 'Krimi', ['krimi', 'crime', 'kriminalitet']],
    ['documentary', 'Dokumentar', ['dokumentar', 'documentary']],
    ['drama', 'Drama', ['drama']],
    ['family', 'Familie og børn', ['familie', 'family', 'kids', 'børn']],
    ['fantasy', 'Fantasy', ['fantasy', 'fantasi', 'sci-fi & fantasy']],
    ['history', 'Historie', ['historie', 'history', 'historisk']],
    ['horror', 'Gyser', ['gyser', 'horror', 'gys']],
    ['music', 'Musik', ['musik', 'music']],
    ['mystery', 'Mystik', ['mystik', 'mystery', 'mysterium']],
    ['romance', 'Romantik', ['romantik', 'romance', 'romantisk']],
    ['scifi', 'Sci-fi', ['science fiction', 'sci-fi', 'sci-fi & fantasy']],
    ['thriller', 'Thriller', ['thriller']],
    ['war', 'Krig og politik', ['krig', 'war', 'war & politics']],
    ['western', 'Western', ['western']],
    ['reality', 'Reality', ['reality']],
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
  document.querySelector('.library-heading').insertAdjacentHTML('afterend',
    '<div id="library-categories" class="library-categories" role="group" aria-label="Genrekategorier" hidden></div>');
}
function renderCategories(items) {
  const container = $('library-categories');
  container.hidden = !['all', 'series'].includes(view);
  if (container.hidden) return {items, label:null};
  const selectedKey = categorySelection[view];
  // Keep the buttons in place while searching, so keyboard focus is preserved.
  if (!container.children.length) {
    for (const [key, label] of FjordCategories.definitions) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'category-button'; button.dataset.category = key;
      button.onclick = () => {categorySelection[view] = key; render();};
      container.append(button);
    }
  }
  for (const button of container.children) {
    const [key, label] = FjordCategories.definitions.find(([key]) => key === button.dataset.category);
    const count = FjordCategories.filter(items, key).length;
    button.textContent = `${label} (${count})`;
    button.setAttribute('aria-pressed', String(selectedKey === key));
  }
  const label = FjordCategories.definitions.find(([key]) => key === selectedKey)[1];
  return {items:FjordCategories.filter(items, selectedKey), label:selectedKey === 'all' ? null : label};
}
