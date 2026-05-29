// ============================================================
//  visualizer.js — Canvas drawing for spectrum, EQ curve, VU
// ============================================================

import { ISO_31_BANDS, GEQ_MIN_DB, GEQ_MAX_DB, fmtFreq } from './constants.js';

// Map a frequency (20–20000) to an x position (0..1) on a log scale
function freqToX(freq, min = 20, max = 20000) {
  const lf = Math.log10(freq);
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  return (lf - lmin) / (lmax - lmin);
}

// ------------------------------------------------------------
//  Spectrum analyzer (real-time FFT bars) + GEQ curve overlay
// ------------------------------------------------------------
export class SpectrumView {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.bins = new Uint8Array(engine.masterAnalyser.frequencyBinCount);
    this.sampleRate = engine.ctx.sampleRate;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // background grid
    this._grid();

    // spectrum
    this.engine.getSpectrum(this.bins);
    const nyquist = this.sampleRate / 2;
    const binCount = this.bins.length;

    ctx.beginPath();
    let started = false;
    for (let x = 0; x <= w; x += 2) {
      const frac = x / w;
      // inverse log mapping
      const freq = Math.pow(10, Math.log10(20) + frac * (Math.log10(20000) - Math.log10(20)));
      const bin = Math.min(binCount - 1, Math.round((freq / nyquist) * binCount));
      const v = this.bins[bin] / 255;
      const y = h - v * h * 0.95;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(46,196,182,0.55)');
    grad.addColorStop(0.5, 'rgba(72,149,239,0.35)');
    grad.addColorStop(1, 'rgba(72,149,239,0.04)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(120,230,220,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // GEQ curve overlay
    this._geqCurve();
  }

  _grid() {
    const { ctx, w, h } = this;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const marks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    marks.forEach((f) => {
      const x = freqToX(f) * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillText(fmtFreq(f), x, h - 4);
    });
    // dB lines
    for (let db = -60; db <= 0; db += 20) {
      const y = h - (db + 80) / 80 * h;
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  _geqCurve() {
    const { ctx, w, h } = this;
    const gains = this.engine.state.geq;
    ctx.beginPath();
    ISO_31_BANDS.forEach((f, i) => {
      const x = freqToX(f) * w;
      const norm = (gains[i] - GEQ_MIN_DB) / (GEQ_MAX_DB - GEQ_MIN_DB); // 0..1
      const y = h - norm * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(255,159,28,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ------------------------------------------------------------
//  VU meter — draws a vertical level bar with peak hold
// ------------------------------------------------------------
export class VuMeter {
  constructor(canvas, color = '#2ec4b6') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.peak = 0;
    this.peakHoldUntil = 0;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // rms: 0..~1 linear
  draw(rms) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // convert to dB scale for nicer ballistics (-60..0 dB -> 0..1)
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const level = Math.max(0, Math.min(1, (db + 60) / 60));

    const now = performance.now();
    if (level >= this.peak) {
      this.peak = level;
      this.peakHoldUntil = now + 800;
    } else if (now > this.peakHoldUntil) {
      this.peak = Math.max(level, this.peak - 0.02);
    }

    // background
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    // gradient meter (green -> yellow -> red)
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#27d07c');
    grad.addColorStop(0.7, '#ffd23f');
    grad.addColorStop(0.88, '#ff9f1c');
    grad.addColorStop(1, '#ff3b6b');
    ctx.fillStyle = grad;
    const barH = level * h;
    ctx.fillRect(0, h - barH, w, barH);

    // peak line
    const py = h - this.peak * h;
    ctx.fillStyle = this.peak > 0.92 ? '#ff3b6b' : 'rgba(255,255,255,0.8)';
    ctx.fillRect(0, py - 1, w, 2);
  }
}
