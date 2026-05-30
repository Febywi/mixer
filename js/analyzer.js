/* ============================================================
   analyzer.js — big realtime spectrum analyzer (20Hz–20kHz)
   Draws each frequency band in its own color + master outline.
   ============================================================ */

(function () {
  "use strict";

  const FMIN = 20, FMAX = 20000;

  class Analyzer {
    constructor(canvas) {
      this.canvas = canvas;
      this.g = canvas.getContext("2d");
      this.sources = [];   // {analyser, color, buf}
      this.master = null;  // {analyser, buf}
      this.resize();
    }

    bind(engine) {
      this.sources = engine.CHANNEL_DEFS.map((d) => {
        const a = engine.channels[d.id].analyser;
        return { analyser: a, color: d.color, buf: new Uint8Array(a.frequencyBinCount) };
      });
      const ma = engine.outAnalyser;
      this.master = { analyser: ma, buf: new Uint8Array(ma.frequencyBinCount) };
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.W = Math.max(10, r.width); this.H = Math.max(10, r.height);
      this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _xToFreq(t) { return FMIN * Math.pow(FMAX / FMIN, t); }

    _drawSpectrum(buf, sr, fill, stroke) {
      const g = this.g, W = this.W, H = this.H, bins = buf.length;
      const steps = Math.floor(W);
      g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i <= steps; i++) {
        const f = this._xToFreq(i / steps);
        const bin = Math.min(bins - 1, Math.round((f / (sr / 2)) * bins));
        const v = buf[bin] / 255;
        const y = H - v * H * 0.95;
        g.lineTo(i, y);
      }
      g.lineTo(W, H); g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); }
    }

    draw() {
      const g = this.g, W = this.W, H = this.H;
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#12161c"; g.fillRect(0, 0, W, H);

      // grid
      g.font = "9px monospace"; g.textBaseline = "bottom";
      [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
        const x = (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
        g.strokeStyle = "rgba(255,255,255,0.05)"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
        g.fillStyle = "rgba(255,255,255,0.22)"; g.fillText(f >= 1000 ? (f / 1000) + "k" : f, x + 2, H - 2);
      });

      if (!this.sources.length) return;
      const sr = this.sources[0].analyser.context.sampleRate;

      // per-band filled spectra (additive glow)
      g.globalCompositeOperation = "lighter";
      this.sources.forEach((s) => {
        s.analyser.getByteFrequencyData(s.buf);
        this._drawSpectrum(s.buf, sr, this._a(s.color, 0.22), this._a(s.color, 0.6));
      });
      g.globalCompositeOperation = "source-over";

      // master outline on top
      if (this.master) {
        this.master.analyser.getByteFrequencyData(this.master.buf);
        g.shadowColor = "rgba(255,255,255,.5)"; g.shadowBlur = 6;
        this._drawSpectrum(this.master.buf, sr, null, "rgba(230,234,240,0.9)");
        g.shadowBlur = 0;
      }
    }

    _a(hex, a) {
      const h = hex.replace("#", "");
      return `rgba(${parseInt(h.substr(0,2),16)},${parseInt(h.substr(2,2),16)},${parseInt(h.substr(4,2),16)},${a})`;
    }
  }

  window.Analyzer = Analyzer;
})();
