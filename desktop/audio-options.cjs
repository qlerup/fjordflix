// WASAPI negotiates encoded HDMI output with the selected Windows sound device.
// It uses exclusive mode for bitstreams automatically; keep ordinary PCM shared.
// audio-fallback.cjs retries rejected output as PCM: mpv's decoder fallback
// alone does not recover every WASAPI failure. Do not force stereo or null output.
module.exports = ['--ao=wasapi', '--audio-spdif=ac3,eac3,truehd,dts,dts-hd'];
