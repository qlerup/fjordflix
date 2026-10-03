/* Query the running player; preserve compatible 4K sources without a quality cap. */
(function (root) {
  'use strict';
  var probe = {};
  function nativeHEVC(movie, fps, field) {
    field = field || 'native';
    var protection = root.Windows && root.Windows.Media && root.Windows.Media.Protection;
    if (!protection || !protection.ProtectionCapabilities) return null;
    // Xbox's native decoder query is more precise than HTML codec-string detection.
    // Query decode only: these unprotected files do not require a DRM/HDCP check.
    var type = 'video/mp4;codecs="hvc1,mp4a";features="decode-res-x=' + movie.width +
      ',decode-res-y=' + movie.height + ',decode-bitrate=' + Math.max(1, Math.ceil((movie.bitrate || 20000000) / 1000)) +
      ',decode-fps=' + (fps > 30 ? 60 : 30) + ',decode-bpc=' + (movie.pix_fmt === 'yuv420p10le' ? 10 : 8) + '"';
    try {
      var result = new protection.ProtectionCapabilities().isTypeSupported(type, 'com.microsoft.playready.hardware');
      probe[field] = result === protection.ProtectionCapabilityResult.probably ? 'Probably' : result === protection.ProtectionCapabilityResult.maybe ? 'Maybe' : 'NotSupported';
      probe.query = type;
      return result === protection.ProtectionCapabilityResult.probably;
    } catch (error) {
      probe[field] = 'Fejl: ' + error.message;
      if (root.console) root.console.warn('Xbox HEVC capability query failed: ' + error.message);
      return null;
    }
  }
  function detect(movie, video, quality, fallback, facts, audioIndex) {
    var transcode = fallback === true;
    probe = {native:'Ikke forespurgt'};
    var source = movie.quality || {}, range = source.dynamic_range || (movie.hdr ? 'HDR10' : 'SDR');
    var features = facts && facts.features || [];
    var hdrBase = range === 'Dolby Vision' && source.dv_bl !== false &&
      (source.dv_profile === 7 || source.dv_profile === 8 && source.dv_bl_signal_compatibility_id === 1);
    var useBase = hdrBase && features.indexOf('xbox-hdr10-base') >= 0;
    var rate = String(source.frame_rate || '0').split('/'), fps = Number(rate[0]) / Number(rate[1] || 1);
    var format = movie.format || '', mp4 = /mp4|mov/.test(format);
    var h264 = movie.video === 'h264' && movie.pix_fmt === 'yuv420p' && range === 'SDR' &&
      movie.width <= 1920 && movie.height <= 1080 && fps <= 60 &&
      (!source.video_level || source.video_level <= 42) &&
      !!video.canPlayType('video/mp4; codecs="avc1.64002a"');
    var hevcFormat = movie.video === 'hevc' && ['yuv420p','yuv420p10le'].indexOf(movie.pix_fmt) >= 0 &&
      movie.width <= 3840 && movie.height <= 2160 && fps <= 60 &&
      (!source.video_level || source.video_level <= 153) && (['SDR','HDR10','HLG'].indexOf(range) >= 0 || useBase);
    var nativeSupport = hevcFormat && !transcode ? nativeHEVC(movie, fps) : null;
    var hevcCodec = movie.pix_fmt === 'yuv420p10le' ? '2.4.L153.B0' : '1.6.L153.B0';
    probe.htmlHEVC = video.canPlayType('video/mp4; codecs="hvc1.' + hevcCodec + '"') || video.canPlayType('video/mp4; codecs="hev1.' + hevcCodec + '"') || 'tom';
    var hevc = hevcFormat && (nativeSupport !== null ? nativeSupport :
      !!(video.canPlayType('video/mp4; codecs="hvc1.' + hevcCodec + '"') ||
         video.canPlayType('video/mp4; codecs="hev1.' + hevcCodec + '"')));
    var vp9 = movie.video === 'vp9' && ['yuv420p','yuv420p10le'].indexOf(movie.pix_fmt) >= 0 &&
      movie.width <= 3840 && movie.height <= 2160 && fps <= 60 && range === 'SDR' &&
      !!video.canPlayType('video/webm; codecs="' + (movie.pix_fmt === 'yuv420p10le' ? 'vp09.02.51.10' : 'vp09.00.51.08') + '"');
    var supported = h264 || hevc || vp9;
    var outputHEVC = false;
    if (features.indexOf('xbox-hevc-transcode') >= 0 && (quality === 'auto' || quality === '2160') &&
        (movie.width > 1920 || movie.height > 1080) && fps <= 60) {
      var height = Math.floor(Math.min(movie.height, 2160, 3840 * movie.height / movie.width) / 2) * 2;
      var output = {width:Math.floor(movie.width * height / movie.height / 2) * 2,height:height,pix_fmt:'yuv420p',bitrate:25000000};
      var outputSupport = nativeHEVC(output, fps, 'nativeOutput');
      outputHEVC = outputSupport !== null ? outputSupport : !!video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"');
    }
    var available = movie.tracks && movie.tracks.audio || [], chosen = available[0];
    available.forEach(function (track) { if (track.default) chosen = track; });
    var defaultAudio = chosen ? chosen.index : null;
    if (audioIndex !== null && audioIndex !== undefined) available.forEach(function (track) { if (track.index === audioIndex) chosen = track; });
    var audio = chosen ? chosen.codec : movie.audio;
    var audioTypes = {aac:'audio/mp4; codecs="mp4a.40.2"',ac3:'audio/mp4; codecs="ac-3"',
      eac3:'audio/mp4; codecs="ec-3"',mp3:'audio/mpeg',opus:'audio/webm; codecs="opus"',vorbis:'audio/webm; codecs="vorbis"'};
    var sound = !audio || !!audioTypes[audio] && !!video.canPlayType(audioTypes[audio]);
    var container = (mp4 && (h264 || hevc)) || /webm/.test(format) && vp9;
    // Explicit Original/4K choices never silently become 1080p, even on a retry.
    var requested = transcode && quality === 'auto' && !outputHEVC ? '1080' : quality;
    var reason = transcode ? (outputHEVC ? 'Xbox afviste originalformatet; konverterer til 4K HEVC.' : 'Xbox afviste originalformatet; bruger H.264/AAC.') :
      fallback === 'remux' ? 'Videoen bevares; indpakning og lyd tilpasses efter en afspilningsfejl.' :
      nativeSupport === false ? 'Xbox kunne ikke bekræfte hardwareafspilning af filmens HEVC-format.' :
      !supported ? 'Afspilleren kunne ikke bekræfte filens videoformat; serveren konverterer videoen.' :
      !sound ? 'Lydsporet konverteres til AAC.' : !container ? 'Videoen bevares, og filens indpakning tilpasses Xbox.' : '';
    probe.source = [movie.width + 'x' + movie.height, movie.video, movie.pix_fmt || 'ukendt pixelformat', range, 'profil ' + (source.video_profile || '?'), 'level ' + (source.video_level || '?'), (source.frame_rate || '?') + ' fps', (movie.bitrate ? Math.round(movie.bitrate / 1000000) + ' Mbps' : 'ukendt bitrate'), format, audio || 'uden lyd'].join(' · ');
    probe.hevcFormat = !!hevcFormat;
    probe.hdr10Base = hdrBase;
    if (range === 'Dolby Vision') probe.source += ' · Dolby Vision-profil ' + (source.dv_profile || '?') +
      ' · HDR10-basislag: ' + (hdrBase ? 'bekræftet' : 'ikke bekræftet') + ' · kompatibilitet ' + (source.dv_bl_signal_compatibility_id === undefined || source.dv_bl_signal_compatibility_id === null ? '?' : source.dv_bl_signal_compatibility_id);
    return {client_profile:'xbox', quality:requested, direct:!!(!fallback && supported && sound && container && !useBase),
      hdr10_base:!!(useBase && hevc && !transcode), hevc_output:!!outputHEVC,
      audio_copy:!!(!fallback && sound), audio_track:chosen && chosen.index !== defaultAudio ? chosen.index : null,
      video_copy:!!(!transcode && (h264 || hevc)), h264:!!(!transcode && h264), capability_reason:reason, bandwidth:0};
  }
  detect.diagnostics = function () { return probe; };
  detect.init = function () { return Promise.resolve(); };
  detect.device = function () { return {platform:'Xbox'}; };
  root.TVCapabilities = detect;
  if (typeof module !== 'undefined') module.exports = detect;
}(typeof window !== 'undefined' ? window : this));
