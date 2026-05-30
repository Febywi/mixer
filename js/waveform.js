/* ============================================================
   waveform.js — DAW-style waveform, click-to-seek
   ============================================================ */

(function () {
  "use strict";

  class Waveform {
    constructor(canvas, wrap) {
      this.canvas = canvas;
      this.g = canvas.getContext("2d");
      this.wrap = wrap;
      this.peaks = null;
      this.onSeek = null; // (ratio) => {}
      this.cursorEl = wrap.querySelector(".wave-cursor");

      wrap.addEventListener("click", (e) => {
        if (!this.onSeek) return;
        const r = wrap.getBoundingClientRect();
        this.onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      });
      wrap.addEventListener("mousemove", (e) => {
        if (!this.cursorEl) return;
        const r = wrap.getBoundingClientRect();
        this.cursorEl.style.left = (e.clientX - r.left) + "px";
      });
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.W = Math.max(10, r.width); this.H = Math.max(10, r.height);
      this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.peaks) this._render();
    }

    setBuffer(audioBuffer) {
      const W = Math.max(200, Math.floor(this.W));
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
      const block = Math.floor(ch0.length / W) || 1;
      const peaks = new Float32Array(W);
      for (let i = 0; i < W; i++) {
        let max = 0;
        const start = i * block;
        const end = Math.min(ch0.length, start + block);
        for (let j = start; j < end; j++) {
          const v = Math.abs((ch0[j] + ch1[j]) * 0.5);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      this.peaks = peaks;
      this._render();
    }

    clear() { this.peaks = null; this.g.clearRect(0, 0, this.W, this.H); }

    _render() {
      const g = this.g, W = this.W, H = this.H, mid = H / 2;
      g.clearRect(0, 0, W, H);
      if (!this.peaks) return;
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(34,211,238,0.85)");
      grad.addColorStop(0.5, "rgba(124,92,255,0.7)");
      grad.addColorStop(1, "rgba(34,211,238,0.85)");
      g.fillStyle = grad;
      const n = this.peaks.length;
      const bw = W / n;
      for (let i = 0; i < n; i++) {
        const h = Math.max(1, this.peaks[i] * (H * 0.92));
        const x = i * bw;
        g.fillRect(x, mid - h / 2, Math.max(1, bw * 0.7), h);
      }
      // center line
      g.strokeStyle = "rgba(255,255,255,0.06)";
      g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
    }
  }

  window.Waveform = Waveform;
})();
