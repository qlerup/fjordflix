/* Conservative 2018+ policy. AVPlay, UHD panel and HDR are checked separately. */
(function (root) {
  'use strict';
  var probe = {};
  function detect(movie, video, quality, fallback, facts, audioIndex) {
    var device = root.SamsungPlatform && root.SamsungPlatform.device || {};
    var native = !!device.native, transcode = fallback === true || fallback === 'transcode';
    var source = movie.quality || {}, range = source.dynamic_range || (movie.hdr ? 'HDR10' : 'SDR');
    var rate = String(source.frame_rate || '0').split('/'), fps = Number(rate[0]) / Number(rate[1] || 1);
    var format = movie.format || '', mp4 = /mp4|mov/.test(format), webm = /webm/.test(format), mkv = /matroska|mkv/.test(format);
    var codec = {h264:'avc1.640028',hevc:'hvc1.2.4.L153.B0',vp9:'vp09.00.51.08',vp8:'vp8'}[movie.video];
    var dimensions = movie.width <= (native && device.uhd ? 3840 : 1920) && movie.height <= (native && device.uhd ? 2160 : 1080);
    var pixels = movie.video === 'h264' ? movie.pix_fmt === 'yuv420p' : ['yuv420p','yuv420p10le'].indexOf(movie.pix_fmt) >= 0;
    var hdr = range === 'SDR' || native && device.hdr10 && range === 'HDR10' && movie.video === 'hevc';
    var supported = !!codec && !!video.canPlayType((webm ? 'video/webm' : 'video/mp4') + '; codecs="' + codec + '"');
    if (native && ['h264','hevc'].indexOf(movie.video) >= 0) supported = true;
    var maxBitrate = device.uhd ? (movie.video === 'hevc' ? 60e6 : 50e6) : 20e6;
    var maxFPS = movie.video === 'h264' && (movie.width > 1920 || movie.height > 1080) ? 30 : 60;
    var limits = fps <= maxFPS && (movie.bitrate || 0) <= maxBitrate && (movie.video !== 'hevc' || !source.video_level || source.video_level <= 153);
    supported = supported && dimensions && pixels && hdr && limits;
    var chosen = null, audio = movie.audio;
    (movie.tracks && movie.tracks.audio || []).forEach(function (track) { if (!chosen || track.default) chosen = track; });
    var defaultIndex = chosen ? chosen.index : null;
    if (audioIndex !== null && audioIndex !== undefined) (movie.tracks && movie.tracks.audio || []).forEach(function (track) { if (track.index === audioIndex) chosen = track; });
    if (chosen) audio = chosen.codec;
    // Samsung removed DTS support in 2018; never promise DTS/TrueHD passthrough.
    var types = {aac:'audio/mp4; codecs="mp4a.40.2"',ac3:'audio/mp4; codecs="ac-3"',eac3:'audio/mp4; codecs="ec-3"',mp3:'audio/mpeg',opus:'audio/webm; codecs="opus"',vorbis:'audio/webm; codecs="vorbis"'};
    var sound = !audio || !!types[audio] && (native && ['aac','ac3','eac3','mp3'].indexOf(audio) >= 0 || !!video.canPlayType(types[audio]));
    var container = mp4 || webm || native && (mkv || /mpegts/.test(format));
    var reason = !supported ? 'Videoformat, HDR eller opløsning er ikke bekræftet på dette Samsung-TV.' : !sound ? 'Videoen bevares; lydformatet tilpasses Samsung-TV’et.' : !container ? 'Indpakningen tilpasses Samsung-TV’et.' : '';
    probe = {source:'Samsung ' + (device.model || '(browserforhåndsvisning)') + ' · ' + (native ? 'AVPlay · UHD: ' + !!device.uhd + ' · HDR10: ' + !!device.hdr10 : 'HTML5-formattest; hardwareafspilning testes på TV'), audioTransport:'Samsung-kompatibel lyd', native:native};
    return {quality:transcode && quality === 'auto' ? '1080' : quality,
      direct:!!(!fallback && supported && sound && container), audio_copy:!!(!fallback && sound),
      audio_track:chosen && chosen.index !== defaultIndex ? chosen.index : null,
      video_copy:!!(!transcode && supported && ['h264','hevc'].indexOf(movie.video) >= 0),
      h264:!!(!transcode && supported && movie.video === 'h264' && range === 'SDR'),
      capability_reason:fallback ? 'Samsung-afspilleren afviste den første afspilningsvej.' : reason, bandwidth:0};
  }
  detect.init = function () { return Promise.resolve(); };
  detect.diagnostics = function () { return probe; };
  root.TVCapabilities = detect;
  if (typeof module !== 'undefined') module.exports = detect;
}(typeof window !== 'undefined' ? window : this));
