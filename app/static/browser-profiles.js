/* Browser-specific playback policy. Codec support is still probed separately. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FjordBrowserProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Keep separate entries even when two browsers currently share a baseline.
  // Chrome and Edge desktop: verified with the 4K HEVC/HDR remux on Windows.
  // Other profiles are conservative starting points, not hardware guarantees.
  const policies = {
    chrome: {label:'Google Chrome', forwardMiB:64, backMiB:32},
    edge: {label:'Microsoft Edge', forwardMiB:64, backMiB:32},
    firefox: {label:'Firefox', forwardMiB:48, backMiB:16},
    safari: {label:'Safari', forwardMiB:48, backMiB:16},
    opera: {label:'Opera', forwardMiB:48, backMiB:16},
    samsung: {label:'Samsung Internet', forwardMiB:48, backMiB:16},
    chromium: {label:'Chromium', forwardMiB:48, backMiB:16},
    unknown: {label:'Ukendt browser', forwardMiB:48, backMiB:16}
  };
  function detect(env = globalThis) {
    const nav = env.navigator || {}, ua = nav.userAgent || '';
    if (env.fjordDesktop) return {id:'desktop-app', label:'FjordFlix desktop-app', external:true};
    if (/Xbox|webOS|Web0S|Tizen|Oculus/i.test(ua)) return {id:'tv-app', label:'TV/enhedsafspiller', external:true};
    const ios = /iPhone|iPad|iPod/i.test(ua) || /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
    const platform = ios ? 'ios' : /Android/i.test(ua) ? 'android' : nav.userAgentData?.mobile || /Mobile/i.test(ua) ? 'mobile' : 'desktop';
    const brands = Array.isArray(nav.userAgentData?.brands) ? nav.userAgentData.brands : [];
    const brand = name => brands.find(b => b.brand === name);
    let browser = 'unknown', major = 0;
    const candidates = [
      ['edge', /(?:Edg|EdgA|EdgiOS|Edge)\/(\d+)/, 'Microsoft Edge'],
      ['opera', /(?:OPR|OPiOS)\/(\d+)/, 'Opera'],
      ['samsung', /SamsungBrowser\/(\d+)/, 'Samsung Internet'],
      ['firefox', /(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
      ['chrome', /(?:Chrome|CriOS)\/(\d+)/, 'Google Chrome'],
      ['chromium', /Chromium\/(\d+)/, 'Chromium'],
      ['safari', /Version\/(\d+).*Safari\//, 'Safari']
    ];
    // More specific products precede the Chrome/Safari tokens embedded in them.
    for (const [name, pattern, hint] of candidates) {
      const match = pattern.exec(ua), advertised = brand(hint);
      // Chromium derivatives may expose only the generic brand while retaining
      // Chrome's UA token. Do not mark those as verified Google Chrome.
      if (name === 'chrome' && brand('Chromium') && !advertised && !/HeadlessChrome\//.test(ua)) continue;
      if (match || advertised) {
        browser = name; major = Number.parseInt(advertised?.version || match?.[1], 10) || 0; break;
      }
    }
    const policy = policies[browser];
    const engine = ios || browser === 'safari' ? 'webkit' : browser === 'firefox' ? 'gecko' :
      /Edge\//.test(ua) ? 'edgehtml' : ['chrome','edge','opera','samsung','chromium'].includes(browser) ? 'chromium' : 'unknown';
    return {id:`${browser}-${platform}`, browser, major, engine, platform,
      label:`${policy.label}${platform === 'ios' ? ' på iOS/iPadOS' : platform === 'android' ? ' på Android' : platform === 'mobile' ? ' på mobil' : ''}`,
      // Mobile profiles are separate from the verified desktop Chrome policy.
      buffer:platform === 'desktop' ? {forwardMiB:policy.forwardMiB, backMiB:policy.backMiB}
        : {forwardMiB:48, backMiB:16},
      prefetchMiB:browser === 'firefox' && platform === 'desktop' ? 32 : 0,
      // This is permission to probe local tone mapping, never codec acceptance.
      hdrToSdr:platform === 'desktop' && engine === 'chromium' &&
        (browser === 'chrome' || browser === 'edge' && major >= 121),
      external:false};
  }
  return {detect};
});
