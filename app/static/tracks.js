const FjordTracks = {
  movie: null, audio: null, subtitle: null, generation: 0, element: null, url: null, pending: null, burnSubtitles: false, nativeCleanup: null,
  language(code) {
    const known = {dan:'Dansk',da:'Dansk',eng:'Engelsk',en:'Engelsk',swe:'Svensk',sv:'Svensk',nor:'Norsk',nob:'Norsk',nb:'Norsk',deu:'Tysk',ger:'Tysk',de:'Tysk',fra:'Fransk',fre:'Fransk',fr:'Fransk',spa:'Spansk',es:'Spansk',und:'Ukendt sprog'};
    return known[code] || code || 'Ukendt sprog';
  },
  label(track, subtitle = false) {
    const labels = [this.language(track.language), track.title, track.codec.toUpperCase()];
    if (!subtitle && track.layout) labels.push(track.layout === 'stereo' ? 'Stereo' : track.layout);
    if (track.default) labels.push('Standard');
    if (track.forced) labels.push('Kun tvungne');
    if (track.hearing_impaired) labels.push('Hørehæmmede');
    if (track.delivery === 'burn') labels.push('Kræver videokonvertering');
    if (track.delivery === 'unsupported') labels.push('Ikke understøttet');
    return labels.filter(Boolean).join(' · ');
  },
  setup() {
    document.querySelector('#detail .quality-label').insertAdjacentHTML('beforebegin', '<div id="detail-tracks" class="track-options"><label>Lydspor<select id="detail-audio"></select></label><label>Undertekster<select id="detail-subtitle"></select></label></div><p id="track-status" class="fine" role="status"></p>');
    document.querySelector('.player-top').insertAdjacentHTML('beforeend', '<button id="player-tracks-toggle" class="secondary small" aria-expanded="false" aria-controls="player-tracks">Lyd og tekst</button>');
    $('player-dialog').insertAdjacentHTML('beforeend', '<section id="player-tracks" class="track-options player-track-panel" hidden aria-label="Lyd og undertekster"><label>Lydspor<select id="player-audio"></select></label><label>Undertekster<select id="player-subtitle"></select></label><button id="player-tracks-close" class="secondary small">Luk</button></section>');
    for (const place of ['detail', 'player']) {
      $(`${place}-tracks`).insertAdjacentHTML('beforeend', `<label class="airplay-subtitle-fallback" hidden><input id="${place}-burn-subtitles" type="checkbox">Indbrænd undertekster, hvis TV’et ikke viser dem (kræver videokonvertering)</label>`);
      $(`${place}-burn-subtitles`).onchange = async () => {
        this.burnSubtitles = $(`${place}-burn-subtitles`).checked;
        this.sync();
        try { if (place === 'detail') await updatePlan(); else if (playback) await startPlayback(position()); }
        catch (e) { toast(e.message); }
      };
    }
    const close = () => { $('player-tracks').hidden = true; $('player-tracks-toggle').setAttribute('aria-expanded', 'false'); };
    $('player-tracks-toggle').onclick = () => { const open = $('player-tracks').hidden; $('player-tracks').hidden = !open; $('player-tracks-toggle').setAttribute('aria-expanded', String(open)); };
    $('player-tracks-close').onclick = () => { close(); $('player-tracks-toggle').focus(); };
    $('player-dialog').addEventListener('close', close);
    for (const place of ['detail', 'player']) for (const kind of ['audio', 'subtitle']) {
      $(`${place}-${kind}`).onchange = async () => {
        const value = $(`${place}-${kind}`).value;
        this[kind] = value === '' ? null : Number(value);
        this.sync();
        try {
          if (place === 'detail') await updatePlan();
          else {
            const burn = this.selectedSubtitle()?.delivery === 'burn';
            if (kind === 'audio' || playback?.airplay || burn || playback?.subtitle_delivery === 'burn') {
              await startPlayback(position());
            } else if (playback) {
              playback.subtitle_track = this.subtitle;
              playback.subtitle_delivery = this.subtitle === null ? null : 'text';
              await this.attach(playback);
            }
          }
        } catch (e) { toast(e.message); }
      };
    }
  },
  async prepare(movie) {
    this.movie = movie; this.audio = null; this.subtitle = null; this.burnSubtitles = false;
    $('track-status').textContent = 'Læser lydspor og undertekster…';
    this.fill({audio:[], subtitles:[]});
    $('play-button').disabled = $('restart-button').disabled = true;
    try {
      const available = movie.tracks?.version === 1 ? movie.tracks : await api(`/movies/${movie.id}/tracks`);
      if (this.movie !== movie) return;
      movie.tracks = available;
      const audio = available.audio || [];
      this.audio = (audio.find(t => t.default) || audio[0])?.index ?? null;
      this.fill(available);
      $('track-status').textContent = `${audio.length} lydspor · ${(available.subtitles || []).length} undertekstspor`;
    } catch (e) {
      if (this.movie === movie) $('track-status').textContent = e.message;
    } finally {
      if (this.movie === movie) $('play-button').disabled = $('restart-button').disabled = false;
    }
  },
  fill(available) {
    for (const place of ['detail','player']) {
      for (const kind of ['audio','subtitle']) {
        const items = available[kind === 'audio' ? 'audio' : 'subtitles'] || [];
        const options = items.map(track => {
          const option = new Option(this.label(track, kind === 'subtitle'), String(track.index));
          option.disabled = track.delivery === 'unsupported'; return option;
        });
        if (kind === 'subtitle') options.unshift(new Option('Fra', ''));
        else if (!options.length) options.push(new Option('Ingen tilgængelige lydspor', ''));
        $(`${place}-${kind}`).replaceChildren(...options);
        $(`${place}-${kind}`).disabled = !items.length;
      }
    }
    this.sync();
  },
  sync() {
    for (const place of ['detail','player']) {
      for (const kind of ['audio','subtitle']) $(`${place}-${kind}`).value = this[kind] ?? '';
      const fallback = $(`${place}-burn-subtitles`);
      fallback.checked = this.burnSubtitles;
      fallback.parentElement.hidden = !(typeof airplaySupported !== 'undefined' && airplaySupported && this.selectedSubtitle()?.delivery === 'text');
    }
  },
  selectedSubtitle() { return this.movie?.tracks?.subtitles?.find(t => t.index === this.subtitle); },
  request() { return {audio_track:this.audio, subtitle_track:this.subtitle, burn_subtitles:this.burnSubtitles}; },
  clear() {
    ++this.generation;
    this.nativeCleanup?.(); this.nativeCleanup = null;
    this.pending?.abort(); this.pending = null;
    if (this.element) { this.element.track.mode = 'disabled'; this.element.remove(); this.element = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
  },
  shiftCues(track, offset) {
    for (const cue of [...(track.cues || [])]) {
      if (cue.endTime <= offset) track.removeCue(cue);
      else { cue.startTime = Math.max(0, cue.startTime - offset); cue.endTime -= offset; }
    }
  },
  async attach(result) {
    this.clear();
    if (result.subtitle_delivery === 'hls') {
      const generation = this.generation;
      const select = () => {
        if (generation !== this.generation) return;
        for (const track of Array.from(video.textTracks || [])) {
          if (track.label === 'FjordFlix') track.mode = 'showing';
        }
      };
      video.textTracks?.addEventListener('addtrack', select);
      video.addEventListener('loadedmetadata', select);
      this.nativeCleanup = () => {
        video.textTracks?.removeEventListener('addtrack', select);
        video.removeEventListener('loadedmetadata', select);
        for (const track of Array.from(video.textTracks || [])) if (track.label === 'FjordFlix') track.mode = 'disabled';
      };
      select();
      return;
    }
    if (result.subtitle_delivery !== 'text' || result.subtitle_track == null) return;
    const generation = this.generation;
    const controller = new AbortController(); this.pending = controller;
    const response = await fetch(`/api/movies/${this.movie.id}/subtitles/${result.subtitle_track}.vtt`, {signal:controller.signal});
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.detail || 'Underteksterne kunne ikke indlæses.'); }
    const data = await response.blob();
    if (generation !== this.generation) return;
    const element = document.createElement('track');
    element.kind = 'subtitles'; element.label = this.label(this.selectedSubtitle());
    this.url = URL.createObjectURL(new Blob([data], {type:'text/vtt'}));
    element.src = this.url;
    this.element = element;
    element.onload = () => {
      if (generation !== this.generation) return;
      this.shiftCues(element.track, result.offset || 0);
      element.track.mode = 'showing';
    };
    element.onerror = () => { if (generation === this.generation) toast('Underteksterne kunne ikke vises.'); };
    video.append(element); element.track.mode = 'hidden';
  }
};
if (typeof module !== 'undefined') module.exports = FjordTracks;

