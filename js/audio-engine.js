/* ============================================================
   audio-engine.js
   Core Web Audio graph for the DLMS / workstation.

   Signal flow:
     <audio> -> MediaElementSource -> inputGain
        |-> bypassGain ----------------------------\
        |                                            \
        +-> [Linkwitz-Riley crossover 4-band split]   \
              SUB / LOW / MID / HIGH                    |
              each: EQ -> phase -> delay -> comp ->      |
                    saturation -> chanGain -> meter      |
                                       \-> masterBus      |
        masterBus -> masterEQ -> masterComp -> loudness   |
                  -> stereoWidth -> limiter -> masterGain |
                                       -> procSwitch ------+--> outGain -> outAnalyser -> destination
   ============================================================ */

(function () {
  "use strict";

  const Q_BUTTER = Math.SQRT1_2; // 0.7071 -> Butterworth, two cascaded = Linkwitz-Riley 4th order

  function dbToLin(db) { return Math.pow(10, db / 20); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // soft-clip saturation curve (tanh-ish). amount 0..1
  function makeSatCurve(amount) {
    if (amount <= 0.001) return null;
    const n = 2048;
    const curve = new Float32Array(n);
    const k = amount * 12; // drive
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      // soft saturation, normalized so |out|<=1
      curve[i] = Math.tanh(k * x) / Math.tanh(k || 1);
    }
    return curve;
  }

  const CHANNEL_DEFS = [
    { id: "sub",  label: "SUB",  range: "20–80 Hz",   color: "#7C5CFF" },
    { id: "low",  label: "LOW",  range: "80–250 Hz",  color: "#22D3EE" },
    { id: "mid",  label: "MID",  range: "250Hz–4k",   color: "#FF8A3D" },
    { id: "high", label: "HIGH", range: "4k–20kHz",   color: "#FFD34E" },
  ];

  class AudioEngine {
    constructor(audioEl) {
      this.audioEl = audioEl;
      this.ctx = null;
      this.ready = false;
      this.channels = {};
      this.crossover = { x1: 80, x2: 250, x3: 4000 };
      this.qualityMode = "hq";
      this.CHANNEL_DEFS = CHANNEL_DEFS;
    }

    init() {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: this.qualityMode === "ll" ? "interactive" : "playback" });
      const ctx = this.ctx;

      this.source = ctx.createMediaElementSource(this.audioEl);
      this.inputGain = ctx.createGain();
      this.source.connect(this.inputGain);

      // master sum bus
      this.masterBus = ctx.createGain();

      this._buildChannels();
      this._buildMaster();

      // ----- compare / output mixer -----
      this.bypassGain = ctx.createGain();
      this.inputGain.connect(this.bypassGain);

      this.procSwitch = ctx.createGain();   // processed path on/off (compare)
      this.bypassSwitch = ctx.createGain(); // original path on/off (compare)
      this.bypassSwitch.gain.value = 0;

      this.masterGain.connect(this.procSwitch);
      this.bypassGain.connect(this.bypassSwitch);

      this.outGain = ctx.createGain();
      this.procSwitch.connect(this.outGain);
      this.bypassSwitch.connect(this.outGain);

      // final analyser (what you hear)
      this.outAnalyser = ctx.createAnalyser();
      this.outAnalyser.fftSize = 4096;
      this.outAnalyser.smoothingTimeConstant = 0.8;
      this.outGain.connect(this.outAnalyser);
      this.outAnalyser.connect(ctx.destination);

      this.ready = true;
    }

    _buildChannels() {
      const ctx = this.ctx;
      CHANNEL_DEFS.forEach((def) => {
        const ch = {
          id: def.id, label: def.label, color: def.color, range: def.range,
          mute: false, solo: false, gainDb: 0, phaseInvert: false,
          xfilters: [],
        };

        // crossover filters (built fresh)
        const filters = this._makeCrossover(def.id);
        ch.xfilters = filters;

        // EQ section (defined in eq-curve.js)
        ch.eq = new window.EQ(ctx);

        // phase invert
        ch.phase = ctx.createGain();
        ch.phase.gain.value = 1;

        // delay (alignment)
        ch.delay = ctx.createDelay(0.05);
        ch.delay.delayTime.value = 0;

        // compressor
        ch.comp = ctx.createDynamicsCompressor();
        ch.comp.threshold.value = 0;   // effectively off
        ch.comp.ratio.value = 1;
        ch.comp.attack.value = 0.01;
        ch.comp.release.value = 0.2;
        ch.comp.knee.value = 6;
        ch.compState = { threshold: 0, ratio: 1, attack: 0.01, release: 0.2 };
        ch.delayMs = 0;

        // saturation
        ch.sat = ctx.createWaveShaper();
        ch.sat.curve = null;
        ch.sat.oversample = "2x";
        ch.satAmount = 0;

        // output / mute / solo / gain
        ch.gain = ctx.createGain();
        ch.gain.gain.value = 1;

        // per-channel analyser (for EQ-behind spectrum + meter)
        ch.analyser = ctx.createAnalyser();
        ch.analyser.fftSize = 2048;
        ch.analyser.smoothingTimeConstant = 0.75;
        ch._meterBuf = new Uint8Array(ch.analyser.fftSize);

        // ----- wire chain -----
        // inputGain -> crossover... -> eq.input
        let node = this.inputGain;
        filters.forEach((f) => { node.connect(f); node = f; });
        node.connect(ch.eq.input);
        // eq.output -> phase -> delay -> comp -> sat -> gain
        ch.eq.output.connect(ch.phase);
        ch.phase.connect(ch.delay);
        ch.delay.connect(ch.comp);
        ch.comp.connect(ch.sat);
        ch.sat.connect(ch.gain);
        // gain -> analyser (tap) and -> masterBus
        ch.gain.connect(ch.analyser);
        ch.gain.connect(this.masterBus);

        this.channels[def.id] = ch;
      });
    }

    _makeCrossover(id) {
      const ctx = this.ctx;
      const { x1, x2, x3 } = this.crossover;
      const lp = (f) => { const n = ctx.createBiquadFilter(); n.type = "lowpass"; n.frequency.value = f; n.Q.value = Q_BUTTER; return n; };
      const hp = (f) => { const n = ctx.createBiquadFilter(); n.type = "highpass"; n.frequency.value = f; n.Q.value = Q_BUTTER; return n; };
      switch (id) {
        case "sub":  return [lp(x1), lp(x1)];                 // LR4 lowpass @ x1
        case "low":  return [hp(x1), hp(x1), lp(x2), lp(x2)]; // band x1..x2
        case "mid":  return [hp(x2), hp(x2), lp(x3), lp(x3)]; // band x2..x3
        case "high": return [hp(x3), hp(x3)];                 // LR4 highpass @ x3
      }
      return [];
    }

    _buildMaster() {
      const ctx = this.ctx;

      this.masterEQ = new window.EQ(ctx);
      this.masterBus.connect(this.masterEQ.input);

      this.masterComp = ctx.createDynamicsCompressor();
      this.masterComp.threshold.value = 0;
      this.masterComp.ratio.value = 1;
      this.masterComp.attack.value = 0.01;
      this.masterComp.release.value = 0.25;
      this.masterComp.knee.value = 6;
      this.masterEQ.output.connect(this.masterComp);
      this.masterCompState = { threshold: 0, ratio: 1, attack: 0.01, release: 0.25 };

      this.loudness = ctx.createGain();
      this.loudness.gain.value = 1;
      this.masterComp.connect(this.loudness);

      // stereo width (mid/side)
      this.stereo = this._createStereoWidth();
      this.loudness.connect(this.stereo.input);

      // brickwall-ish limiter
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1.0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      this.limiter.knee.value = 0;
      this.stereo.output.connect(this.limiter);

      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = 1;
      this.limiter.connect(this.masterGain);

      // plain numeric mirrors (AudioParam.value lags after setTargetAtTime)
      this.masterGainDb = 0;
      this.loudnessDb = 0;
      this.widthVal = 1;
      this.limiterThr = -1;

      // master meter analyser
      this.masterAnalyser = ctx.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.masterGain.connect(this.masterAnalyser);
      this._masterMeterBuf = new Uint8Array(this.masterAnalyser.fftSize);
    }

    _createStereoWidth() {
      const ctx = this.ctx;
      const input = ctx.createGain();
      const output = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      input.connect(splitter);

      const midL = ctx.createGain(); midL.gain.value = 0.5;
      const midR = ctx.createGain(); midR.gain.value = 0.5;
      const sideL = ctx.createGain(); sideL.gain.value = 0.5;
      const sideR = ctx.createGain(); sideR.gain.value = -0.5;

      splitter.connect(midL, 0); splitter.connect(midR, 1);
      splitter.connect(sideL, 0); splitter.connect(sideR, 1);

      const mid = ctx.createGain();
      const side = ctx.createGain();
      midL.connect(mid); midR.connect(mid);
      sideL.connect(side); sideR.connect(side);

      const widthGain = ctx.createGain(); widthGain.gain.value = 1;
      side.connect(widthGain);

      const sideToL = ctx.createGain(); sideToL.gain.value = 1;
      const sideToR = ctx.createGain(); sideToR.gain.value = -1;
      widthGain.connect(sideToL); widthGain.connect(sideToR);

      mid.connect(merger, 0, 0); sideToL.connect(merger, 0, 0);
      mid.connect(merger, 0, 1); sideToR.connect(merger, 0, 1);
      merger.connect(output);

      return { input, output, _w: widthGain };
    }

    // ---------------- control surface ----------------
    resume() { if (this.ctx && this.ctx.state === "suspended") return this.ctx.resume(); }

    _t() { return this.ctx ? this.ctx.currentTime : 0; }

    applyGainStates() {
      const anySolo = Object.values(this.channels).some((c) => c.solo);
      Object.values(this.channels).forEach((c) => {
        let lin = dbToLin(c.gainDb);
        if (c.mute) lin = 0;
        else if (anySolo && !c.solo) lin = 0;
        c.gain.gain.setTargetAtTime(lin, this._t(), 0.02);
      });
    }

    setChannelGain(id, db) { this.channels[id].gainDb = db; this.applyGainStates(); }
    setMute(id, on) { this.channels[id].mute = on; this.applyGainStates(); }
    setSolo(id, on) { this.channels[id].solo = on; this.applyGainStates(); }
    setPhase(id, invert) {
      const c = this.channels[id]; c.phaseInvert = invert;
      c.phase.gain.setTargetAtTime(invert ? -1 : 1, this._t(), 0.01);
    }
    setDelay(id, ms) { this.channels[id].delayMs = clamp(ms, 0, 50); this.channels[id].delay.delayTime.setTargetAtTime(this.channels[id].delayMs / 1000, this._t(), 0.01); }

    setComp(id, p) {
      const c = (id === "master") ? this.masterComp : this.channels[id].comp;
      const st = (id === "master") ? this.masterCompState : this.channels[id].compState;
      if (p.threshold != null) { st.threshold = clamp(p.threshold, -60, 0); c.threshold.setTargetAtTime(st.threshold, this._t(), 0.02); }
      if (p.ratio != null) { st.ratio = clamp(p.ratio, 1, 20); c.ratio.setTargetAtTime(st.ratio, this._t(), 0.02); }
      if (p.attack != null) { st.attack = clamp(p.attack, 0.001, 1); c.attack.setTargetAtTime(st.attack, this._t(), 0.02); }
      if (p.release != null) { st.release = clamp(p.release, 0.01, 1); c.release.setTargetAtTime(st.release, this._t(), 0.02); }
      if (p.knee != null) c.knee.setTargetAtTime(clamp(p.knee, 0, 40), this._t(), 0.02);
    }

    setSaturation(id, amount /* 0..100 */) {
      const c = this.channels[id];
      c.satAmount = amount;
      c.sat.curve = makeSatCurve(amount / 100);
    }

    setCrossover(part) {
      Object.assign(this.crossover, part);
      const { x1, x2, x3 } = this.crossover;
      const map = {
        sub:  [x1, x1],
        low:  [x1, x1, x2, x2],
        mid:  [x2, x2, x3, x3],
        high: [x3, x3],
      };
      Object.keys(map).forEach((id) => {
        const ch = this.channels[id];
        map[id].forEach((f, i) => {
          if (ch.xfilters[i]) ch.xfilters[i].frequency.setTargetAtTime(f, this._t(), 0.02);
        });
      });
    }

    setMasterGain(db) { this.masterGainDb = db; this.masterGain.gain.setTargetAtTime(dbToLin(db), this._t(), 0.02); }
    setLoudness(db) { this.loudnessDb = db; this.loudness.gain.setTargetAtTime(dbToLin(db), this._t(), 0.02); }
    setStereoWidth(w) { this.widthVal = clamp(w, 0, 2); this.stereo._w.gain.setTargetAtTime(this.widthVal, this._t(), 0.02); }
    setLimiter(threshold) { this.limiterThr = clamp(threshold, -24, 0); this.limiter.threshold.setTargetAtTime(this.limiterThr, this._t(), 0.02); }

    setCompare(mode) {
      const t = this._t();
      const proc = mode === "orig" ? 0 : 1;
      this.procSwitch.gain.setTargetAtTime(proc, t, 0.03);
      this.bypassSwitch.gain.setTargetAtTime(1 - proc, t, 0.03);
    }

    setQuality(mode) { this.qualityMode = mode; /* applied on next context build */ }

    // ---- metering ----
    channelLevel(id) {
      const c = this.channels[id];
      c.analyser.getByteTimeDomainData(c._meterBuf);
      return this._rms(c._meterBuf);
    }
    masterLevel() {
      this.masterAnalyser.getByteTimeDomainData(this._masterMeterBuf);
      return this._rms(this._masterMeterBuf);
    }
    _rms(buf) {
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / buf.length); // 0..~1
    }

    // ---- state (for presets) ----
    getState() {
      const ch = {};
      Object.values(this.channels).forEach((c) => {
        ch[c.id] = {
          gainDb: c.gainDb, mute: c.mute, solo: c.solo, phaseInvert: c.phaseInvert,
          delayMs: c.delayMs,
          satAmount: c.satAmount,
          comp: { threshold: c.compState.threshold, ratio: c.compState.ratio, attack: c.compState.attack, release: c.compState.release },
          eq: c.eq.getBands(),
        };
      });
      return {
        crossover: { ...this.crossover },
        channels: ch,
        master: {
          gainDb: this.masterGainDb,
          loudnessDb: this.loudnessDb,
          width: this.widthVal,
          limiterThreshold: this.limiterThr,
          comp: { threshold: this.masterCompState.threshold, ratio: this.masterCompState.ratio },
          eq: this.masterEQ.getBands(),
        },
      };
    }

    setState(s) {
      if (!s) return;
      if (s.crossover) this.setCrossover(s.crossover);
      if (s.channels) {
        Object.keys(s.channels).forEach((id) => {
          const cs = s.channels[id]; const c = this.channels[id]; if (!c) return;
          c.gainDb = cs.gainDb ?? 0; c.mute = !!cs.mute; c.solo = !!cs.solo;
          this.setPhase(id, !!cs.phaseInvert);
          this.setDelay(id, cs.delayMs ?? 0);
          this.setSaturation(id, cs.satAmount ?? 0);
          if (cs.comp) this.setComp(id, cs.comp);
          if (cs.eq) c.eq.setBands(cs.eq);
        });
      }
      if (s.master) {
        const m = s.master;
        if (m.gainDb != null) this.setMasterGain(m.gainDb);
        if (m.loudnessDb != null) this.setLoudness(m.loudnessDb);
        if (m.width != null) this.setStereoWidth(m.width);
        if (m.limiterThreshold != null) this.setLimiter(m.limiterThreshold);
        if (m.comp) this.setComp("master", m.comp);
        if (m.eq) this.masterEQ.setBands(m.eq);
      }
      this.applyGainStates();
    }
  }

  window.AudioEngine = AudioEngine;
})();
