/* Public Samsung/Tizen APIs available on the 2018 (Tizen 4.0) baseline. */
(function (root) {
  'use strict';
  var failures = [], device = {native:false, uhd:false, hdr10:false, model:''};
  var keys = ['MediaPlay','MediaPause','MediaStop','MediaRewind','MediaFastForward','MediaPlayPause'];
  function note(label, error) { failures.push(label + ': ' + (error.name || 'ikke tilgængelig')); }
  try {
    if (root.tizen && root.tizen.tvinputdevice) keys.forEach(function (key) {
      try { root.tizen.tvinputdevice.registerKey(key); } catch (error) { note(key, error); }
    });
    device.native = !!(root.webapis && root.webapis.avplay);
    if (root.webapis && root.webapis.productinfo) {
      device.uhd = root.webapis.productinfo.isUdPanelSupported() === true;
      device.model = root.webapis.productinfo.getModel();
    }
  } catch (error) { note('Enhedsoplysninger', error); }
  try { device.hdr10 = !!(root.webapis && root.webapis.avinfo && root.webapis.avinfo.isHdrTvSupport()); }
  catch (error) { note('HDR', error); }
  root.SamsungPlatform = {
    device:device,
    diagnostics:function () { return failures.join(' · '); },
    screenSaver:function (enabled) {
      var common = root.webapis && root.webapis.appcommon;
      if (!common || !common.setScreenSaver) return;
      try {
        var states = common.AppCommonScreenSaverState || {SCREEN_SAVER_ON:1,SCREEN_SAVER_OFF:0};
        common.setScreenSaver(enabled ? states.SCREEN_SAVER_ON : states.SCREEN_SAVER_OFF);
      }
      catch (error) { note('Pauseskærm', error); }
    },
    requestExit:function () {
      if (!root.confirm('Vil du lukke FjordFlix?')) return;
      if (root.tizen && root.tizen.application) root.tizen.application.getCurrentApplication().exit();
      else root.close();
    }
  };
}(typeof window !== 'undefined' ? window : this));
