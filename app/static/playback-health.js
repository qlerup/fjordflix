/* Per-playback measurements only; never retain media URLs or ticket data. */
const FjordPlaybackHealth = {
  mediaError(error) {
    const labels = {1:'Afspilningen blev afbrudt', 2:'Netværksfejl under hentning af video',
      3:'Browseren kunne ikke afkode videoen', 4:'Browseren afviste videoformatet'};
    return `${labels[error?.code] || 'Ukendt videofejl'} (kode ${error?.code || 0}).`;
  },
  create(video) {
    let waits = 0, segment = null, recoveries = 0, pendingError = null;
    const errors = [];
    return {
      recoverDecode(hls) {
        // Reset a failed MediaSource once, preserving the HLS playhead/session.
        // Network errors and repeated decoder failures need explicit diagnosis.
        if (pendingError && (!video.error || video.error === pendingError)) return true;
        if (video.error?.code !== 3 || recoveries || typeof hls?.recoverMediaError !== 'function') return false;
        recoveries++;
        pendingError = video.error;
        try { hls.recoverMediaError(); return true; } catch { pendingError = null; return false; }
      },
      playing() { pendingError = null; },
      waiting() { if (!video.paused && !video.seeking && !video.ended && video.currentTime > 0) waits++; },
      fragment(data) {
        const stats = data.frag?.stats || data.stats;
        const duration = data.frag?.duration;
        const ms = stats?.loading?.end - stats?.loading?.start;
        if (Number.isFinite(ms) && ms >= 0 && Number.isFinite(duration) && duration > 0)
          segment = {seconds:ms / 1000, duration};
      },
      error(data) {
        // HLS detail identifiers only, not messages, URLs, requests or responses.
        if (/^[a-zA-Z0-9_-]{1,80}$/.test(data.details || '')) {
          errors.push({detail:data.details, fatal:!!data.fatal});
          if (errors.length > 10) errors.shift();
        }
      },
      snapshot() {
        let buffer = 0;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
            buffer = video.buffered.end(i) - video.currentTime;
            break;
          }
        }
        const frames = video.getVideoPlaybackQuality?.();
        return {buffer, waits, recoveries, segment:segment && {...segment}, errors:errors.map(e => ({...e})),
          dropped:frames?.droppedVideoFrames, total:frames?.totalVideoFrames};
      },
      label() {
        const s = this.snapshot();
        const parts = [`Buffer: ${s.buffer.toFixed(1)} s`];
        if (Number.isFinite(s.dropped) && Number.isFinite(s.total)) parts.push(`Tabte billeder: ${s.dropped}/${s.total}`);
        parts.push(`Bufferstop: ${s.waits}`);
        if (s.recoveries) parts.push(`Genoprettelsesforsøg: ${s.recoveries}`);
        if (s.segment) parts.push(`Segment hentet: ${s.segment.seconds.toFixed(2)} s / ${s.segment.duration.toFixed(2)} s video`);
        if (s.errors.length) parts.push(`HLS: ${s.errors.at(-1).detail}`);
        return parts.join(' · ');
      }
    };
  }
};
if (typeof module !== 'undefined') module.exports = FjordPlaybackHealth;
