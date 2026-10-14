/* Bound queued media bytes without changing the selected video quality. */
const FjordBrowserBuffer = {
  config(seconds, mbps, desktop = false) {
    const requested = [30, 60, 120].includes(seconds) ? seconds : 60;
    const defaults = {startPosition:0, maxBufferLength:requested, backBufferLength:30};
    if (desktop) return defaults;
    // HLS.js treats maxBufferLength as a minimum even when maxBufferSize is
    // exceeded. At remux bitrates, 60s ahead plus 30s behind can overflow MSE.
    // Reserve space for segment overshoot/bitrate peaks below Chrome's quota.
    const bytesPerSecond = Number(mbps) * 1e6 / 8;
    const known = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0;
    const forward = known ? Math.max(1, Math.min(requested, Math.floor(64 * 1024 ** 2 / bytesPerSecond))) : requested;
    const backward = known ? Math.max(0, Math.min(30, Math.floor(32 * 1024 ** 2 / bytesPerSecond))) : 30;
    return {...defaults, maxBufferLength:forward, maxMaxBufferLength:forward,
      maxBufferSize:64 * 1024 ** 2, backBufferLength:backward};
  }
};
if (typeof module !== 'undefined') module.exports = FjordBrowserBuffer;
