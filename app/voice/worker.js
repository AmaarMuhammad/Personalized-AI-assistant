// The voice process. Electron starts it with utilityProcess, so speech models
// load and run here without ever blocking the window or the brain.
import { VoiceEngine } from './engine.js';

const port = process.parentPort;
const engine = new VoiceEngine({
  modelsDir: process.argv[2],
  onProgress: (p) => port.postMessage({ type: 'progress', ...p }),
});

let queue = Promise.resolve();

port.on('message', ({ data }) => {
  const { id, op, args = {} } = data ?? {};
  queue = queue.then(async () => {
    try {
      let result;
      if (op === 'transcribe') result = await engine.transcribe(Float32Array.from(args.audio ?? []), { language: args.language ?? null });
      else if (op === 'speak') {
        result = args.language === 'urdu' ? await engine.speakUrdu(args.text, args.urduVoice) : await engine.speakEnglish(args.text, args.englishVoice);
      } else if (op === 'prepare') {
        await engine.loadWhisper();
        await engine.loadKokoro();
        await engine.loadPiper(args.urduVoice);
        result = { device: engine.whisperDevice };
      } else throw new Error(`unknown voice operation: ${op}`);
      port.postMessage({ type: 'result', id, result });
    } catch (e) {
      port.postMessage({ type: 'error', id, message: String(e?.message ?? e) });
    }
  });
});
