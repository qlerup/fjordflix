/* TV facts come from LG's deviceInfo API, never from a hard-coded model name. */
(function (root) {
  'use strict';
  var device = null;
  function detect(movie, video, quality, fallback, facts, audioIndex) {
    var transcode = fallback === true || fallback === 'transcode';
    var tv = facts && !facts.features ? facts : device, format = movie.format || '', source = movie.quality || {};
    var mp4 = /mp4|mov/.test(format), mkv = /matroska|mkv/.test(format);
    var mime = /webm/.test(format) ? 'video/webm' : 'video/mp4';
    var codecs = {h264:'avc1.640033', hevc:'hvc1.2.4.L153.B0', vp9:'vp09.00.51.08', vp8:'vp8', av1:'av01.0.08M.08'};
    var audioTypes = {aac:'audio/mp4; codecs="mp4a.40.2"', ac3:'audio/mp4; codecs="ac-3"', eac3:'audio/mp4; codecs="ec-3"', mp3:'audio/mpeg', opus:'audio/webm; codecs="opus"', vorbis:'audio/webm; codecs="vorbis"'};
    var supported = !!codecs[movie.video] && !!video.canPlayType(mime + '; codecs="' + codecs[movie.video] + '"');
    var reason = supported ? '' : 'TV-afspilleren understøtter ikke videoformatet.';
    var sdk = tv ? parseInt(tv.sdkVersion, 10) : 0;
    var dimensions = !tv || (movie.width <= (tv.screenWidth || (tv.uhd ? 3840 : 1920)) && movie.height <= (tv.screenHeight || (tv.uhd ? 2160 : 1080)));
    var rate = String(source.frame_rate || '0').split('/'), fps = Number(rate[0]) / Number(rate[1] || 1);
    var uhd = movie.width > 1920 || movie.height > 1080;
    if (tv && sdk >= 3 && (movie.video === 'hevc' || movie.video === 'h264')) {
      supported = dimensions && (!uhd || tv.uhd === true);
      if ((movie.bitrate || 0) > (uhd ? (movie.video === 'hevc' ? 60e6 : 50e6) : 40e6) || fps > (uhd && movie.video === 'h264' ? 30 : 60)) {
        supported = false; reason = 'Filens bitrate eller billedfrekvens overstiger TV-formatets grænse.';
      }
    }
    if (!dimensions) { supported = false; reason = 'Filens opløsning overstiger TV’ets understøttelse.'; }
    if (movie.video === 'h264' && movie.pix_fmt !== 'yuv420p') { supported = false; reason = 'TV’et understøtter ikke denne H.264-pixelformat.'; }
    if (movie.video === 'hevc' && ['yuv420p', 'yuv420p10le'].indexOf(movie.pix_fmt) < 0) { supported = false; reason = 'TV’et understøtter ikke denne HEVC-pixelformat.'; }
    if (movie.video === 'hevc' && source.video_level > 153) { supported = false; reason = 'HEVC-niveauet overstiger TV-formatets grænse.'; }
    var range = source.dynamic_range || (movie.hdr ? 'HDR10' : 'SDR');
    var hdrOK = range === 'SDR' || (tv && tv.hdr10 === true && range === 'HDR10');
    var dvOK = range === 'Dolby Vision' && tv && tv.dolbyVision === true && mp4 && !source.dv_el && [5, 8].indexOf(source.dv_profile) >= 0;
    if (!hdrOK && !dvOK) { supported = false; reason = range + ': kompatibilitet med TV og filprofil kunne ikke bekræftes.'; }
    var available = movie.tracks && movie.tracks.audio || [], chosen = available[0];
    available.forEach(function (track) { if (track.default) chosen = track; });
    var defaultAudioIndex = chosen ? chosen.index : null;
    if (audioIndex !== null && audioIndex !== undefined) available.forEach(function (track) { if (track.index === audioIndex) chosen = track; });
    var audio = chosen ? chosen.codec : movie.audio;
    var sound = !audio || !!audioTypes[audio] && !!video.canPlayType(audioTypes[audio]);
    if (tv && sdk >= 3 && ['aac', 'ac3', 'eac3', 'mp3'].indexOf(audio) >= 0) sound = true;
    var container = mp4 || /webm/.test(format) || (tv && sdk >= 3 && (mkv || /mpegts/.test(format)));
    var copy = supported && range !== 'Dolby Vision' && !!tv && sdk >= 3 && ['h264', 'hevc'].indexOf(movie.video) >= 0;
    if (!reason && !sound) reason = 'Videoen kan bevares; lydformatet skal konverteres.';
    if (!reason && !container) reason = 'Filens indpakning skal tilpasses TV’et.';
    return {quality:transcode && quality === 'auto' ? '1080' : quality,
      direct:!!(!fallback && supported && sound && container),
      audio_copy:!!sound && !fallback,
      audio_track:chosen && chosen.index !== defaultAudioIndex ? chosen.index : null,
      video_copy:!!(!transcode && copy),
      h264:!transcode && supported && movie.video === 'h264' && range === 'SDR',
      capability_reason:fallback ? 'TV’et afviste originalformatet under afspilning.' : reason, bandwidth:0};
  }
  detect.init = function () {
    return new Promise(function (resolve) {
      if (!root.webOS || (!root.webOS.platform || !root.webOS.platform.tv)) { resolve(); return; }
      var timer = setTimeout(resolve, 4000);
      try { root.webOS.deviceInfo(function (info) { device = info || null; clearTimeout(timer); resolve(); }); }
      catch (error) { clearTimeout(timer); resolve(); }
    });
  };
  detect.diagnostics = function () { return {source:device ? 'LG webOS ' + (device.sdkVersion || '') + ' ' + (device.modelName || '') : 'LG-enhedsdata ikke tilgængelige; bruger browserens formattest.'}; };
  detect.device = function () { return device; };
  root.TVCapabilities = detect;
  if (typeof module !== 'undefined') module.exports = detect;
}(typeof window !== 'undefined' ? window : this));
