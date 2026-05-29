// ============================================================
//  audioEngine.js — Real-time DSP graph (Web Audio API)
//
//  Signal flow:
//    tracks -> inputBus -> vocalRemover -> 31-band GEQ
//      -> crossover (SUB/LOW/MID/HIGH)
//      -> per band: phase -> delay -> compressor -> reverb mix
//                   -> level -> mute/solo -> meter -> masterSum
//      -> masterSum -> master limiter -> master gain -> analyser -> out
// ============================================================

import {
  ISO_31_BANDS, GEQ_Q, BANDS, XOVER_RANGES, BAND_DEFAULTS,
  MASTER_DEFAULTS, REVERB_PRESETS, dbToGain, clamp,
} from './constants.js';

const LR_Q = Math.SQRT1_2; // 0.7071 — Butterworth Q for Linkwitz-Riley sections

export class MixerEngine {
  constructor() {
    this.ctx = null;
    this.tracks = new Map(); // id -> track object
    this._trackSeq = 0;
    this.started = false;

    // state mirrors (for presets)
    this.state = {
      master: { ...MASTER_DEFAULTS },
      vocal: { amount: 0 },
      geq: new Array(ISO_31_BANDS.length).fill(0),
      xover: {
        subLow: XOVER_RANGES.subLow.default,
        lowMid: XOVER_RANGES.lowMid.default,
        midHigh: XOVER_RANGES.midHigh.default,
      },
      bands: {},
    };

    BANDS.forEach((b) => {
      this.state.bands[b.id] = {
        gainDb: BAND_DEFAULTS.gainDb,
        delayMs: BAND_DEFAULTS.delayMs,
        mute: false,
        solo: false,
        phaseInvert: false,
        reverbOn: b.reverbDefault,
        reverbWet: BAND_DEFAULTS.reverbWet,
        reverbPreset: 'hall',
        compOn: true,
        compThreshold: BAND_DEFAULTS.compThreshold,
        compRatio: BAND_DEFAULTS.compRatio,
        limiterThreshold: BAND_DEFAULTS.limiterThreshold,
      };
    });
  }

  // ---- lifecycle ----------------------------------------------------------
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this._buildGraph();
    this.started = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  }

  // ---- graph construction -------------------------------------------------
  _buildGraph() {
    const ctx = this.ctx;

    // Input summing bus
    this.inputBus = ctx.createGain();

    // ---- Vocal remover sub-graph (mid-side) ----
    this._buildVocalRemover();
    this.inputBus.connect(this.vr.input);

    // ---- 31-band Graphic EQ ----
    this.geqFilters = ISO_31_BANDS.map((freq) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = GEQ_Q;
      f.gain.value = 0;
      return f;
    });
    // chain GEQ in series, fed from vocal remover output
    this.vr.output.connect(this.geqFilters[0]);
    for (let i = 0; i < this.geqFilters.length - 1; i++) {
      this.geqFilters[i].connect(this.geqFilters[i + 1]);
    }
    this.geqOut = ctx.createGain();
    this.geqFilters[this.geqFilters.length - 1].connect(this.geqOut);

    // ---- Master sum + limiter + gain + analyser ----
    this.masterSum = ctx.createGain();

    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = MASTER_DEFAULTS.limiterThreshold;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.003;
    this.masterLimiter.release.value = MASTER_DEFAULTS.limiterRelease;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = dbToGain(MASTER_DEFAULTS.gainDb);

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 4096;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    this.masterMeter = ctx.createAnalyser();
    this.masterMeter.fftSize = 1024;

    this.masterSum.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.masterMeter);
    this.masterMeter.connect(ctx.destination);

    // ---- Crossover + per-band chains ----
    this.bandNodes = {};
    BANDS.forEach((b) => this._buildBand(b));
    this._applyCrossoverFreqs();
    this.updateMuteSolo();
  }

  _buildVocalRemover() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const output = ctx.createGain();

    // Dry path
    const dry = ctx.createGain();
    dry.gain.value = 1;
    input.connect(dry);
    dry.connect(output);

    // Wet (karaoke) path: (L - R) with bass preserved
    const splitter = ctx.createChannelSplitter(2);
    input.connect(splitter);

    const invertR = ctx.createGain();
    invertR.gain.value = -1;

    const diff = ctx.createGain(); // sums L + (-R) => L - R (mono)
    splitter.connect(diff, 0); // L
    splitter.connect(invertR, 1);
    invertR.connect(diff);

    // remove bass from the difference signal (keep it for the bass-preserve path)
    const diffHP = ctx.createBiquadFilter();
    diffHP.type = 'highpass';
    diffHP.frequency.value = 120;
    diffHP.Q.value = LR_Q;
    diff.connect(diffHP);

    // bass-preserve: low end taken from original (stays stereo)
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = 'lowpass';
    bassLP.frequency.value = 120;
    bassLP.Q.value = LR_Q;
    input.connect(bassLP);

    const wetMix = ctx.createGain();
    diffHP.connect(wetMix);
    bassLP.connect(wetMix);

    const wet = ctx.createGain();
    wet.gain.value = 0; // amount = 0 by default
    wetMix.connect(wet);
    wet.connect(output);

    this.vr = { input, output, dry, wet, diffHP, bassLP };
  }

  _buildBand(b) {
    const ctx = this.ctx;
    const st = this.state.bands[b.id];

    // crossover filters (Linkwitz-Riley 24 dB/oct = 2 cascaded Butterworth)
    const filters = [];
    const makeLR = (type, freq) => {
      const a = ctx.createBiquadFilter();
      const c = ctx.createBiquadFilter();
      a.type = c.type = type;
      a.frequency.value = c.frequency.value = freq;
      a.Q.value = c.Q.value = LR_Q;
      a.connect(c);
      filters.push(a, c);
      return { in: a, out: c };
    };

    let head = null;
    let tail = null;
    const linkSeg = (seg) => {
      if (!head) { head = seg.in; tail = seg.out; }
      else { tail.connect(seg.in); tail = seg.out; }
    };

    if (b.hpf) linkSeg(makeLR('highpass', b.hpf));
    if (b.lpf) linkSeg(makeLR('lowpass', b.lpf));

    // band input gain (the crossover entry point)
    const xIn = head;
    const xOut = tail;
    this.geqOut.connect(xIn);

    // phase invert
    const phase = ctx.createGain();
    phase.gain.value = st.phaseInvert ? -1 : 1;
    xOut.connect(phase);

    // alignment delay
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = st.delayMs / 1000;
    phase.connect(delay);

    // compressor / limiter
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = st.compThreshold;
    comp.knee.value = BAND_DEFAULTS.compKnee;
    comp.ratio.value = st.compRatio;
    comp.attack.value = BAND_DEFAULTS.compAttack;
    comp.release.value = BAND_DEFAULTS.compRelease;
    delay.connect(comp);
    // comp on/off is handled in setBandComp() by switching ratio/threshold to transparent.

    // reverb send/return
    const dryGain = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = this._makeImpulse(REVERB_PRESETS[st.reverbPreset]);
    const wetGain = ctx.createGain();
    dryGain.gain.value = 1;
    wetGain.gain.value = st.reverbOn ? st.reverbWet : 0;

    // post-processing node (output of comp stage)
    const postComp = ctx.createGain();
    comp.connect(postComp);

    postComp.connect(dryGain);
    postComp.connect(convolver);
    convolver.connect(wetGain);

    const mix = ctx.createGain();
    dryGain.connect(mix);
    wetGain.connect(mix);

    // level (gain dB)
    const level = ctx.createGain();
    level.gain.value = dbToGain(st.gainDb);
    mix.connect(level);

    // mute / solo active gain
    const active = ctx.createGain();
    active.gain.value = 1;
    level.connect(active);

    // metering
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    active.connect(meter);
    meter.connect(this.masterSum);

    this.bandNodes[b.id] = {
      filters, xIn, xOut, phase, delay, comp, postComp,
      dryGain, convolver, wetGain, mix, level, active, meter,
      compBypassed: false,
    };
  }

  // ---- reverb impulse synthesis (no external files) -----------------------
  _makeImpulse({ seconds, decay }) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // exponentially decaying noise
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // ============================================================
  //  Track management
  // ============================================================
  addFileTrack(name, audioBuffer) {
    const id = `t${++this._trackSeq}`;
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    gain.connect(panner);
    panner.connect(this.inputBus);

    const track = {
      id, name, kind: 'file', buffer: audioBuffer,
      gain, panner, source: null,
      playing: false, startedAt: 0, offset: 0,
      gainDb: 0, pan: 0, mute: false, loop: false,
      duration: audioBuffer.duration,
    };
    this.tracks.set(id, track);
    return track;
  }

  async addMicTrack(name) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const id = `t${++this._trackSeq}`;
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    src.connect(gain);
    gain.connect(panner);
    panner.connect(this.inputBus);

    const track = {
      id, name, kind: 'mic', stream, source: src,
      gain, panner, playing: true,
      gainDb: 0, pan: 0, mute: false, duration: Infinity,
    };
    this.tracks.set(id, track);
    return track;
  }

  removeTrack(id) {
    const t = this.tracks.get(id);
    if (!t) return;
    try { this.stopTrack(id); } catch (e) {}
    if (t.kind === 'mic' && t.stream) {
      t.stream.getTracks().forEach((s) => s.stop());
    }
    try { t.panner.disconnect(); } catch (e) {}
    try { t.gain.disconnect(); } catch (e) {}
    this.tracks.delete(id);
  }

  playTrack(id) {
    const t = this.tracks.get(id);
    if (!t || t.kind !== 'file' || t.playing) return;
    const src = this.ctx.createBufferSource();
    src.buffer = t.buffer;
    src.loop = t.loop;
    src.connect(t.gain);
    const offset = clamp(t.offset, 0, t.duration - 0.01);
    src.start(0, offset);
    t.source = src;
    t.startedAt = this.ctx.currentTime - offset;
    t.playing = true;
    src.onended = () => {
      if (t.source === src && !t.loop) {
        t.playing = false;
        t.offset = 0;
        if (this.onTrackEnded) this.onTrackEnded(id);
      }
    };
  }

  pauseTrack(id) {
    const t = this.tracks.get(id);
    if (!t || t.kind !== 'file' || !t.playing) return;
    t.offset = this.getTrackPosition(id);
    try { t.source.stop(); } catch (e) {}
    t.source = null;
    t.playing = false;
  }

  stopTrack(id) {
    const t = this.tracks.get(id);
    if (!t) return;
    if (t.kind === 'file') {
      if (t.source) { try { t.source.stop(); } catch (e) {} t.source = null; }
      t.playing = false;
      t.offset = 0;
    }
  }

  seekTrack(id, seconds) {
    const t = this.tracks.get(id);
    if (!t || t.kind !== 'file') return;
    const wasPlaying = t.playing;
    if (wasPlaying) { try { t.source.stop(); } catch (e) {} t.source = null; t.playing = false; }
    t.offset = clamp(seconds, 0, t.duration);
    if (wasPlaying) this.playTrack(id);
  }

  getTrackPosition(id) {
    const t = this.tracks.get(id);
    if (!t || t.kind !== 'file') return 0;
    if (!t.playing) return t.offset;
    const pos = this.ctx.currentTime - t.startedAt;
    return t.loop ? pos % t.duration : clamp(pos, 0, t.duration);
  }

  setTrackGain(id, db) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.gainDb = db;
    t.gain.gain.value = t.mute ? 0 : dbToGain(db);
  }

  setTrackPan(id, pan) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.pan = pan;
    t.panner.pan.value = clamp(pan, -1, 1);
  }

  setTrackMute(id, mute) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.mute = mute;
    t.gain.gain.value = mute ? 0 : dbToGain(t.gainDb);
  }

  setTrackLoop(id, loop) {
    const t = this.tracks.get(id);
    if (!t || t.kind !== 'file') return;
    t.loop = loop;
    if (t.source) t.source.loop = loop;
  }

  playAll() { this.tracks.forEach((t) => { if (t.kind === 'file') this.playTrack(t.id); }); }
  pauseAll() { this.tracks.forEach((t) => { if (t.kind === 'file') this.pauseTrack(t.id); }); }
  stopAll() { this.tracks.forEach((t) => { if (t.kind === 'file') this.stopTrack(t.id); }); }

  // ============================================================
  //  Parameter setters
  // ============================================================
  setVocalAmount(amount) {
    amount = clamp(amount, 0, 1);
    this.state.vocal.amount = amount;
    const t = this.ctx.currentTime;
    this.vr.wet.gain.setTargetAtTime(amount, t, 0.02);
    this.vr.dry.gain.setTargetAtTime(1 - amount, t, 0.02);
  }

  setGeqBand(index, db) {
    this.state.geq[index] = db;
    this.geqFilters[index].gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  resetGeq() {
    this.geqFilters.forEach((f, i) => {
      this.state.geq[i] = 0;
      f.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    });
  }

  setCrossover(key, freq) {
    this.state.xover[key] = freq;
    this._applyCrossoverFreqs();
  }

  _applyCrossoverFreqs() {
    const { subLow, lowMid, midHigh } = this.state.xover;
    const map = {
      sub: { lpf: subLow },
      low: { hpf: subLow, lpf: lowMid },
      mid: { hpf: lowMid, lpf: midHigh },
      high: { hpf: midHigh },
    };
    BANDS.forEach((b) => {
      const node = this.bandNodes[b.id];
      const cfg = map[b.id];
      // filters were created in order: [hpf a,b], [lpf a,b]
      let idx = 0;
      if (b.hpf && cfg.hpf != null) {
        node.filters[idx++].frequency.setTargetAtTime(cfg.hpf, this.ctx.currentTime, 0.01);
        node.filters[idx++].frequency.setTargetAtTime(cfg.hpf, this.ctx.currentTime, 0.01);
      }
      if (b.lpf && cfg.lpf != null) {
        node.filters[idx++].frequency.setTargetAtTime(cfg.lpf, this.ctx.currentTime, 0.01);
        node.filters[idx++].frequency.setTargetAtTime(cfg.lpf, this.ctx.currentTime, 0.01);
      }
    });
  }

  setBandGain(bandId, db) {
    this.state.bands[bandId].gainDb = db;
    this.bandNodes[bandId].level.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setBandDelay(bandId, ms) {
    this.state.bands[bandId].delayMs = ms;
    this.bandNodes[bandId].delay.delayTime.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.01);
  }

  setBandPhase(bandId, invert) {
    this.state.bands[bandId].phaseInvert = invert;
    this.bandNodes[bandId].phase.gain.setTargetAtTime(invert ? -1 : 1, this.ctx.currentTime, 0.005);
  }

  setBandMute(bandId, mute) {
    this.state.bands[bandId].mute = mute;
    this.updateMuteSolo();
  }

  setBandSolo(bandId, solo) {
    this.state.bands[bandId].solo = solo;
    this.updateMuteSolo();
  }

  updateMuteSolo() {
    const anySolo = BANDS.some((b) => this.state.bands[b.id].solo);
    BANDS.forEach((b) => {
      const st = this.state.bands[b.id];
      let on = true;
      if (anySolo) on = st.solo;
      if (st.mute) on = false;
      this.bandNodes[b.id].active.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
    });
  }

  setBandReverbOn(bandId, on) {
    const st = this.state.bands[bandId];
    st.reverbOn = on;
    const wet = on ? st.reverbWet : 0;
    this.bandNodes[bandId].wetGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.02);
  }

  setBandReverbWet(bandId, wet) {
    const st = this.state.bands[bandId];
    st.reverbWet = wet;
    if (st.reverbOn) {
      this.bandNodes[bandId].wetGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.02);
    }
  }

  setBandReverbPreset(bandId, presetKey) {
    const st = this.state.bands[bandId];
    st.reverbPreset = presetKey;
    this.bandNodes[bandId].convolver.buffer = this._makeImpulse(REVERB_PRESETS[presetKey]);
  }

  setBandComp(bandId, on) {
    const st = this.state.bands[bandId];
    const node = this.bandNodes[bandId];
    st.compOn = on;
    // route around compressor by adjusting ratio/threshold to "transparent"
    if (on) {
      node.comp.ratio.setTargetAtTime(st.compRatio, this.ctx.currentTime, 0.01);
      node.comp.threshold.setTargetAtTime(st.compThreshold, this.ctx.currentTime, 0.01);
    } else {
      node.comp.ratio.setTargetAtTime(1, this.ctx.currentTime, 0.01);
      node.comp.threshold.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    }
  }

  setBandCompThreshold(bandId, db) {
    this.state.bands[bandId].compThreshold = db;
    if (this.state.bands[bandId].compOn) {
      this.bandNodes[bandId].comp.threshold.setTargetAtTime(db, this.ctx.currentTime, 0.01);
    }
  }

  setBandCompRatio(bandId, ratio) {
    this.state.bands[bandId].compRatio = ratio;
    if (this.state.bands[bandId].compOn) {
      this.bandNodes[bandId].comp.ratio.setTargetAtTime(ratio, this.ctx.currentTime, 0.01);
    }
  }

  setMasterGain(db) {
    this.state.master.gainDb = db;
    this.masterGain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setMasterLimiter(db) {
    this.state.master.limiterThreshold = db;
    this.masterLimiter.threshold.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  // ---- metering helpers ---------------------------------------------------
  getBandLevel(bandId) {
    return this._rms(this.bandNodes[bandId].meter);
  }

  getMasterLevel() {
    return this._rms(this.masterMeter);
  }

  _rms(analyser) {
    if (!analyser._buf) analyser._buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(analyser._buf);
    let sum = 0;
    for (let i = 0; i < analyser._buf.length; i++) sum += analyser._buf[i] * analyser._buf[i];
    return Math.sqrt(sum / analyser._buf.length);
  }

  getSpectrum(out) {
    this.masterAnalyser.getByteFrequencyData(out);
    return out;
  }

  // ---- decode helper ------------------------------------------------------
  async decode(arrayBuffer) {
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  // ============================================================
  //  Preset (de)serialization
  // ============================================================
  exportState() {
    return JSON.parse(JSON.stringify({
      master: this.state.master,
      vocal: this.state.vocal,
      geq: this.state.geq,
      xover: this.state.xover,
      bands: this.state.bands,
    }));
  }

  importState(s) {
    if (!s) return;
    if (s.vocal) this.setVocalAmount(s.vocal.amount);
    if (Array.isArray(s.geq)) s.geq.forEach((db, i) => this.setGeqBand(i, db));
    if (s.xover) {
      Object.entries(s.xover).forEach(([k, v]) => { this.state.xover[k] = v; });
      this._applyCrossoverFreqs();
    }
    if (s.bands) {
      Object.entries(s.bands).forEach(([id, b]) => {
        if (!this.bandNodes[id]) return;
        this.setBandGain(id, b.gainDb);
        this.setBandDelay(id, b.delayMs);
        this.setBandPhase(id, b.phaseInvert);
        this.setBandReverbPreset(id, b.reverbPreset || 'hall');
        this.setBandReverbWet(id, b.reverbWet);
        this.setBandReverbOn(id, b.reverbOn);
        this.setBandCompThreshold(id, b.compThreshold);
        this.setBandCompRatio(id, b.compRatio);
        this.setBandComp(id, b.compOn !== false);
        this.state.bands[id].mute = !!b.mute;
        this.state.bands[id].solo = !!b.solo;
      });
      this.updateMuteSolo();
    }
    if (s.master) {
      this.setMasterGain(s.master.gainDb);
      this.setMasterLimiter(s.master.limiterThreshold);
    }
  }
}
