/* FjordFlix format negotiation, independently implemented against the Web Media APIs. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FjordBrowserCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function create(env) {
  'use strict';
  const probes = new Map(), failures = new Map(), reports = new Map();
  const positive = (n, fallback) => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : fallback;
  const store = (map, key, value) => {
    map.delete(key); map.set(key, value);
    if (map.size > 128) map.delete(map.keys().next().value);
    return value;
  };
  function frameRate(movie) {
    const parts = String(movie.quality?.frame_rate || '24').split('/').map(Number);
    const value = parts.length === 2 ? parts[0] / parts[1] : parts[0];
    return Math.min(240, positive(value, 24));
  }
  function key(movie) {
    return JSON.stringify([movie.id || '', movie.format, movie.video, movie.pix_fmt,
      movie.width, movie.height, movie.bitrate, movie.quality]);
  }
  function codecs(movie) {
    const q = movie.quality || {}, ten = movie.pix_fmt === 'yuv420p10le';
    if (!['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(movie.pix_fmt)) return [];
    const profile = String(q.video_profile || '').toLowerCase();
    const level = positive(q.video_level, movie.width > 1920 || frameRate(movie) > 30 ? 51 : 41);
    if (movie.video === 'h264' && !ten) {
      const prefix = {'constrained baseline':'42e0', baseline:'4200', main:'4d00', high:'6400'}[profile || 'high'];
      return prefix ? [`avc1.${prefix}${Math.round(Math.min(255, level)).toString(16).padStart(2, '0')}`] : [];
    }
    if (movie.video === 'hevc' && (!profile || ['main', 'main 10'].includes(profile))) {
      const suffix = `${ten ? '2.4' : '1.6'}.L${Math.round(positive(q.video_level, movie.width > 1920 ? 153 : 123))}.B0`;
      const tags = q.video_codec_tag === 'hev1' ? ['hev1', 'hvc1'] : ['hvc1', 'hev1'];
      return tags.map(tag => `${tag}.${suffix}`);
    }
    if (movie.video === 'av1' && (!profile || profile === 'main')) {
      const value = Number(q.video_level);
      const av1Level = q.video_level != null && Number.isInteger(value) && value >= 0 && value <= 23 ? value : 13;
      return [`av01.0.${String(av1Level).padStart(2, '0')}M.${ten ? '10' : '08'}`];
    }
    if (movie.video === 'vp9' && (!profile || profile === (ten ? 'profile 2' : 'profile 0'))) {
      return [`vp09.${ten ? '02' : '00'}.${String(Math.round(level)).padStart(2, '0')}.${ten ? '10' : '08'}`];
    }
    return movie.video === 'vp8' && !ten ? ['vp8'] : [];
  }
  function supports(video, type, route) {
    try {
      if (route === 'media-source') return !!(env.MediaSource || env.ManagedMediaSource)?.isTypeSupported(type);
      return /^(maybe|probably)$/.test(video?.canPlayType(type));
    } catch (_) { return false; }
  }
  async function decoding(config) {
    const api = env.navigator?.mediaCapabilities;
    if (!api?.decodingInfo) return null;
    const id = JSON.stringify(config), cached = probes.get(id);
    if (cached && Date.now() - cached.at < 60000) return cached.promise;
    const promise = new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => finish(null), 1200);
      function finish(info) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(info);
      }
      Promise.resolve().then(() => api.decodingInfo(config)).then(finish, () => finish(null));
    });
    store(probes, id, {at:Date.now(), promise});
    return promise;
  }
  function desktopToneMapping() {
    if (env.fjordDesktop) {
      // Preserve the desktop app's existing prediction; browser profiles only.
      const agent = env.navigator?.userAgent || '';
      if (/Android|Mobile|iPhone|iPad|iPod|Oculus|Xbox|webOS|Tizen/i.test(agent)) return false;
      const edge = /Edg\/(\d+)/.exec(agent);
      return edge ? Number(edge[1]) >= 121 : /Chrome\/(\d+)/.test(agent) && !/OPR\/|SamsungBrowser\//.test(agent);
    }
    return browserProfile().hdrToSdr === true;
  }
  function browserProfile() {
    const profiles = env.FjordBrowserProfiles || (typeof module !== 'undefined' && module.exports
      ? require('./browser-profiles.js') : null);
    return profiles ? profiles.detect(env) : {id:'unknown', label:'Ukendt browser', hdrToSdr:false};
  }
  async function videoProbe(movie, video, codec, mime, route, hdr, quality, toneMapping = false) {
    const contentType = `${mime}; codecs="${codec}"`;
    if (!supports(video, contentType, route)) return {ok:false, codec};
    const config = {contentType, width:positive(movie.width, 1920), height:positive(movie.height, 1080),
      bitrate:positive(movie.bitrate, 8000000), framerate:frameRate(movie)};
    // Desktop Chromium can map HDR to its SDR output. In that route, query
    // decoder performance independently of HDR display capabilities.
    if (hdr && !toneMapping) Object.assign(config, {colorGamut:'rec2020', transferFunction:movie.quality?.dynamic_range === 'HLG' ? 'hlg' : 'pq'});
    const info = await decoding({type:route, video:config});
    // A rejected API call is unknown, NOT a negative codec result. An explicit
    // unsupported result is never overridden. Original may override smoothness.
    const ok = info?.supported !== false && (!hdr || info?.supported === true) &&
      (info?.smooth !== false || quality === 'original');
    return {ok, codec, verified:info?.supported === true,
      smooth:info?.smooth ?? null, powerEfficient:info?.powerEfficient ?? null};
  }
  function audioMime(track, webm) {
    if (webm) return ['opus', 'vorbis'].includes(track.codec) ? `audio/webm; codecs="${track.codec}"` : null;
    if (track.codec === 'aac') {
      const p = String(track.profile || '').toLowerCase();
      return `audio/mp4; codecs="mp4a.40.${/he-aac\s?v2/.test(p) ? '29' : p.includes('he-aac') ? '5' : '2'}"`;
    }
    return {ac3:'audio/mp4; codecs="ac-3"', eac3:'audio/mp4; codecs="ec-3"',
      mp3:'audio/mpeg', opus:'audio/mp4; codecs="opus"', flac:'audio/mp4; codecs="flac"',
      alac:'audio/mp4; codecs="alac"'}[track.codec] || null;
  }
  async function audioProbe(track, video, route, webm = false) {
    if (!track?.codec) return true;
    const contentType = audioMime(track, webm);
    if (!contentType || !supports(video, contentType, route)) return false;
    const channels = positive(track.channels, 2);
    const info = await decoding({type:route, audio:{contentType, channels:String(channels),
      bitrate:positive(track.bitrate, 192000), samplerate:positive(track.sample_rate, 48000)}});
    return info?.supported !== false && (channels <= 2 || info?.supported === true);
  }
  async function auto4k(movie, video) {
    const ratio = positive(env.devicePixelRatio, 1);
    const dimensions = [positive(env.screen?.width, 0), positive(env.screen?.height, 0)].sort((a,b)=>b-a);
    if (dimensions[0]*ratio < 3840 || dimensions[1]*ratio < 2160 || frameRate(movie)>60 || !(movie.width >= 3840 || movie.height >= 2160)) return false;
    const scale = Math.min(1, 3840/positive(movie.width,3840), 2160/positive(movie.height,2160));
    const target = {...movie, width:Math.floor(movie.width*scale/2)*2, height:Math.floor(movie.height*scale/2)*2, bitrate:40000000};
    // 4K/60 needs level 5.2; 4K up to 30 fps needs level 5.1.
    const probe = await videoProbe(target, video, frameRate(movie)>30?'avc1.640034':'avc1.640033', 'video/mp4', 'media-source', false, 'auto');
    return probe.ok && probe.verified && probe.smooth === true;
  }
  async function detect(movie, options = {}) {
    const video = options.video || env.document?.createElement('video');
    const quality = options.quality || 'auto', request = options.tracks || {};
    const nativeIosHls = browserProfile().platform === 'ios' &&
      /^(maybe|probably)$/.test(video?.canPlayType?.('application/vnd.apple.mpegurl') || '');
    const q = movie.quality || {}, format = String(movie.format || '');
    const hdr = !!movie.hdr || ['HDR10', 'HDR10+', 'HLG', 'Dolby Vision'].includes(q.dynamic_range);
    const base = movie.video === 'hevc' && q.dynamic_range === 'Dolby Vision' && q.dv_bl !== false &&
      (q.dv_profile === 7 || q.dv_profile === 8 && q.dv_bl_signal_compatibility_id === 1);
    // Video can use a separate output plane from the page's CSS content.
    // Either positive query confirms HDR output; absent queries do not.
    const highRange = feature => {
      try { return !!env.matchMedia?.(`(${feature}: high)`).matches; } catch (_) { return false; }
    };
    const hdrPage = highRange('dynamic-range'), hdrVideo = highRange('video-dynamic-range');
    const hdrDisplay = hdrVideo || hdrPage;
    const hdrFormat = ['HDR10', 'HDR10+', 'HLG'].includes(q.dynamic_range) || base;
    const airplay = !!options.airplay;
    const toneMapping = hdr && !hdrDisplay && !airplay && desktopToneMapping();
    const hdrAllowed = !hdr || hdrFormat && (hdrDisplay || toneMapping);
    const variants = codecs(movie), webm = /webm/.test(format), mp4 = /mp4/.test(format);
    const fileVariants = movie.video === 'hevc' ? variants.slice(0, 1) : variants;
    const audioTracks = movie.tracks?.audio || [];
    const audio = audioTracks.find(t => t.index === request.audio_track) || audioTracks.find(t => t.default) || audioTracks[0] ||
      {codec:movie.audio, channels:q.audio_channels, profile:q.audio_profile};
    // Preserve the existing native AirPlay path. Its receiver is not the browser
    // whose decoder we are probing, so MSE support must not be sent as receiver support.
    const [files, streams, fileAudio, streamAudio, transcode4k] = await Promise.all([
      hdrAllowed && !base && (mp4 || webm || (airplay || nativeIosHls) && movie.video === 'h264')
        ? Promise.all(fileVariants.map(c => videoProbe(movie, video, c, webm ? 'video/webm' : 'video/mp4', 'file', hdr, quality, toneMapping))) : [],
      hdrAllowed && !airplay && !nativeIosHls && ['h264', 'hevc', 'av1', 'vp9'].includes(movie.video)
        ? Promise.all(variants.map(c => videoProbe(movie, video, c, 'video/mp4', 'media-source', hdr, quality, toneMapping))) : [],
      audioProbe(audio, video, 'file', webm),
      !airplay && !nativeIosHls && ['aac', 'ac3', 'eac3'].includes(audio?.codec) ? audioProbe(audio, video, 'media-source') : false,
      !airplay && !nativeIosHls && quality === 'auto' ? auto4k(movie, video) : false
    ]);
    const file = files.find(p => p.ok), stream = streams.find(p => p.ok);
    const previous = failures.get(key(movie));
    const blocked = previous && Date.now() - previous.at < 600000 ? previous : {};
    const direct = !airplay && (mp4 || webm) && !!file && fileAudio && !blocked.direct &&
      (!nativeIosHls || movie.video === 'h264' && !hdr);
    const copy = !!stream && !blocked.stream;
    const legacyH264 = (airplay || nativeIosHls) && movie.video === 'h264' && !hdr && !!file && !blocked.stream;
    let reason = '';
    if (blocked.stream) reason = 'Browseren afviste originalvideoen. Bruger kompatibel videokonvertering.';
    else if (nativeIosHls && (movie.video !== 'h264' || hdr)) reason = 'iPhone/iPad bruger kompatibel H.264/AAC i stedet for en usikker originalvideovej.';
    else if (hdr && !hdrFormat) reason = 'Filmens HDR-format har ikke en bekræftet kompatibel afspilningsvej.';
    else if (hdr && !hdrDisplay && !toneMapping) reason = 'Browseren bekræfter ikke HDR-output eller lokal HDR-til-SDR-visning. Videoens HDR konverteres til SDR.';
    else if (!file && !stream) reason = 'Browseren kunne ikke bekræfte filmens codec, profil og billedrate.';
    else if (!fileAudio) reason = 'Det valgte lydspor skal tilpasses; kompatibel video bevares.';
    const result = {quality, airplay, browser_profile:1, browser_ios_native_hls:nativeIosHls, browser_4k_transcode:transcode4k, direct, video_copy:copy, browser_fmp4:copy,
      browser_hevc_tag:stream?.codec.startsWith('hev1.') ? 'hev1' : 'hvc1',
      h264:movie.video === 'h264' && (copy || legacyH264), hdr10_base:copy && base,
      audio_copy:copy && streamAudio && !blocked.direct, capability_reason:reason, bandwidth:0, ...request};
    store(reports, key(movie), {file, stream, hdrDisplay, hdrPage, hdrVideo, hdrAllowed, toneMapping, audio:audio?.codec || 'ingen', result, frameRate:frameRate(movie), blocked});
    return result;
  }
  function noteFailure(movie, mode, code) {
    if (![3, 4].includes(code) || !['Direct Play', 'Direct Stream'].includes(mode)) return false;
    const id = key(movie), old = failures.get(id);
    const previous = old && Date.now() - old.at < 600000 ? old : {};
    if (mode === 'Direct Play' && previous.direct || mode === 'Direct Stream' && previous.stream) return false;
    store(failures, id, {...previous, direct:true, stream:mode === 'Direct Stream' || !!previous.stream, at:Date.now()});
    return true;
  }
  function describe(movie) {
    const report = reports.get(key(movie));
    if (!report) return '';
    const route = p => !report.hdrAllowed ? 'ikke testet: HDR-kontrollen blokerer' : !p ? 'ikke bekræftet' : `${p.codec} · ${p.verified ? 'bekræftet' : 'format understøttet; ydelse ukendt'}${p.smooth === false ? ' · kan hakke' : ''}`;
    const profile = browserProfile();
    return [`Browserprofil: ${profile.label} (${profile.id})`,
      `Film: ${movie.width} × ${movie.height} · ${report.frameRate.toFixed(3)} billeder/s`,
      `Direkte fil: ${route(report.file)}`, `HLS/fMP4: ${route(report.stream)}`,
      `Valgt lyd: ${report.audio}${report.result.audio_copy ? ' · kan bevares i HLS' : ''}`,
      `HDR-skærm: ${report.hdrDisplay ? 'bekræftet' : 'ikke bekræftet'}`,
      `HDR-output: video ${report.hdrVideo ? 'bekræftet' : 'ikke bekræftet'} · side ${report.hdrPage ? 'bekræftet' : 'ikke bekræftet'}`, report.result.capability_reason,
      report.toneMapping ? 'HDR → SDR: håndteres af desktop-browseren, hvis originalvideoen kan afspilles.' : '',
      report.result.quality === 'auto' ? `Automatisk 4K-konvertering: ${report.result.browser_4k_transcode ? 'skærm og H.264-decoder bekræftet' : 'ikke bekræftet'}` : '',
      report.blocked.direct ? 'En fejlet afspilningsvej springes over i denne fane i ti minutter.' : '',
      'Netværk: ukendt. Formatkontrol er ikke en hastighedstest.'].filter(Boolean).join('\n');
  }
  return {create, detect, codecs, frameRate, noteFailure, describe};
});
