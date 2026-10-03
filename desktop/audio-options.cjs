// WASAPI negotiates encoded HDMI output with the selected Windows sound device.
// It uses exclusive mode for bitstreams automatically; keep ordinary PCM shared.
// If the device rejects the bitstream, mpv can decode locally using its normal
// decoder fallback. Do not force stereo, a null output, or a specific device.
module.exports = ['--ao=wasapi', '--audio-spdif=ac3,eac3,truehd,dts,dts-hd'];
