/* Standalone responsive UI regression check. No running backend or real accounts required.
 * Run: node tests/mobile-browser.cjs
 * Optional: MOBILE_QA_WIDTHS=390 MOBILE_QA_PREFIX=before node tests/mobile-browser.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright;
for (const candidate of ['playwright', '../desktop/node_modules/playwright', '../../fjordflix-XBOX-APP/node_modules/playwright']) {
  try { playwright = require(candidate); break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
if (!playwright) throw new Error('Install Playwright or use the existing desktop/Xbox node_modules.');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results/mobile');
const prefix = process.env.MOBILE_QA_PREFIX ? `${process.env.MOBILE_QA_PREFIX}-` : '';
const widths = (process.env.MOBILE_QA_WIDTHS || '320,390,430,768,800,1440').split(',').map(Number);
const overview = 'En uventet rejse langs den danske kyst bringer gamle venner sammen igen. En fortælling om de valg, der former os, og de mennesker, vi møder undervejs.';
const names = ['Ved verdens ende', 'Den sidste sommer', 'Nattens hemmeligheder', 'Et sted mellem himmel og hav', 'Familien på farten', 'Mørket kalder', 'Uden for kortet', 'En ganske almindelig tirsdag'];
function fixtures() {
  return names.map((title, i) => ({
    id: (i + 1).toString(16).padStart(32, '0'), title,
    width: i % 2 ? 1920 : 3840, height: i % 2 ? 1080 : 2160,
    format: 'matroska', video: 'hevc', audio: 'eac3', duration: 7200 + i * 300,
    size: 1234567890, bitrate: 25000000, position: i < 2 ? 1830 : 0, favorite: i === 1,
    quality: {dynamic_range: 'HDR10', audio_codec: 'eac3', audio_channels: 6, audio_layout: '5.1'},
    catalog: {status: 'matched', manual: true, overview, genres: [i % 2 ? 'Drama' : 'Eventyr'], release_date: '2026-01-01', rating: 7.8, votes: 100, tmdb_id: i + 42},
  })).concat([1, 2, 3].map(episode => ({
    id: (episode + 20).toString(16).padStart(32, '0'), title: `Nordlys S01E0${episode}`,
    width: 1920, height: 1080, format: 'mp4', video: 'h264', audio: 'aac', duration: 2700,
    size: 123456789, bitrate: 5000000, position: 0, series_key: 'nordlys',
    catalog: {status: 'matched', manual: true, media_type: 'tv', series_title: 'Nordlys', series_overview: overview,
      overview, season: 1, episode, episode_title: ['En ny begyndelse', 'Det der gemmer sig under overfladen', 'Når lyset vender tilbage'][episode - 1], genres: ['Drama'], release_date: '2026-02-01'},
  })));
}
function artwork(id, landscape) {
  const hues = [205, 26, 275, 164, 41, 335, 214, 98];
  const index = parseInt(id.slice(-2), 16) % hues.length;
  const hue = hues[index], width = landscape ? 1200 : 400, height = 600;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="hsl(${hue} 35% 42%)"/><stop offset="1" stop-color="hsl(${hue} 30% 9%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#sky)"/><circle cx="${width * .68}" cy="160" r="90" fill="hsl(${hue + 40} 40% 75%)" opacity=".8"/><path d="M0 440L${width * .3} 260L${width * .52} 390L${width * .7} 310L${width} 450V600H0" fill="hsl(${hue} 30% 18%)"/><path d="M0 510Q${width * .5} 390 ${width} 530V600H0" fill="hsl(${hue} 30% 10%)"/><text x="24" y="545" fill="#fff" font-family="Arial" font-size="26" letter-spacing="3">FJORD ORIGINALS</text><rect x="12" y="12" width="${width - 24}" height="576" fill="none" stroke="#fff" opacity=".15"/></svg>`;
}
async function mockApp(page, options = {}) {
  let authenticated = false;
  const movies = options.empty ? [] : fixtures(), unexpected = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), endpoint = url.pathname;
    if (endpoint === '/') return route.fulfill({path: path.join(root, 'app/static/index.html'), contentType: 'text/html'});
    if (endpoint.startsWith('/static/')) return route.fulfill({path: path.join(root, 'app', endpoint.slice(1))});
    const art = endpoint.match(/^\/api\/movies\/([a-f0-9]+)\/(poster|backdrop|episode-still)$/);
    if (art) return route.fulfill({contentType: 'image/svg+xml', body: artwork(art[1], art[2] !== 'poster' || art[1] === '2'.padStart(32, '0'))});
    let data;
    if (endpoint === '/api/state') data = {user: authenticated ? {id: 'qa', name: 'Sofie', admin: options.admin !== false} : null, managed: false, setup: false};
    else if (endpoint === '/api/login') {
      if (route.request().postDataJSON().password === 'wrong-password') return route.fulfill({status: 401, contentType: 'application/json', body: JSON.stringify({detail: 'Brugernavn eller adgangskode er forkert.'})});
      authenticated = true; data = {ok: true};
    }
    else if (endpoint === '/api/logout') {authenticated = false; data = {ok: true};}
    else if (endpoint === '/api/movies') data = movies;
    else if (endpoint.endsWith('/favorite')) {const movie = movies.find(item => endpoint.includes(item.id)); movie.favorite = !movie.favorite; data = {ok: true};}
    else if (endpoint.endsWith('/credits')) data = {cast: ['Anna Sørensen', 'Oliver Madsen', 'Clara Nielsen', 'William Jensen', 'Emma Andersen', 'Oscar Pedersen'].map((name, i) => ({name, character: ['Signe', 'Elias', 'Marie', 'Johan', 'Sofie', 'Mikkel'][i]}))};
    else if (endpoint.endsWith('/tracks')) data = {audio: [
      {index: 1, language: 'dan', title: 'Dansk surround', codec: 'eac3', layout: '5.1', default: true},
      {index: 2, language: 'eng', title: 'Original lyd', codec: 'aac', layout: 'stereo'},
    ], subtitles: [{index: 3, language: 'dan', title: 'Danske undertekster', codec: 'subrip', delivery: 'text'}], defaults: {audio_track: 1, subtitle_track: null}};
    else if (endpoint.endsWith('/plan')) data = {mode: 'Direct Play', height: 2160, mbps: 25, reason: 'Original video og lyd afspilles direkte på enheden.'};
    else if (endpoint === '/api/admin') data = {gpu: true, free_gb: 1234, streams: 1, max_streams: 4,
      users: [{name: 'Sofie', admin: true}, {name: 'En bruger med et meget langt visningsnavn', admin: false}]};
    else if (endpoint === '/api/admin/onboarding') data = {pending: false};
    else if (endpoint === '/api/admin/library') data = {sources: [{id: 'source-1', path: '/mnt/familiebibliotek/film-og-serier/originale-mediefiler', available: true, count: movies.length}], scan: {running: false, added: 0, updated: 0, errors: []}};
    else if (endpoint === '/api/admin/library/browse') data = {path: '', parent: null, directories: [{name: 'Familiebibliotek', path: '/mnt/familiebibliotek'}]};
    else if (endpoint === '/api/admin/media') data = {web_url: 'https://film.example.test', media_url: 'https://media.example.test', enabled: true};
    else if (endpoint === '/api/admin/metadata') data = {configured: false};
    else if (endpoint === '/api/admin/opensubtitles') data = {configured: false, username: ''};
    else if (endpoint === '/api/admin/subtitles') data = {provider: 'opensubtitles', configured: false, automatic: false};
    else if (endpoint === '/api/admin/active-streams') data = {streams: [{id: 'qa-playback', movie_id: movies[0].id, title: movies[3].title, user: 'Sofie', client: 'Browser på mobil', poster: `/api/movies/${movies[0].id}/poster`, duration: 7200, position: 1830, state: 'playing', mode: 'Direct Play', height: 2160, mbps: 25, video: {source: 'hevc', output: 'hevc', transcoded: false}, audio: {codec: 'eac3', language: 'dan', title: 'Dansk surround'}, subtitle: null, audio_transcoded: false, encoder: 'Original · afspilles lokalt'}]};
    else if (endpoint.endsWith('/subtitle-search')) data = {message: '', results: []};
    else {unexpected.push(endpoint); return route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({detail: 'Unexpected mock endpoint: ' + endpoint})});}
    return route.fulfill({contentType: 'application/json', body: JSON.stringify(data)});
  });
  return {unexpected};
}
async function noOverflow(page, label, selector = 'html') {
  const result = await page.locator(selector).evaluate(element => ({
    client: element.clientWidth, scroll: element.scrollWidth,
    offenders: [...element.querySelectorAll('*')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width && rect.right > innerWidth + 1 && !el.closest('#detail-cast,#series-episodes,.fx-select-menu,#categories-links,.settings-nav');
    }).slice(0, 6).map(el => `${el.tagName}#${el.id}.${el.className}`),
  }));
  assert.ok(result.scroll <= result.client + 1, `${label}: horizontal overflow ${JSON.stringify(result)}`);
}
async function snapshot(page, width, name, selector = 'html') {
  await page.screenshot({path: path.join(output, `${prefix}${width}-${name}.png`), fullPage: true, animations: 'disabled'});
  if (['home', 'films', 'detail', 'player', 'player-tracks', 'settings-library'].includes(name)) {
    await page.screenshot({path: path.join(output, `${prefix}${width}-${name}-viewport.png`), animations: 'disabled'});
  }
  await noOverflow(page, `${width}px ${name}`, selector);
  await noOverflow(page, `${width}px ${name} document`);
  if (name === 'player-tracks') {
    const sheet = await page.locator('#player-tracks').boundingBox();
    const close = await page.locator('#player-tracks-close').boundingBox();
    const viewport = page.viewportSize();
    assert.ok(sheet.x >= 0 && sheet.y >= 0 && sheet.x + sheet.width <= viewport.width + 1 && sheet.y + sheet.height <= viewport.height + 1, 'player tracks sheet stays inside viewport');
    assert.ok(close.height < 80, 'player tracks close button does not stretch');
    if (viewport.width <= 800 && viewport.height > viewport.width) assert.ok(sheet.height <= Math.min(viewport.height * .8, 500), 'portrait track settings stay compact');
  }
}
async function choose(page, id, pattern) {
  await page.locator(`.fx-select-button[data-select-id="${id}"]`).click();
  const menu = page.locator(`.fx-select-menu:visible:has([data-select-id="${id}"])`);
  const box = await menu.boundingBox(), viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= viewport.height + 1, `${id} menu fits viewport`);
  await menu.getByRole('option', {name: pattern}).click();
}
(async () => {
  fs.mkdirSync(output, {recursive: true});
  const browser = await playwright[process.env.MOBILE_QA_BROWSER || 'chromium'].launch({headless: true});
  try {
    for (const width of widths) {
      const context = await browser.newContext({viewport: {width, height: width >= 1000 ? 1000 : 844}, isMobile: width <= 800, hasTouch: width <= 800, reducedMotion: 'reduce'});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
      const fixture = await mockApp(page);
      await page.goto('http://fjordflix.test');
      await page.locator('#auth-submit').waitFor();
      await snapshot(page, width, 'login');
      await page.locator('#username').fill('Sofie');
      await page.locator('#password').fill('qa-password');
      await page.locator('#auth-submit').click();
      await page.locator('#movie-grid .movie-card').first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('#movie-grid img')].every(img => img.complete));
      for (const grid of ['movie-grid', 'continue-grid']) {
        const heights = await page.locator(`#${grid} .movie-image`).evaluateAll(images => images.map(image => image.getBoundingClientRect().height));
        assert.ok(Math.max(...heights) - Math.min(...heights) < 1, `${grid}: portrait and landscape artwork have equal heights`);
      }
      if (width > 800) {
        const controls = await page.locator('#remote-open, #search, #admin-open, #logout').evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return {height:box.height, center:box.y + box.height / 2};
        }));
        assert.ok(controls.every(control => Math.abs(control.height - 44) < 1), 'desktop header controls have equal heights');
        assert.ok(Math.max(...controls.map(control => control.center)) - Math.min(...controls.map(control => control.center)) < 1, 'desktop header controls are vertically aligned');
      }
      await snapshot(page, width, 'home');
      const navigate = async view => {
        const headerButton = page.locator(`header [data-view="${view}"]`);
        if (await headerButton.isVisible()) return headerButton.click();
        const sidebarButton = page.locator(`[data-side-view="${view}"]`);
        if (!(await sidebarButton.isVisible())) await page.locator('#sidebar-back').click();
        await sidebarButton.click();
      };
      if (width <= 800) {
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        const nav = page.locator('#shell > header > nav'), navBox = await nav.boundingBox();
        assert.ok(navBox.y >= 0 && navBox.y + navBox.height <= page.viewportSize().height + 1, 'bottom navigation stays reachable while scrolling');
        for (const button of await nav.locator('button').all()) {
          const box = await button.boundingBox();
          assert.ok(box.width >= 44 && box.height >= 44, 'navigation touch target at least 44px');
        }
      }
      await navigate('all');
      assert.equal(await page.locator('#movie-grid .movie-card').count(), 8);
      await snapshot(page, width, 'films');
      const attribution = page.locator('.catalog-attribution');
      await attribution.locator('summary').click();
      const attributionBox = await attribution.boundingBox();
      if (width > 800) {
        const sidebarBox = await page.locator('#library-categories').boundingBox();
        assert.ok(attributionBox.x >= sidebarBox.x + sidebarBox.width, 'TMDB attribution clears the sidebar');
      }
      await snapshot(page, width, 'attribution');
      await attribution.locator('summary').click();
      if (width <= 800) {
        const lastCard = page.locator('#movie-grid .movie-card').last();
        await lastCard.scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => scrollY > 100), 'regression starts below the top of a long film list');
        await lastCard.click();
        await page.locator('#detail').waitFor();
        await navigate('home');
        await page.locator('#detail').waitFor({state: 'hidden'});
        assert.equal(await page.evaluate(() => scrollY), 0, 'home navigation from a lower film detail resets scroll after closing details');
        assert.ok(await page.locator('#hero').isVisible());
        await navigate('all');
      }
      await page.locator('[data-category="drama"]').click();
      assert.equal(await page.locator('#movie-grid .movie-card').count(), 4);
      await snapshot(page, width, 'genre');
      await page.locator('[data-category="all"]').click();
      await page.locator('#search').fill('sommer');
      assert.equal(await page.locator('#movie-grid .movie-card').count(), 1);
      await snapshot(page, width, 'search');
      await page.locator('#search').fill('ingen-match-i-biblioteket');
      assert.ok(await page.locator('#empty').isVisible());
      await snapshot(page, width, 'empty-search');
      await page.locator('#search').fill('');
      await page.locator('#movie-grid .movie-card').first().click();
      await page.waitForFunction(() => document.getElementById('plan-badge').textContent === 'Direct Play');
      assert.ok(page.url().includes('#title/'));
      if (width <= 800) {
        assert.ok(await page.locator('#detail-tracks').isHidden(), 'advanced playback options start collapsed');
        assert.ok(await page.locator('#play-button').isVisible(), 'play remains outside advanced settings');
        await page.evaluate(() => scrollTo(0,0));
        await snapshot(page, width, 'detail-simple');
        await page.locator('#detail-playback-options > summary').click();
      }
      await choose(page, 'detail-subtitle', /Dansk/);
      assert.equal(await page.locator('#detail-subtitle').inputValue(), '3');
      await choose(page, 'detail-quality', /Original kvalitet/);
      await snapshot(page, width, 'detail', '#detail');
      // Layout-only player fixture: stream delivery is tested separately by the media suites.
      await page.evaluate(() => {
        document.getElementById('player-dialog').showModal();
        document.getElementById('player-title').textContent = selected.title;
        document.getElementById('player-loading').hidden = true;
        fitPlayerViewport(); wakePlayerControls();
      });
      await snapshot(page, width, 'player', '#player-dialog');
      for (const selector of ['#player-close', '#player-toggle', '#player-tracks-toggle', '#player-fullscreen']) {
        const box = await page.locator(selector).boundingBox(), viewport = page.viewportSize();
        assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= viewport.height + 1, `${selector} stays inside the player`);
      }
      await page.locator('#player-tracks-toggle').click();
      await snapshot(page, width, 'player-tracks', '#player-tracks');
      await choose(page, 'player-subtitle', /Dansk/);
      await page.locator('#player-tracks-close').click();
      if (width === 390) {
        await page.setViewportSize({width: 844, height: 390});
        await page.evaluate(() => {fitPlayerViewport(); wakePlayerControls();});
        await snapshot(page, '844x390', 'player', '#player-dialog');
        await page.locator('#player-tracks-toggle').click();
        await snapshot(page, '844x390', 'player-tracks', '#player-tracks');
        await choose(page, 'player-subtitle', /Dansk/);
        await page.locator('#player-tracks-close').click();
        await page.setViewportSize({width, height: 844});
      }
      await page.locator('#player-close').click();
      await page.locator('#favorite-button').click();
      if (width <= 800) await page.locator('#detail-management > summary').click();
      await page.locator('#subtitle-find').click();
      await snapshot(page, width, 'subtitle-search', '#subtitle-search-dialog');
      await page.locator('#subtitle-search-submit').click();
      await page.waitForFunction(() => document.getElementById('subtitle-search-status').textContent.includes('Ingen undertekster'));
      await page.locator('#subtitle-search-close').click();
      await navigate('favorites');
      assert.ok(await page.locator('#detail').isHidden());
      assert.equal(await page.locator('#movie-grid .movie-card').count(), 2);
      await snapshot(page, width, 'favorites');
      await navigate('series');
      assert.equal(await page.locator('#movie-grid .movie-card').count(), 1);
      await page.locator('#movie-grid .movie-card').click();
      await page.locator('#series-episodes .episode-card').nth(1).click();
      assert.match(await page.locator('#detail-episode').textContent(), /S01E02/);
      await snapshot(page, width, 'series-detail', '#detail');
      await page.locator('#detail-back').click();
      await page.locator('#detail').waitFor({state: 'hidden'});
      await page.locator('#upload-open').click();
      await snapshot(page, width, 'upload', '#upload-dialog');
      await page.locator('[data-close="upload-dialog"]').click();
      await page.locator('#admin-open').click();
      await page.locator('.source-row').first().waitFor();
      for (const tab of ['library', 'active-streams', 'media', 'metadata', 'subtitles', 'users', 'server']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click();
        await page.locator(`[data-settings-panel="${tab}"]`).waitFor();
        if (tab === 'active-streams') await page.locator('.stream-card').waitFor();
        if (tab === 'media') {
          assert.equal(await page.locator('#playback-buffer').inputValue(), '60');
          await choose(page, 'playback-buffer', '120 sekunder');
          assert.ok((await page.locator('#playback-buffer-status').textContent()).includes('Gemt'));
        }
        await snapshot(page, width, `settings-${tab}`, '.settings-content');
      }
      await page.locator('[data-close="admin-dialog"]').click();
      await page.reload();
      await page.locator('#admin-open').click();
      await page.locator('[data-settings-tab="media"]').click();
      assert.equal(await page.locator('#playback-buffer').inputValue(), '120', 'buffer preference survives reload');
      assert.equal(await page.evaluate(() => playbackBufferSeconds()), 120);
      await page.locator('[data-close="admin-dialog"]').click();
      await navigate('home');
      await page.locator('#logout').click();
      await page.locator('#auth-submit').waitFor();
      assert.deepEqual(fixture.unexpected, [], `${width}px unexpected network calls`);
      assert.deepEqual(errors, [], `${width}px browser errors`);
      await context.close();
      console.log(`PASS ${width}px: login, library, genres/search, empty state, details/tracks, favorites, episodes, upload, all settings, logout; no overflow or browser errors`);
    }
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, reducedMotion: 'reduce'});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const fixture = await mockApp(page, {admin: false, empty: true});
    await page.goto('http://fjordflix.test');
    await page.locator('#username').fill('Sofie');
    await page.locator('#password').fill('wrong-password');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => document.getElementById('auth-error').textContent.includes('forkert'));
    assert.ok(await page.locator('#auth-submit').isEnabled(), 'failed login leaves form retryable');
    await snapshot(page, 390, 'login-error');
    await page.locator('#password').fill('qa-password');
    await page.locator('#auth-submit').click();
    await page.locator('#shell').waitFor();
    assert.ok(await page.locator('#empty').isVisible());
    for (const selector of ['#admin-open', '#upload-open', '#hero-action']) assert.ok(await page.locator(selector).isHidden(), `${selector} is unavailable for nonadmins`);
    await snapshot(page, 390, 'empty-library-nonadmin');
    assert.deepEqual(fixture.unexpected, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS 390px nonadmin: failed login, retry, empty library and correct action visibility');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
