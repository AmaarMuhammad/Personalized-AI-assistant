// Talks to the voice process (app/voice/worker.js): starts it on first use,
// sends it audio to transcribe and text to speak, and relays download progress.
import { EventEmitter } from 'node:events';

export class VoiceService extends EventEmitter {
  constructor({ fork, workerPath, modelsDir }) {
    super();
    Object.assign(this, { fork, workerPath, modelsDir });
    this.child = null;
    this.pending = new Map();
    this.nextId = 0;
  }

  ensure() {
    if (this.child) return this.child;
    const child = this.fork(this.workerPath, [this.modelsDir], { serviceName: 'Jarvis voice' });
    child.on('message', (msg) => {
      if (msg?.type === 'progress') return this.emit('progress', msg);
      const p = this.pending.get(msg?.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.type === 'error' ? p.reject(new Error(msg.message)) : p.resolve(msg.result);
    });
    child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('The voice engine stopped.'));
      this.pending.clear();
      this.child = null;
    });
    this.child = child;
    return child;
  }

  call(op, args) {
    const child = this.ensure();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ id, op, args });
    });
  }

  transcribe(audio, language = null) {
    return this.call('transcribe', { audio, language });
  }

  speak(text, language, voices = {}) {
    return this.call('speak', { text, language, ...voices });
  }

  prepare(voices = {}) {
    return this.call('prepare', voices);
  }

  stop() {
    this.child?.kill();
    this.child = null;
  }
}
