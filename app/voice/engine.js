// The voice engine: hearing (Whisper) and speaking (Kokoro for English, Piper
// for Urdu). Everything runs on this PC; models are downloaded once from
// Hugging Face at pinned commits into Jarvis's own data folder.
//
// It runs in a separate process (see worker.js) so loading a 1.6 GB model or
// transcribing never freezes the window.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Pinned commits: a model changed upstream can't silently replace what you have.
const WHISPER = { id: 'onnx-community/whisper-large-v3-turbo', revision: '360ebcde2559d60bb474678be3c1de9ef347d01a' };
const KOKORO = { id: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231' };
const PIPER_REV = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117';

import { trimSilence } from './trim.js';

export const URDU_VOICES = {
  fasih: { label: 'Fasih (male)', file: 'ur/ur_PK/fasih/medium/ur_PK-fasih-medium', sha256: '46d590b90fbb41e4d4f2c54ded44874917f8b11b6e0500de2a89e5d3731b5917' },
  aegis: { label: 'Aegis (female)', file: 'ur/ur_PK/aegis_female/medium/ur_PK-aegis_female-medium', sha256: '3ec306035cfd0bbc22342fee5890450708a16dd231809522731678aa583c961f' },
};

// Kokoro voices shipped inside the kokoro-js package (no download needed).
export const ENGLISH_VOICES = {
  bm_george: 'George (British, male)',
  bm_fable: 'Fable (British, male)',
  am_michael: 'Michael (American, male)',
  af_heart: 'Heart (American, female)',
  bf_emma: 'Emma (British, female)',
};

const HUB = 'https://huggingface.co';

// Hashing streams the file so a 1.3 GB model never sits in memory.
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

// Downloads that survive slow or flaky connections: a stalled transfer is
// retried, a dropped one resumes where it stopped, and the finished file must
// match its expected size and fingerprint before anything uses it.
export async function download(url, dest, { size = 0, sha256 = null, onProgress, stallMs = 30_000, attempts = 40, fetchFn = fetch } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size && have > size) {
      fs.rmSync(part);
      have = 0;
    }
    if (!size || have < size) {
      const ctl = new AbortController();
      let timer = setTimeout(() => ctl.abort(), stallMs);
      try {
        const res = await fetchFn(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctl.signal });
        if (!(res.ok || res.status === 206)) throw new Error(`HTTP ${res.status}`);
        if (have && res.status !== 206) {
          fs.rmSync(part); // the server ignored the resume request; start over
          have = 0;
        }
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        let loaded = have;
        try {
          for await (const chunk of res.body) {
            clearTimeout(timer);
            timer = setTimeout(() => ctl.abort(), stallMs);
            loaded += chunk.length;
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            onProgress?.({ file: path.basename(dest), loaded, total: size });
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
      } catch (e) {
        if (attempt >= attempts) throw new Error(`Couldn't download ${path.basename(dest)}: ${e.message}`);
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * attempt)));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (size && fs.statSync(part).size < size) continue; // the connection ended early: resume
    }
    if (sha256 && (await sha256File(part)) !== sha256) {
      fs.rmSync(part);
      if (attempt >= attempts) throw new Error(`${path.basename(dest)} did not match its expected fingerprint.`);
      continue;
    }
    fs.renameSync(part, dest);
    return dest;
  }
}

// Fetches a model's files at a pinned commit into the cache layout
// transformers.js reads, so it loads them from disk and never downloads itself.
async function ensureHubFiles({ model, revision, files, cacheDir, keyRevision, onProgress }) {
  const dirs = [...new Set(files.map((f) => path.posix.dirname(f)))];
  const meta = new Map();
  for (const d of dirs) {
    const res = await fetch(`${HUB}/api/models/${model}/tree/${revision}${d === '.' ? '' : `/${d}`}`);
    if (!res.ok) throw new Error(`Couldn't look up ${model} (${res.status}).`);
    for (const f of await res.json()) meta.set(f.path, { size: f.lfs?.size ?? f.size, sha256: f.lfs?.oid ?? null });
  }
  for (const file of files) {
    const info = meta.get(file);
    if (!info) throw new Error(`${model} has no file ${file}.`);
    const dest = path.join(cacheDir, model, ...(keyRevision ? [revision] : []), ...file.split('/'));
    const marker = `${dest}.verified`;
    if (fs.existsSync(dest) && fs.statSync(dest).size === info.size && fs.existsSync(marker)) continue;
    if (fs.existsSync(dest)) fs.rmSync(dest); // a partial file left by an older download
    await download(`${HUB}/${model}/resolve/${revision}/${file}`, dest, { size: info.size, sha256: info.sha256, onProgress });
    fs.writeFileSync(marker, info.sha256 ?? String(info.size));
  }
}

const WHISPER_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];

export class VoiceEngine {
  constructor({ modelsDir, onProgress = () => {} }) {
    this.modelsDir = modelsDir;
    this.onProgress = onProgress;
    this.whisper = null;
    this.whisperDevice = null;
    this.kokoro = null;
    this.piper = new Map();
    this.phonemizer = null;
  }

  async transformers() {
    const t = await import('@huggingface/transformers');
    t.env.cacheDir = path.join(this.modelsDir, 'hf');
    t.env.allowLocalModels = false;
    return t;
  }

  // ---- hearing ----

  async loadWhisper() {
    if (this.whisper) return this.whisper;
    const t = await this.transformers();
    const fetchFiles = (onnx) =>
      ensureHubFiles({
        model: WHISPER.id,
        revision: WHISPER.revision,
        files: [...WHISPER_FILES, ...onnx.map((f) => `onnx/${f}`)],
        cacheDir: t.env.cacheDir,
        keyRevision: true,
        onProgress: (p) => this.onProgress({ kind: 'whisper', ...p }),
      });
    await fetchFiles(['encoder_model_fp16.onnx', 'decoder_model_merged_fp16.onnx']);
    const open = (device) =>
      t.pipeline('automatic-speech-recognition', WHISPER.id, {
        revision: WHISPER.revision,
        device,
        dtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
      });
    this.whisperT = t;
    if (!this.whisperCpuOnly) {
      try {
        // The encoder (the heavy part) on the GPU through DirectML. The fp16 decoder
        // returns no tokens on DirectML (onnxruntime 1.21), so it stays on the CPU.
        this.whisper = await open({ encoder_model: 'dml', decoder_model_merged: 'cpu' });
        this.whisperDevice = 'gpu';
        return this.whisper;
      } catch {}
    }
    this.whisper = await open('cpu');
    this.whisperDevice = 'cpu';
    return this.whisper;
  }

  // Whisper's own guess at the language from its first token, limited to English or
  // Urdu. Spoken Urdu often scores as Hindi, so Hindi counts as Urdu.
  async detectLanguage(asr, audio) {
    const t = this.whisperT;
    const id = (s) => asr.tokenizer.model.tokens_to_ids.get(s);
    const { input_features } = await asr.processor(audio);
    const { logits } = await asr.model({
      input_features,
      decoder_input_ids: new t.Tensor('int64', BigInt64Array.from([BigInt(id('<|startoftranscript|>'))]), [1, 1]),
    });
    const V = logits.dims.at(-1);
    const row = logits.data.subarray(logits.data.length - V);
    const urdu = Math.max(row[id('<|ur|>')], row[id('<|hi|>')]);
    return urdu > row[id('<|en|>')] ? 'urdu' : 'english';
  }

  // `audio` is 16 kHz mono Float32Array. `language` is 'english', 'urdu' or null (detect).
  // The quiet at both ends is cut first; a clip with no speech in it returns no text without running Whisper.
  async transcribe(input, { language = null, trim = true } = {}) {
    let audio = input;
    if (trim) {
      const t = trimSilence(input);
      if (t.speechSeconds < 0.15) return { text: '', language: language ?? 'english' };
      audio = t.audio;
    }
    try {
      const asr = await this.loadWhisper();
      const lang = language ?? (await this.detectLanguage(asr, audio));
      const out = await asr(audio, { task: 'transcribe', language: lang, chunk_length_s: 30, stride_length_s: 5 });
      const text = String(out?.text ?? '').trim();
      return { text, language: scriptLanguage(text) };
    } catch (e) {
      if (this.whisperDevice !== 'gpu') throw e;
      // A GPU driver that loads the model but can't run it: use the CPU from now on.
      await this.whisper.dispose?.();
      this.whisper = null;
      this.whisperCpuOnly = true;
      return this.transcribe(audio, { language, trim: false });
    }
  }

  // ---- speaking ----

  async loadKokoro() {
    if (this.kokoro) return this.kokoro;
    const t = await this.transformers();
    const { KokoroTTS } = await import('kokoro-js');
    // kokoro-js asks for the default branch, so the pinned files go where that request looks.
    await ensureHubFiles({
      model: KOKORO.id,
      revision: KOKORO.revision,
      files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
      cacheDir: t.env.cacheDir,
      keyRevision: false,
      onProgress: (p) => this.onProgress({ kind: 'kokoro', ...p }),
    });
    this.kokoro = await KokoroTTS.from_pretrained(KOKORO.id, { dtype: 'q8', device: 'cpu' });
    return this.kokoro;
  }

  async speakEnglish(text, voice = 'bm_george') {
    const tts = await this.loadKokoro();
    const out = await tts.generate(text, { voice: Object.hasOwn(ENGLISH_VOICES, voice) ? voice : 'bm_george' });
    return { audio: out.audio, sampleRate: out.sampling_rate };
  }

  async loadPiper(key) {
    const voice = URDU_VOICES[key] ?? URDU_VOICES.fasih;
    if (this.piper.has(voice.file)) return this.piper.get(voice.file);
    const dir = path.join(this.modelsDir, 'piper');
    const onnx = path.join(dir, `${path.basename(voice.file)}.onnx`);
    const json = `${onnx}.json`;
    const base = `${HUB}/rhasspy/piper-voices/resolve/${PIPER_REV}/${voice.file}`;
    if (!fs.existsSync(onnx) || (await sha256File(onnx)) !== voice.sha256) {
      fs.rmSync(onnx, { force: true });
      await download(`${base}.onnx`, onnx, { sha256: voice.sha256, onProgress: (p) => this.onProgress({ kind: 'piper', ...p }) });
    }
    if (!fs.existsSync(json)) await download(`${base}.onnx.json`, json);
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(onnx);
    const loaded = { session, config: JSON.parse(fs.readFileSync(json, 'utf8')), ort };
    this.piper.set(voice.file, loaded);
    return loaded;
  }

  // espeak-ng (compiled to WebAssembly) turns Urdu text into phonemes.
  async phonemes(text, espeakVoice) {
    const dir = path.dirname(require.resolve('@diffusionstudio/piper-wasm/build/piper_phonemize.js'));
    const create = require(path.join(dir, 'piper_phonemize.js'));
    const lines = [];
    const mod = await create({ print: (l) => lines.push(l), printErr: () => {}, locateFile: (f) => path.join(dir, f) });
    mod.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    return lines.map((l) => JSON.parse(l).phonemes ?? []).flat();
  }

  async speakUrdu(text, voiceKey = 'fasih') {
    const { session, config, ort } = await this.loadPiper(voiceKey);
    const ids = phonemeIds(await this.phonemes(text, config.espeak?.voice ?? 'ur'), config.phoneme_id_map);
    const inf = config.inference ?? {};
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8]), [3]),
    };
    const out = await session.run(feeds);
    return { audio: Float32Array.from(out[session.outputNames[0]].data), sampleRate: config.audio?.sample_rate ?? 22050 };
  }
}

// Piper's input: start marker, then each phoneme's ids followed by a pad, then the end marker.
export function phonemeIds(phonemes, map) {
  const pad = map._?.[0] ?? 0;
  const ids = [...(map['^'] ?? [1]), pad];
  for (const p of phonemes) {
    const hit = map[p];
    if (!hit) continue; // a phoneme this voice doesn't know is skipped, not guessed
    ids.push(...hit, pad);
  }
  ids.push(...(map.$ ?? [2]));
  return ids;
}

// Which language a piece of text is in, by counting words in each script, so an
// Urdu sentence with a few English words in it ("کل Zoom پر meeting ہے") stays Urdu.
export function scriptLanguage(text) {
  const words = String(text).split(/\s+/);
  const urdu = words.filter((w) => /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(w)).length;
  const latin = words.filter((w) => /[A-Za-z]/.test(w)).length;
  return urdu > latin ? 'urdu' : 'english';
}
