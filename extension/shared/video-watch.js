// @ts-check
/**
 * watch_video's pure parts: how the pictures of a video are laid out on contact sheets (a grid of frames, each
 * with its time), and the sound as a WAV file (16 kHz mono, the format speech models take everywhere).
 * The capturing itself is in panel/lib/inspections.js and page-scripts.js.
 */

/** The longest a video is watched in one call (seconds), and how many pictures are taken of it at most. */
export const MAX_WATCH_SECONDS = 60;
export const MAX_FRAMES = 24;
/** Frames per contact sheet, and the sheet's longest side (px): one sheet counts as one image for the AI. */
export const FRAMES_PER_SHEET = 12;
export const SHEET_MAX_SIDE = 1568;
export const SOUND_RATE = 16_000;

/**
 * How long to watch and how often to take a picture.
 * @param {{ seconds?: number }} input
 * @param {{ duration: number | null, currentTime: number }} video
 */
export function watchPlan(input, video) {
  const left = video.duration ? Math.max(0, video.duration - video.currentTime) : Infinity;
  const asked = Number(input.seconds) > 0 ? Number(input.seconds) : left;
  // A video near its end: watch it from where it is to the end (it loops or stops), at least a few seconds.
  const seconds = Math.min(MAX_WATCH_SECONDS, Math.max(3, Number.isFinite(asked) ? asked : 30));
  return { seconds, everyMs: Math.round(Math.max(1.5, seconds / (MAX_FRAMES - 1)) * 1000) };
}

/**
 * The grid for n frames of a video with this shape (width / height): portrait videos in rows of 6, others in
 * rows of 4; cells as large as the sheet allows.
 * @param {number} n
 * @param {number} aspect
 */
export function sheetLayout(n, aspect) {
  const cols = Math.min(n, aspect < 1 ? 6 : 4);
  const rows = Math.ceil(n / cols);
  let cellW = Math.floor(SHEET_MAX_SIDE / cols);
  let cellH = Math.round(cellW / aspect);
  if (cellH * rows > SHEET_MAX_SIDE) {
    cellH = Math.floor(SHEET_MAX_SIDE / rows);
    cellW = Math.round(cellH * aspect);
  }
  return { cols, rows, cellW, cellH, width: cellW * cols, height: cellH * rows };
}

/** "m:ss" for a time in seconds. @param {number} seconds */
export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Samples (-1…1) → a 16-bit PCM WAV file.
 * @param {Float32Array} samples
 * @param {number} rate
 */
export function encodeWav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (/** @type {number} */ at, /** @type {string} */ s) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);       // size of this part
  out.setUint16(20, 1, true);        // PCM
  out.setUint16(22, 1, true);        // mono
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); // bytes per second
  out.setUint16(32, 2, true);        // bytes per sample
  out.setUint16(34, 16, true);       // bits per sample
  text(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/**
 * How loud the recording is (the peak, 0…1): near 0 means the video was silent, muted for recording, or
 * protected, and the AI is told so instead of getting silence.
 * @param {Float32Array} samples
 */
export function peakLevel(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}
