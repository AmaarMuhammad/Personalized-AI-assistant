// Cuts the silence off both ends of a recording before Whisper hears it.
//
// Why: every recording ends with the 3 seconds of quiet that told Jarvis you had stopped, and
// a clip that is mostly quiet is where Whisper invents text ("*sad music*", "foreign").
// This keeps a short margin around the speech so word starts and endings are not clipped.
const RATE = 16000;
const FRAME = 480; // 30 ms

function frameLevels(audio) {
  const n = Math.floor(audio.length / FRAME);
  const levels = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * FRAME, end = i + FRAME; i < end; i++) sum += audio[i] * audio[i];
    levels[f] = Math.sqrt(sum / FRAME);
  }
  return levels;
}

// Returns { audio, speechSeconds, start, end }. `audio` is the input itself when nothing was cut,
// and empty when no frame rose above the room noise.
export function trimSilence(audio, { marginMs = 300, minLevel = 0.008, ratio = 3 } = {}) {
  const levels = frameLevels(audio);
  if (!levels.length) return { audio: new Float32Array(0), speechSeconds: 0, start: 0, end: 0 };
  // Room noise = the quietest fifth of the clip.
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  // Capped by the loud end, so a clip that is speech from start to finish (no quiet fifth) isn't judged all noise.
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  const threshold = Math.max(minLevel, floor * ratio < loud * 0.5 ? floor * ratio : loud * 0.25);
  let first = -1;
  let last = -1;
  let voiced = 0;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < threshold) continue;
    voiced++;
    if (first < 0) first = f;
    last = f;
  }
  const speechSeconds = (voiced * FRAME) / RATE;
  if (first < 0) return { audio: new Float32Array(0), speechSeconds: 0, start: 0, end: 0 };
  const margin = Math.round((marginMs / 1000) * RATE);
  const start = Math.max(0, first * FRAME - margin);
  const end = Math.min(audio.length, (last + 1) * FRAME + margin);
  return { audio: start === 0 && end === audio.length ? audio : audio.subarray(start, end), speechSeconds, start, end };
}
