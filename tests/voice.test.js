// Voice: what gets said, in which voice, sentence by sentence; downloads that
// survive a flaky connection; and settings that only take known values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SentenceSplitter, isNoiseTranscript, speakable, utterance, SPOKEN_HINT } from '../app/main/speech.js';
import { download, phonemeIds, scriptLanguage } from '../app/voice/engine.js';
import { Settings, defaultSettings } from '../app/main/settings.js';

test('replies are cleaned up for speaking: no markdown, links, code or sources', () => {
  const md = '## Plan\n\n- **Call** the [bank](https://bank.example) at 5pm\n- Check `inbox`\n\n```js\nx()\n```\n| a | b |\n|---|---|\n\nSee https://x.example\n\nSources:\n- [A](https://a.example)';
  const s = speakable(md);
  assert.doesNotMatch(s, /[#*`|[\]]|https?:|Sources|\(https/);
  assert.match(s, /Plan\nCall the bank at 5pm\nCheck inbox/);
  assert.match(s, /the code is on screen/);
});

test('streaming text is spoken one whole sentence at a time, English and Urdu', () => {
  const sp = new SentenceSplitter();
  assert.deepEqual(sp.push('Good morn'), []);
  assert.deepEqual(sp.push('ing. You have 3.5 hours free'), ['Good morning.']);
  assert.deepEqual(sp.push(' today! آپ کی میٹنگ دس بجے ہے۔ کیا'), ['You have 3.5 hours free today!', 'آپ کی میٹنگ دس بجے ہے۔']);
  assert.deepEqual(sp.flush(), ['کیا']);
  assert.deepEqual(sp.flush(), []);
});

test('noise Whisper mistakes for speech is dropped; short real answers are kept', () => {
  for (const t of ['', '   ', '...', 'Uh.', 'Um, uhh', 'Hmm...', 'Thank you.', 'Thanks for watching!', ' you ', 'شکریہ۔', 'Please subscribe.']) {
    assert.equal(isNoiseTranscript(t), true, t);
  }
  for (const t of ['Yes.', 'No', 'Okay', 'Send it.', 'Thank you, now draft the reply', 'کل کا موسم کیسا ہوگا؟', 'شُکریہ، اب ای میل بھیج دو','Um, what time is my meeting?', '5']) {
    assert.equal(isNoiseTranscript(t), false, t);
  }
});

test('each sentence goes to the right voice by its script', () => {
  assert.deepEqual(utterance('**Done.** The email is in your drafts.'), { text: 'Done. The email is in your drafts.', language: 'english' });
  assert.equal(utterance('کل صبح Zoom پر meeting ہے۔').language, 'urdu');
  assert.equal(scriptLanguage('Meeting at 10 کل'), 'english');
  assert.equal(utterance('[the report](https://x.example)').text, 'the report', 'a link is read by its words');
  assert.equal(utterance('- https://x.example ---'), null, 'nothing left to say');
});

test('Piper input: start, each phoneme then a pad, end; unknown phonemes skipped', () => {
  const map = { _: [0], '^': [1], $: [2], a: [14], 'ː': [122], b: [15] };
  assert.deepEqual(phonemeIds(['a', 'ː', 'Ω', 'b'], map), [1, 0, 14, 0, 122, 0, 15, 0, 2]);
});

test('a spoken message carries the "reply for listening" note', async () => {
  assert.match(SPOKEN_HINT, /Urdu script/);
  assert.match(SPOKEN_HINT, /no markdown/);
});

test('voice settings only accept known values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-'));
  const s = new Settings(path.join(dir, 'settings.json'), defaultSettings(dir));
  s.update({ englishVoice: 'zz_unknown', urduVoice: 'robot', voiceLanguage: 'klingon', speakReplies: 'yes' });
  assert.equal(s.get().englishVoice, 'bm_george');
  assert.equal(s.get().urduVoice, 'fasih');
  assert.equal(s.get().voiceLanguage, 'auto');
  assert.equal(s.get().speakReplies, true);
  s.update({ englishVoice: 'af_heart', urduVoice: 'aegis', voiceLanguage: 'urdu' });
  assert.deepEqual([s.get().englishVoice, s.get().urduVoice, s.get().voiceLanguage], ['af_heart', 'aegis', 'urdu']);
});

// ---------- downloads on a flaky connection ----------

function flakyServer(bytes, script) {
  let call = 0;
  const seen = [];
  const fetchFn = async (_url, { headers = {}, signal } = {}) => {
    const step = script[Math.min(call++, script.length - 1)];
    const from = Number(/bytes=(\d+)-/.exec(headers.Range ?? '')?.[1] ?? 0);
    seen.push(from);
    const body = step.wrong ? Buffer.alloc(bytes.length, 7) : bytes.subarray(from, step.cut ? Math.min(bytes.length, from + step.cut) : bytes.length);
    async function* stream() {
      yield body.subarray(0, Math.ceil(body.length / 2));
      if (step.stall) await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      yield body.subarray(Math.ceil(body.length / 2));
    }
    return { ok: true, status: from ? 206 : 200, body: stream() };
  };
  return { fetchFn, seen };
}

test('a download that stalls, drops mid-file, or arrives wrong still ends with the right file', async () => {
  const bytes = crypto.randomBytes(10_000);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dl-')), 'model.onnx');
  const { fetchFn, seen } = flakyServer(bytes, [{ stall: true }, { cut: 3000 }, {}]);
  await download('https://x/model.onnx', dest, { size: bytes.length, sha256, fetchFn, stallMs: 50, attempts: 5 });
  assert.ok(fs.readFileSync(dest).equals(bytes));
  assert.equal(seen[0], 0);
  assert.ok(seen[1] > 0, 'resumed after the stall instead of starting over');
  assert.ok(seen[2] > seen[1], 'resumed again after the drop');
  assert.equal(fs.existsSync(`${dest}.part`), false);

  const dest2 = `${dest}.2`;
  const bad = flakyServer(bytes, [{ wrong: true }]);
  await assert.rejects(download('https://x/m', dest2, { size: bytes.length, sha256, fetchFn: bad.fetchFn, stallMs: 50, attempts: 2 }), /fingerprint/);
  assert.equal(fs.existsSync(dest2), false, 'a wrong file is never kept');
});

// ---- silence trimming (Nov 2026) ----
import { trimSilence } from '../app/voice/trim.js';

function clip(parts) {
  // parts: [seconds, amplitude] pairs; amplitude 0 = room noise only
  const out = new Float32Array(Math.round(parts.reduce((n, [s]) => n + s, 0) * 16000));
  let i = 0;
  for (const [s, amp] of parts) {
    for (const end = i + Math.round(s * 16000); i < end; i++) out[i] = (amp ? amp * Math.sin(i / 8) : 0) + 0.001 * Math.sin(i * 1.7);
  }
  return out;
}

test('the quiet before and after speech is cut, with a margin so word edges survive', () => {
  const t = trimSilence(clip([[1, 0], [2, 0.2], [3, 0]]));
  const kept = t.audio.length / 16000;
  assert.ok(kept > 2.4 && kept < 2.8, `kept ${kept}s`);
  assert.ok(Math.abs(t.speechSeconds - 2) < 0.1);
  assert.ok(t.start / 16000 > 0.6 && t.start / 16000 <= 0.72, 'about 300 ms kept before the first word');
});

test('a pause in the middle of a sentence is kept whole', () => {
  const t = trimSilence(clip([[0.5, 0], [1, 0.2], [2, 0], [1, 0.2], [3, 0]]));
  const kept = t.audio.length / 16000;
  assert.ok(kept > 4.4 && kept < 4.8, `kept ${kept}s`);
});

test('a recording with no speech in it comes back empty, and a clip that is all speech is untouched', () => {
  assert.equal(trimSilence(clip([[4, 0]])).speechSeconds, 0);
  assert.equal(trimSilence(clip([[4, 0]])).audio.length, 0);
  const all = clip([[2, 0.2]]);
  assert.equal(trimSilence(all).audio, all);
  assert.equal(trimSilence(new Float32Array(0)).audio.length, 0);
});

test('sound descriptions Whisper invents are dropped; a real sentence that mentions music is kept', () => {
  for (const s of ['*sad music*', '[Music]', '(applause)', 'موسیقی', 'foreign', 'Music']) assert.equal(isNoiseTranscript(s), true, s);
  for (const s of ['Play some music', 'Yes.', 'foreign policy news', '(quietly) send it']) assert.equal(isNoiseTranscript(s), false, s);
});
