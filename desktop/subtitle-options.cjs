// PGS display sets may start before the keyframe used for a track switch/seek.
// Read preceding MKV packets, without changing the requested playback position.
// Bound the lookback: scanning the whole movie would be too expensive over HTTP.
module.exports = ['--demuxer-mkv-subtitle-preroll=yes', '--demuxer-mkv-subtitle-preroll-secs=10'];
