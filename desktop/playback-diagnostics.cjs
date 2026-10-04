// Bounded diagnostics: never persist media tickets or signed URLs.
function clean(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, '[adresse skjult]')
    .replace(/\/media\/[A-Za-z0-9_-]{43}/g, '/media/[billet skjult]')
    .replace(/[A-Za-z0-9_-]{43}/g, '[token skjult]').slice(0, 2000);
}
function createDiagnostics({version, title, start, now = () => new Date().toISOString()}) {
  const events = [];
  const status = {stage:'opening', requestedStart:start};
  function record(kind, detail) {
    events.push({time:now(), kind, detail:clean(detail)});
    if (events.length > 60) events.shift();
  }
  function receive(message) {
    if (message.event === 'log-message') record(message.prefix || 'mpv', message.text);
    if (['start-file','file-loaded','playback-restart','end-file'].includes(message.event)) {
      status.stage = message.event;
      record(message.event, message.file_error || message.reason || '');
    }
    if (message.event === 'property-change' && ['pause','paused-for-cache','time-pos','demuxer-cache-duration','cache-speed','seeking'].includes(message.name)) {
      if (typeof message.data === 'number' || typeof message.data === 'boolean') status[message.name] = message.data;
    }
    if (message.request_id === 100 && message.error && message.error !== 'success') {
      record('loadfile-error', message.error);
      return 'Afspilleren afviste åbningen af filmen: ' + clean(message.error);
    }
    if (message.event === 'end-file' && message.reason === 'error') {
      return 'Afspilleren kunne ikke åbne eller afkode filmen: ' + clean(message.file_error || 'ukendt mpv-fejl');
    }
    return null;
  }
  return {record, receive, snapshot:() => ({version, title:clean(title), capturedAt:now(), status:{...status}, events:[...events]})};
}
module.exports = {createDiagnostics, clean};
