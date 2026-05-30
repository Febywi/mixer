// ============================================================
//  constants.js — Global configuration & DSP constants
// ============================================================

// ISO 1/3-octave standard center frequencies for the 31-band Graphic EQ
export const ISO_31_BANDS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160,
  200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
  20000,
];

// Q factor for a 1/3-octave peaking filter (constant-Q graphic EQ)
export const GEQ_Q = 4.318;

// Graphic EQ gain range (dB) — wide range for full control
export const GEQ_MIN_DB = -15;
export const GEQ_MAX_DB = 15;

// ------------------------------------------------------------
//  Crossover band definitions (4-way)
//  Sub: < 65 Hz  |  Low: 65–300 Hz  |  Mid: 300–3k  |  High: > 3k
// ------------------------------------------------------------
export const BANDS = [
  {
    id: 'sub',
    name: 'SUB',
    type: 'lowpass', // only an upper cutoff
    hpf: null,
    lpf: 65,
    color: '#ff3b6b',
    accent: '#ff7aa0',
    reverbDefault: false,
  },
  {
    id: 'low',
    name: 'LOW',
    type: 'bandpass',
    hpf: 65,
    lpf: 300,
    color: '#ff9f1c',
    accent: '#ffc266',
    reverbDefault: false,
  },
  {
    id: 'mid',
    name: 'MID',
    type: 'bandpass',
    hpf: 300,
    lpf: 3000,
    color: '#2ec4b6',
    accent: '#6fe3d8',
    reverbDefault: true,
  },
  {
    id: 'high',
    name: 'HIGH',
    type: 'highpass', // only a lower cutoff
    hpf: 3000,
    lpf: null,
    color: '#4895ef',
    accent: '#8ab9f5',
    reverbDefault: true,
  },
];

// Crossover frequency adjustable ranges (Hz) for the UI sliders — wide for freedom
export const XOVER_RANGES = {
  subLow: { min: 30, max: 200, default: 65 },     // Sub / Low split
  lowMid: { min: 100, max: 1200, default: 300 },  // Low / Mid split
  midHigh: { min: 800, max: 9000, default: 3000 },// Mid / High split
};

// Per-band default processing values
export const BAND_DEFAULTS = {
  gainDb: 0,
  delayMs: 0,
  reverbWet: 0.2,
  // Compressor / limiter — gentle, soft-knee (off by default for clean sound)
  compThreshold: -18,
  compRatio: 2.5,
  compAttack: 0.012,
  compRelease: 0.25,
  compKnee: 18,
  limiterThreshold: -3,
  // Echo / delay FX (feedback echo, separate from alignment delay)
  echoOn: false,
  echoTimeMs: 350,
  echoFeedback: 0.35,
  echoWet: 0.3,
};

// Input channel-strip defaults (applied before EQ/crossover)
export const INPUT_DEFAULTS = {
  gainDb: 0,
  lowCutOn: false,
  lowCutFreq: 80,
  gateOn: false,
  gateThreshold: -45,  // dBFS; below this the gate closes
};

// Master section defaults — soft-knee limiter to avoid harsh clamping
export const MASTER_DEFAULTS = {
  gainDb: 0,
  limiterThreshold: -1,
  limiterRelease: 0.18,
};

// Reverb impulse response defaults (synthesized, no external file)
export const REVERB_PRESETS = {
  room:   { seconds: 1.2, decay: 2.5, name: 'Room' },
  hall:   { seconds: 2.8, decay: 2.0, name: 'Hall' },
  plate:  { seconds: 1.8, decay: 3.5, name: 'Plate' },
  church: { seconds: 4.5, decay: 1.6, name: 'Church' },
};

// Utility: convert dB to linear gain
export const dbToGain = (db) => Math.pow(10, db / 20);

// Utility: convert linear gain to dB
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-6));

// Utility: clamp
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Format frequency for display
export const fmtFreq = (hz) => {
  if (hz >= 1000) {
    const k = hz / 1000;
    return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return hz % 1 === 0 ? hz.toFixed(0) : hz.toFixed(1);
};

export const LS_PRESET_KEY = 'dlmsmixer.presets.v1';
export const LS_LAST_STATE_KEY = 'dlmsmixer.laststate.v1';
