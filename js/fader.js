// ============================================================
//  fader.js — pointer-driven vertical fader (mouse + touch)
//  Reliable dragging without relying on rotated native sliders.
// ============================================================

import { clamp } from './constants.js';

export class VerticalFader {
  /**
   * @param {HTMLElement} track  the slot element (.vfader)
   * @param {HTMLElement} cap    the knob element (.vfader-cap)
   * @param {object} opts        { min, max, step, value, capHeight, onInput }
   */
  constructor(track, cap, { min, max, step, value, capHeight = 14, onInput } = {}) {
    this.track = track;
    this.cap = cap;
    this.min = min;
    this.max = max;
    this.step = step;
    this.value = value;
    this.capH = capHeight; // must match .vfader-cap height in CSS
    this.onInput = onInput;
    this._bind();
    this.set(value, false);
  }

  // travel range (px) the cap centre can move across
  _usable() {
    return Math.max(1, this.track.clientHeight - this.capH);
  }

  // compute the cap "top" (px) for a given value
  topForValue(v) {
    const f = (v - this.min) / (this.max - this.min); // 0..1
    return (1 - f) * this._usable(); // max -> top(0), min -> bottom
  }

  set(v, fire = true) {
    v = clamp(v, this.min, this.max);
    v = Math.round(v / this.step) * this.step;
    if (Object.is(v, -0)) v = 0;
    this.value = v;
    this.cap.style.top = `${this.topForValue(v)}px`;
    if (fire && this.onInput) this.onInput(v);
    return v;
  }

  // map a pointer Y (clientY) to a value
  valueFromY(clientY) {
    const rect = this.track.getBoundingClientRect();
    const usable = rect.height - this.capH;
    let y = clientY - rect.top - this.capH / 2;
    y = clamp(y, 0, usable);
    const f = 1 - y / usable;
    return this.min + f * (this.max - this.min);
  }

  _bind() {
    if (!this.track.addEventListener) return; // test/non-DOM safety
    const move = (e) => { this.set(this.valueFromY(e.clientY)); };
    const up = (e) => {
      this.track.classList.remove('dragging');
      try { this.track.releasePointerCapture(e.pointerId); } catch (err) {}
      this.track.removeEventListener('pointermove', move);
      this.track.removeEventListener('pointerup', up);
      this.track.removeEventListener('pointercancel', up);
    };
    this.track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.track.classList.add('dragging');
      try { this.track.setPointerCapture(e.pointerId); } catch (err) {}
      this.set(this.valueFromY(e.clientY));
      this.track.addEventListener('pointermove', move);
      this.track.addEventListener('pointerup', up);
      this.track.addEventListener('pointercancel', up);
    });
    this.track.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      this.set(this.value + dir * this.step * (e.shiftKey ? 4 : 1));
    }, { passive: false });
    this.track.addEventListener('dblclick', () => this.set(0));
  }
}
