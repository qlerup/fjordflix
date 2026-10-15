/* Per-playback measurements only; never retain media URLs or ticket data. */
const FjordPlaybackHealth = {
  mediaError(error) {
    const labels = {1:'Afspilningen blev afbrudt', 2:'Netværksfejl under hentning af video',
      3:'Browseren kunne ikke afkode videoen', 4:'Browseren afviste videoformatet'};
    return `${labels[error?.code] || 'Ukendt videofejl'} (kode ${error?.code || 0}).`;
  },
  create(video, now = () => Date.now(), watchFrozenFrames = false) {
    let waits = 0, segment = null, recoveries = 0, pendingError = null;
    let frameSample = null, recentFrames = null;
    let freezeSample = null, freezeAdvance = 0, presentedFrames = 0;
    let videoFrameRequest = null, watching = true, hasFrameCallback = false;
    // Prefer actual presented frames over decoder-only counters: Safari may
    // advance the audio clock while leaving the last picture on screen.
    if (watchFrozenFrames && typeof video.requestVideoFrameCallback === 'function') {
      const presented = () => {
        if (!watching) return;
        presentedFrames++;
        try { videoFrameRequest = video.requestVideoFrameCallback(presented); }
        catch (_) { videoFrameRequest = null; }
      };
      try { videoFrameRequest = video.requestVideoFrameCallback(presented); hasFrameCallback = true; }
      catch (_) { videoFrameRequest = null; }
    }
    const resetFreeze = () => { freezeSample = null; freezeAdvance = 0; };
    const displayedFrames = () => {
      if (hasFrameCallback) return presentedFrames;
      try {
        const quality = video.getVideoPlaybackQuality?.();
        if (Number.isFinite(quality?.totalVideoFrames)) {
          const dropped = Number.isFinite(quality?.droppedVideoFrames) ? quality.droppedVideoFrames : 0;
          return Math.max(0, quality.totalVideoFrames - dropped);
        }
      } catch (_) {}
      if (Number.isFinite(video.webkitDecodedFrameCount)) return video.webkitDecodedFrameCount;
      // Zero dimensions are a reliable signal only while the audio clock runs.
      if (video.videoWidth === 0 || video.videoHeight === 0) return 0;
      return null; // No observable frame metric: avoid claiming a frozen picture.
    };
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
      playing() { pendingError = null; frameSample = recentFrames = null; resetFreeze(); },
      frozenFrame(active = true) {
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (!watchFrozenFrames || !active || hidden || video.paused || video.seeking ||
            video.ended || video.readyState < 2) { resetFreeze(); return false; }
        const count = displayedFrames(), position = Number(video.currentTime), at = now();
        if (!Number.isFinite(count) || !Number.isFinite(position)) { resetFreeze(); return false; }
        const next = {count, position, at};
        if (!freezeSample) { freezeSample = next; return false; }
        const elapsed = (at - freezeSample.at) / 1000;
        const advance = position - freezeSample.position;
        // Reset after seeks, clock discontinuities and suspended browser timers.
        if (elapsed <= 0 || elapsed > 6 || advance < 0 ||
            advance > elapsed * Math.max(1, Number(video.playbackRate) || 1) * 2 + 2) {
          resetFreeze(); freezeSample = next; return false;
        }
        if (count > freezeSample.count || advance < 0.4) freezeAdvance = 0;
        else freezeAdvance += advance;
        freezeSample = next;
        return freezeAdvance >= 6;
      },
      close() {
        watching = false;
        if (videoFrameRequest !== null) {
          try { video.cancelVideoFrameCallback?.(videoFrameRequest); } catch (_) {}
        }
        videoFrameRequest = null;
        resetFreeze();
      },
      waiting() { resetFreeze(); frameSample = recentFrames = null; if (!video.paused && !video.seeking && !video.ended && video.currentTime > 0) waits++; },
      sampleFrames() {
        const frames = video.getVideoPlaybackQuality?.();
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (video.paused || video.seeking || video.ended || video.readyState < 3 || hidden ||
            !Number.isFinite(frames?.totalVideoFrames) || !Number.isFinite(frames?.droppedVideoFrames)) {
          frameSample = recentFrames = null; return;
        }
        const current = {at:now(), position:video.currentTime, total:frames.totalVideoFrames, dropped:frames.droppedVideoFrames};
        if (frameSample) {
          const seconds = (current.at-frameSample.at)/1000;
          const total = current.total-frameSample.total, dropped = current.dropped-frameSample.dropped;
          // Timer suspension, seek and source/counter resets are not playback samples.
          const advance = current.position-frameSample.position;
          if (seconds > 0 && total > 0 && dropped >= 0 && dropped <= total && advance > 0 &&
              advance <= seconds*2* (video.playbackRate || 1) && seconds <= 10)
            recentFrames = {seconds, dropped, total, percent:100*dropped/total};
          else recentFrames = null;
        }
        frameSample = current;
      },
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
          recentFrames:recentFrames && {...recentFrames},
          dropped:frames?.droppedVideoFrames, total:frames?.totalVideoFrames};
      },
      label() {
        this.sampleFrames();
        const s = this.snapshot();
        const parts = [`Buffer: ${s.buffer.toFixed(1)} s`];
        if (Number.isFinite(s.dropped) && Number.isFinite(s.total)) parts.push(`Tabte billeder: ${s.dropped}/${s.total}`);
        if (s.recentFrames) parts.push(`Seneste ${s.recentFrames.seconds.toFixed(1)} s: ${s.recentFrames.dropped}/${s.recentFrames.total} tabte (${s.recentFrames.percent.toFixed(1)} %)`);
        parts.push(`Bufferstop: ${s.waits}`);
        if (s.recoveries) parts.push(`Genoprettelsesforsøg: ${s.recoveries}`);
        if (s.segment) parts.push(`Segment hentet: ${s.segment.seconds.toFixed(2)} s / ${s.segment.duration.toFixed(2)} s video`);
        return parts.join(' · ');
      }
    };
  }
};
if (typeof module !== 'undefined') module.exports = FjordPlaybackHealth;
