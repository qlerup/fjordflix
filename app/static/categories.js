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
    '<div id="library-categories" class="library-categories" hidden><select id="library-genre" aria-label="Genrer"></select></div>');
  $('library-genre').onchange = () => {categorySelection[view] = $('library-genre').value; render();};
}
function renderCategories(items, availableItems = items) {
  const container = $('library-categories');
  container.hidden = !['all', 'series'].includes(view);
  if (container.hidden) return {items, label:null};
  const choices = FjordCategories.definitions.filter(([key]) => key === 'all' || FjordCategories.filter(availableItems, key).length);
  if (!choices.some(([key]) => key === categorySelection[view])) categorySelection[view] = 'all';
  const selectedKey = categorySelection[view], select = $('library-genre');
  const signature = choices.map(([key]) => key).join(',');
  if (select.dataset.choices !== signature) {
    select.replaceChildren(...choices.map(([key, label]) => new Option(key === 'all' ? 'Alle genrer' : label, key)));
    select.dataset.choices = signature;
  }
  select.value = selectedKey;
  const label = FjordCategories.definitions.find(([key]) => key === selectedKey)[1];
  return {items:FjordCategories.filter(items, selectedKey), label:selectedKey === 'all' ? null : label};
}
