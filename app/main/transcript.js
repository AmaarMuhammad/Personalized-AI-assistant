// The visible chat history, so the conversation is still there after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MAX = 500;

export class Transcript extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    try {
      this.items = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.items)) this.items = [];
    } catch {
      this.items = [];
    }
  }

  // `meta` tags a message: how it came in (via: typed | voice) and its language.
  add(role, text, meta = {}) {
    this.items.push({ role, text: String(text ?? ''), ts: new Date().toISOString(), ...meta });
    if (this.items.length > MAX) this.items = this.items.slice(-MAX);
    this.save();
  }

  all() {
    return this.items;
  }

  clear() {
    this.items = [];
    this.save();
  }

  replace(items) {
    this.items = Array.isArray(items) ? items.slice(-MAX) : [];
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.items), 'utf8');
    this.emit('change', this.items);
  }
}
