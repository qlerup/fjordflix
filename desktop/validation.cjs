function serverUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('Brug serverens http(s)-adresse uden sti eller login.');
  return u.origin;
}
function selection(data) {
  if (!data || !/^[a-f0-9]{32}$/.test(data.id) || !Number.isFinite(data.start) || data.start < 0 || data.start > 1e8) throw Error('Ugyldig film eller startposition.');
  for (const field of ['audio_track', 'subtitle_track']) if (data[field] != null && (!Number.isSafeInteger(data[field]) || data[field] < 0)) throw Error('Ugyldigt spor.');
  return {id: data.id, start: data.start, audio_track: data.audio_track ?? null, subtitle_track: data.subtitle_track ?? null};
}
function mediaUrl(value, origin) {
  const u = new URL(value, origin);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !/^\/media\/[A-Za-z0-9_-]{43}\/movies\/[a-f0-9]{32}\/(file|subtitles\/\d+\.vtt)$/.test(u.pathname)) throw Error('Ugyldig videoadresse.');
  return u.href;
}
module.exports = {serverUrl, selection, mediaUrl};
