/* Shared episode ordering for web, Windows and TV clients. ES5 for webOS. */
(function (root) {
  'use strict';
  function coordinates(movie) {
    var c = movie && movie.catalog || {};
    return typeof c.season === 'number' && typeof c.episode === 'number' &&
      isFinite(c.season) && isFinite(c.episode) && c.season >= 0 && c.episode >= 0 ? c : null;
  }
  function next(items, current) {
    var at = coordinates(current);
    if (!current || !current.series_key || !at) return null;
    return items.filter(function (m) {
      var c = coordinates(m);
      return m.id !== current.id && m.series_key === current.series_key && c &&
        (c.season > at.season || c.season === at.season && c.episode > at.episode);
    }).sort(function (a,b) {
      return a.catalog.season-b.catalog.season || a.catalog.episode-b.catalog.episode || String(a.id).localeCompare(String(b.id));
    })[0] || null;
  }
  var api = {next:next, countdown:function (duration, position) {
    if (!(duration > 0) || !isFinite(duration) || !isFinite(position) || position < 0) return null;
    var remaining = duration-position;
    return remaining <= 10 && remaining >= -1 ? Math.max(0,Math.ceil(remaining)) : null;
  }};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FjordEpisodes = api;
}(this));
