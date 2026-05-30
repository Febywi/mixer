// ============================================================
//  audioEngine.js — Real-time DSP graph (Web Audio API)
//
//  Signal flow:
//    tracks -> inputBus -> [input gain -> low-cut/HPF -> noise gate]
//      -> vocalRemover -> 31-band GEQ -> crossover (SUB/LOW/MID/HIGH)
//      -> per band: phase -> alignment delay -> compressor
//                   -> (dry + reverb + feedback echo) -> level
//                   -> mute/solo -> meter -> masterSum
//      -> masterSum -> master limiter -> master gain -> analyser -> out
// ============================================================

import {
  ISO_31_BANDS, GEQ_Q, BANDS, XOVER_RANGES, BAND_DEFAULTS,
  MASTER_DEFAULTS, INPUT_DEFAULTS, REVERB_PRESETS, dbToGain, gainToDb, clamp,
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
      input: { ...INPUT_DEFAULTS },
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
        compOn: false,
        compThreshold: BAND_DEFAULTS.compThreshold,
        compRatio: BAND_DEFAULTS.compRatio,
        limiterThreshold: BAND_DEFAULTS.limiterThreshold,
        echoOn: BAND_DEFAULTS.echoOn,
        echoTimeMs: BAND_DEFAULTS.echoTimeMs,
        echoFeedback: BAND_DEFAULTS.echoFeedback,
        echoWet: BAND_DEFAULTS.echoWet,
      };
    });

    // gate envelope state (per input strip)
    this._gateOpen = 1;
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

    // ---- Input channel strip: gain -> low-cut (HPF) -> gate ----
    this._buildInputStrip();
    this.inputBus.connect(this.input.gain);

    // ---- Vocal remover sub-graph (mid-side) ----
    this._buildVocalRemover();
    this.input.gateGain.connect(this.vr.input);

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
    this.masterLimiter.knee.value = 6;     // soft knee = smooth, non-harsh limiting
    this.masterLimiter.ratio.value = 12;
    this.masterLimiter.attack.value = 0.005;
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

  _buildInputStrip() {
    const ctx = this.ctx;
    const st = this.state.input;

    const gain = ctx.createGain();
    gain.gain.value = dbToGain(st.gainDb);

    // low cut / HPF (12 dB/oct). When off, push cutoff sub-audible (~10 Hz).
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = 'highpass';
    lowCut.Q.value = LR_Q;
    lowCut.frequency.value = st.lowCutOn ? st.lowCutFreq : 10;

    // noise gate: gain controlled by an envelope follower (rAF-driven, smoothed)
    const gateGain = ctx.createGain();
    gateGain.gain.value = 1;

    const gateMeter = ctx.createAnalyser();
    gateMeter.fftSize = 1024;

    gain.connect(lowCut);
    lowCut.connect(gateGain);
    lowCut.connect(gateMeter); // observation tap

    this.input = { gain, lowCut, gateGain, gateMeter };
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
    comp.knee.value = BAND_DEFAULTS.compKnee;
    comp.attack.value = BAND_DEFAULTS.compAttack;
    comp.release.value = BAND_DEFAULTS.compRelease;
    if (st.compOn) {
      comp.threshold.value = st.compThreshold;
      comp.ratio.value = st.compRatio;
    } else {
      // transparent (no compression) until enabled
      comp.threshold.value = 0;
      comp.ratio.value = 1;
    }
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

    // echo / delay FX — real feedback echo (separate from alignment delay)
    const echoDelay = ctx.createDelay(2.0);
    echoDelay.delayTime.value = st.echoTimeMs / 1000;
    const echoFb = ctx.createGain();
    echoFb.gain.value = st.echoOn ? st.echoFeedback : 0;
    const echoWet = ctx.createGain();
    echoWet.gain.value = st.echoOn ? st.echoWet : 0;
    // damp the repeats a touch so they don't sound harsh
    const echoDamp = ctx.createBiquadFilter();
    echoDamp.type = 'lowpass';
    echoDamp.frequency.value = 6500;
    echoDamp.Q.value = LR_Q;
    postComp.connect(echoDelay);
    echoDelay.connect(echoDamp);
    echoDamp.connect(echoFb);
    echoFb.connect(echoDelay);     // feedback loop
    echoDelay.connect(echoWet);
    echoWet.connect(mix);

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
      echoDelay, echoFb, echoWet, echoDamp,
      compBypassed: false,
    };
  }

  // ---- reverb impulse synthesis (no external files) -----------------------
  // Smooth, natural tail: filtered noise + progressive high-frequency damping
  // + fade-in + normalization. Avoids the harsh/grainy "white-noise" reverb.
  _makeImpulse({ seconds, decay }) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    const fadeIn = Math.max(1, Math.floor(rate * 0.006)); // ~6ms fade-in (no click)

    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;     // one-pole lowpass state (smooths/dampens the noise)
      let peak = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // exponential energy decay
        const env = Math.pow(1 - t, decay);
        // damping: brighter early, darker in the tail (natural air absorption)
        const damp = 0.55 - 0.42 * t;        // cutoff coeff: ~bright -> dark
        const white = Math.random() * 2 - 1;
        lp += damp * (white - lp);           // low-passed noise
        let s = lp * env;
        if (i < fadeIn) s *= i / fadeIn;     // smooth onset
        data[i] = s;
        const a = Math.abs(s);
        if (a > peak) peak = a;
      }
      // normalize so reverb level is consistent across presets
      if (peak > 0) {
        const norm = 0.9 / peak;
        for (let i = 0; i < len; i++) data[i] *= norm;
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

  // ---- input channel strip ----
  setInputGain(db) {
    this.state.input.gainDb = db;
    this.input.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setLowCut(on) {
    this.state.input.lowCutOn = on;
    const f = on ? this.state.input.lowCutFreq : 10;
    this.input.lowCut.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
  }

  setLowCutFreq(hz) {
    this.state.input.lowCutFreq = hz;
    if (this.state.input.lowCutOn) {
      this.input.lowCut.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
    }
  }

  setGate(on) {
    this.state.input.gateOn = on;
    if (!on) {
      this._gateOpen = 1;
      this.input.gateGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
    }
  }

  setGateThreshold(db) {
    this.state.input.gateThreshold = db;
  }

  // Called each animation frame to drive the noise gate envelope.
  tickGate() {
    if (!this.input || !this.state.input.gateOn) return;
    const rms = this._rms(this.input.gateMeter);
    const db = gainToDb(rms);
    const th = this.state.input.gateThreshold;
    // hysteresis: open a bit above threshold, close a bit below
    const open = this._gateOpen > 0.5 ? db > th - 3 : db > th + 1;
    const target = open ? 1 : 0;
    this._gateOpen = target;
    // fast attack (open), slower release (close) to avoid choppiness
    const tc = target ? 0.005 : 0.08;
    this.input.gateGain.gain.setTargetAtTime(target, this.ctx.currentTime, tc);
  }

  // ---- per-band echo / delay FX ----
  setBandEcho(bandId, on) {
    const st = this.state.bands[bandId];
    st.echoOn = on;
    const n = this.bandNodes[bandId];
    const t = this.ctx.currentTime;
    n.echoWet.gain.setTargetAtTime(on ? st.echoWet : 0, t, 0.02);
    n.echoFb.gain.setTargetAtTime(on ? st.echoFeedback : 0, t, 0.02);
  }

  setBandEchoTime(bandId, ms) {
    this.state.bands[bandId].echoTimeMs = ms;
    this.bandNodes[bandId].echoDelay.delayTime.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.02);
  }

  setBandEchoFeedback(bandId, fb) {
    fb = clamp(fb, 0, 0.9);
    this.state.bands[bandId].echoFeedback = fb;
    if (this.state.bands[bandId].echoOn) {
      this.bandNodes[bandId].echoFb.gain.setTargetAtTime(fb, this.ctx.currentTime, 0.02);
    }
  }

  setBandEchoWet(bandId, wet) {
    this.state.bands[bandId].echoWet = wet;
    if (this.state.bands[bandId].echoOn) {
      this.bandNodes[bandId].echoWet.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.02);
    }
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
      input: this.state.input,
      vocal: this.state.vocal,
      geq: this.state.geq,
      xover: this.state.xover,
      bands: this.state.bands,
    }));
  }

  importState(s) {
    if (!s) return;
    if (s.input) {
      const i = s.input;
      this.state.input.lowCutFreq = i.lowCutFreq ?? this.state.input.lowCutFreq;
      this.state.input.gateThreshold = i.gateThreshold ?? this.state.input.gateThreshold;
      this.setInputGain(i.gainDb ?? 0);
      this.setLowCutFreq(this.state.input.lowCutFreq);
      this.setLowCut(!!i.lowCutOn);
      this.setGate(!!i.gateOn);
      this.setGateThreshold(this.state.input.gateThreshold);
    }
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
        this.setBandComp(id, !!b.compOn);
        // echo
        if (b.echoTimeMs != null) this.setBandEchoTime(id, b.echoTimeMs);
        if (b.echoFeedback != null) this.state.bands[id].echoFeedback = b.echoFeedback;
        if (b.echoWet != null) this.state.bands[id].echoWet = b.echoWet;
        this.setBandEcho(id, !!b.echoOn);
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
