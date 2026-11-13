// A permanent record of everything Jarvis did or tried to do, and why.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export class ActivityLog extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  add(entry) {
    const row = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    this.emit('entry', row);
    return row;
  }

  // Newest first.
  recent(limit = 200) {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const lines = text.trim().split('\n').filter(Boolean);
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
      try {
        rows.push(JSON.parse(lines[i]));
      } catch {
        /* a half-written line from a crash; skip it */
      }
    }
    return rows;
  }
}
