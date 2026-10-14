/* Bound queued media bytes without changing the selected video quality. */
const FjordBrowserBuffer = {
  config(seconds, mbps, desktop = false, profile = null) {
    const requested = [30, 60, 120].includes(seconds) ? seconds : 60;
    const defaults = {startPosition:0, maxBufferLength:requested, backBufferLength:30};
    if (desktop || profile?.external) return defaults;
    // If detection is unavailable, use the conservative fallback.
    const forwardBytes = (profile?.buffer?.forwardMiB || 48) * 1024 ** 2;
    const backBytes = (profile?.buffer?.backMiB || 16) * 1024 ** 2;
    // HLS.js treats maxBufferLength as a minimum even when maxBufferSize is
    // exceeded. At remux bitrates, 60s ahead plus 30s behind can overflow MSE.
    // Reserve space for segment overshoot/bitrate peaks below Chrome's quota.
    const bytesPerSecond = Number(mbps) * 1e6 / 8;
    const known = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0;
    const forward = known ? Math.max(1, Math.min(requested, Math.floor(forwardBytes / bytesPerSecond))) : requested;
    const backward = known ? Math.max(0, Math.min(30, Math.floor(backBytes / bytesPerSecond))) : 30;
    return {...defaults, maxBufferLength:forward, maxMaxBufferLength:forward,
      maxBufferSize:forwardBytes, backBufferLength:backward};
  }
};
if (typeof module !== 'undefined') module.exports = FjordBrowserBuffer;
