// A rejected WASAPI bitstream can leave video waiting on a failed audio clock.
// Reopen only the audio track with local PCM decoding; keep video and subtitles.
function createAudioFallback({send, record, audio}) {
  let attempted = false;
  let selected = Number.isInteger(audio) && audio > 0 ? audio : 'auto';
  return {
    receive(message) {
      if (attempted && [110,111,112].includes(message.request_id) && message.error && message.error !== 'success')
        return 'Afspilleren kunne ikke skifte til PCM-lyd. Kontrollér den valgte lydudgang i Windows.';
      if (message.event === 'property-change' && message.name === 'aid' &&
          Number.isInteger(message.data) && message.data > 0) selected = message.data;
      if (message.event !== 'log-message' || message.prefix !== 'ao' ||
          !message.text?.includes("Failed to initialize audio driver 'wasapi'")) return null;
      if (attempted) return 'Windows kunne ikke starte lydudgangen, heller ikke med PCM. Kontrollér den valgte lydudgang i Windows.';
      attempted = true;
      record('audio-fallback', 'WASAPI rejected audio output; retrying the selected track as PCM');
      send(['set_property', 'audio-spdif', ''], 110);
      send(['set_property', 'aid', 'no'], 111);
      send(['set_property', 'aid', selected], 112);
      return null;
    }
  };
}
module.exports = {createAudioFallback};
