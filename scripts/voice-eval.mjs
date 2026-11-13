// Measures the hearing pipeline against your saved recordings (JARVIS_VOICE_DEBUG captures).
//
//   node scripts/voice-eval.mjs [folder] [--limit N]
//
// For every <name>.wav it transcribes twice, the old way (whole clip) and the current way
// (silence trimmed), and writes voice-eval.json into the folder. If <folder>/truth.json exists
// ({ "<name>": "what you actually said" }), it also reports word error rate for both.
// Nothing leaves this PC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceEngine } from '../app/voice/engine.js';
import { trimSilence } from '../app/voice/trim.js';
import { isNoiseTranscript } from '../app/main/speech.js';

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const dir = args.find((a) => !a.startsWith('--') && Number.isNaN(Number(a))) || process.env.JARVIS_VOICE_DEBUG_DIR || path.join(process.env.APPDATA, 'Jarvis', 'voice-debug');
const modelsDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Jarvis', 'models');

function readWav(file) {
  const b = fs.readFileSync(file);
  const pcm = b.subarray(44);
  const out = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function wordErrors(truth, got) {
  const a = norm(truth).split(' ').filter(Boolean);
  const b = norm(got).split(' ').filter(Boolean);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return { errors: d[a.length][b.length], words: a.length };
}

const names = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)).sort().slice(0, limit);
let truth = {};
try {
  truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
} catch {
  /* optional */
}
const engine = new VoiceEngine({ modelsDir });
const rows = [];
const total = { before: { errors: 0, words: 0 }, after: { errors: 0, words: 0 }, msBefore: 0, msAfter: 0, secBefore: 0, secAfter: 0 };
for (const [i, name] of names.entries()) {
  const audio = readWav(path.join(dir, `${name}.wav`));
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  } catch {
    /* no sidecar */
  }
  const language = meta.setting && meta.setting !== 'auto' ? meta.setting : null;
  const t = trimSilence(audio);
  let t0 = Date.now();
  const before = await engine.transcribe(audio, { language, trim: false });
  const msBefore = Date.now() - t0;
  t0 = Date.now();
  const after = await engine.transcribe(audio, { language });
  const msAfter = Date.now() - t0;
  const row = {
    name, setting: meta.setting ?? null, seconds: +(audio.length / 16000).toFixed(1), speechSeconds: +t.speechSeconds.toFixed(1),
    keptSeconds: +(t.audio.length / 16000).toFixed(1), before: before.text, after: after.text, changed: norm(before.text) !== norm(after.text),
    noiseBefore: isNoiseTranscript(before.text), noiseAfter: isNoiseTranscript(after.text), msBefore, msAfter,
  };
  if (truth[name] != null) {
    row.truth = truth[name];
    const eb = wordErrors(truth[name], before.text);
    const ea = wordErrors(truth[name], after.text);
    total.before.errors += eb.errors; total.before.words += eb.words;
    total.after.errors += ea.errors; total.after.words += ea.words;
  }
  total.msBefore += msBefore; total.msAfter += msAfter; total.secBefore += row.seconds; total.secAfter += row.keptSeconds;
  rows.push(row);
  console.log(`${i + 1}/${names.length} ${name}  ${row.seconds}s -> ${row.keptSeconds}s${row.changed ? '  CHANGED' : ''}`);
  if (row.changed) console.log(`   before: ${before.text}\n   after : ${after.text}`);
}
const summary = {
  clips: rows.length, device: engine.whisperDevice,
  audioSecondsBefore: Math.round(total.secBefore), audioSecondsAfter: Math.round(total.secAfter),
  avgMsBefore: Math.round(total.msBefore / rows.length), avgMsAfter: Math.round(total.msAfter / rows.length),
  changed: rows.filter((r) => r.changed).length,
  droppedAsNoiseBefore: rows.filter((r) => r.noiseBefore).length, droppedAsNoiseAfter: rows.filter((r) => r.noiseAfter).length,
  ...(total.before.words ? { werBefore: +(total.before.errors / total.before.words).toFixed(3), werAfter: +(total.after.errors / total.after.words).toFixed(3), truthClips: rows.filter((r) => r.truth != null).length } : {}),
};
fs.writeFileSync(path.join(dir, 'voice-eval.json'), JSON.stringify({ summary, rows }, null, 2));
if (!fs.existsSync(path.join(dir, 'truth.json'))) {
  // A file for you to correct: each line starts as what Whisper heard.
  fs.writeFileSync(path.join(dir, 'truth.template.json'), JSON.stringify(Object.fromEntries(rows.map((r) => [r.name, r.after])), null, 2));
}
console.log('\n' + JSON.stringify(summary, null, 2));
