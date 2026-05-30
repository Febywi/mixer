/* ============================================================
   player.js — playback orchestration
   ============================================================ */

(function () {
  "use strict";

  class Player {
    constructor(opts) {
      this.audioEl = opts.audioEl;
      this.engine = opts.engine;
      this.playlist = opts.playlist;
      this.waveform = opts.waveform;
      this.els = opts.els;
      this.onEngineReady = null;
      this._engineReady = false;

      const a = this.audioEl;
      a.addEventListener("timeupdate", () => this._tick());
      a.addEventListener("durationchange", () => this._tick());
      a.addEventListener("ended", () => this._onEnded());
      a.addEventListener("play", () => this._setPlaying(true));
      a.addEventListener("pause", () => this._setPlaying(false));
    }

    ensureEngine() {
      if (this._engineReady) return;
      this.engine.init();
      this._engineReady = true;
      this.els.engineDot && this.els.engineDot.classList.add("live");
      this.els.engineState && (this.els.engineState.textContent = "Engine Live");
      if (this.onEngineReady) this.onEngineReady();
    }

    load(song) {
      this.ensureEngine();
      this.audioEl.src = song.url;
      this.audioEl.load();
      this.els.npTitle.textContent = song.name;
      this.els.npSub.textContent = "DLMS · 4-band split aktif";

      // decode for waveform
      this.waveform.clear();
      song.file.arrayBuffer()
        .then((ab) => this.engine.ctx.decodeAudioData(ab))
        .then((buf) => { this.waveform.setBuffer(buf); })
        .catch(() => { /* unsupported decode — waveform stays empty */ });
    }

    play() {
      this.ensureEngine();
      this.engine.resume();
      const p = this.audioEl.play();
      if (p && p.catch) p.catch(() => {});
    }
    pause() { this.audioEl.pause(); }

    toggle() {
      if (!this.playlist.current) {
        // nothing selected: play first
        if (this.playlist.songs.length) this.playlist.play(this.playlist.songs[0].id);
        return;
      }
      if (this.audioEl.paused) this.play(); else this.pause();
    }

    next(auto) {
      const s = this.playlist.getNext(auto);
      if (s) { this.playlist.play(s.id); }
      else { this.pause(); } // end of playlist, repeat off
    }
    prev() {
      // restart if >3s in
      if (this.audioEl.currentTime > 3) { this.audioEl.currentTime = 0; return; }
      const s = this.playlist.getPrev();
      if (s) this.playlist.play(s.id);
    }

    seek(ratio) {
      if (this.audioEl.duration) this.audioEl.currentTime = ratio * this.audioEl.duration;
    }

    _onEnded() { this.next(true); }

    _setPlaying(on) {
      this.playlist.playing = on;
      this.els.iconPlay.classList.toggle("hidden", on);
      this.els.iconPause.classList.toggle("hidden", !on);
      this.playlist.render();
      if (this.els.engineState && this._engineReady)
        this.els.engineState.textContent = on ? "Playing" : "Paused";
    }

    _tick() {
      const a = this.audioEl;
      const cur = a.currentTime || 0, dur = a.duration || 0;
      this.els.curTime.textContent = window.fmtTime(cur);
      this.els.durTime.textContent = window.fmtTime(dur);
      const ratio = dur ? cur / dur : 0;
      if (this.els.waveProgress) this.els.waveProgress.style.width = (ratio * 100) + "%";
    }
  }

  window.Player = Player;
})();
