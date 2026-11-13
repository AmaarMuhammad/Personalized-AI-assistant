// The Memory page's data: Hermes's own memory files, read and edited in place.
//
//   USER.md    who you are          -> section "About you"
//   MEMORY.md  Hermes's own notes   -> section "Hermes notes"
//
// Entries in each file are separated by a line with "§". Hermes (not Jarvis) decides what to
// learn; with memory.write_approval on it asks first, and that ask arrives as a normal
// approval card. This page is for reading and correcting what is there. Before the first
// change each day the previous contents are kept in memory-history\ for 30 days.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const STORES = [
  { section: 'About you', file: 'USER.md', limit: 1375 },
  { section: 'Hermes notes', file: 'MEMORY.md', limit: 2200 },
];
export const SECTIONS = STORES.map((s) => s.section);
const SEP = '§';
const KEEP_DAYS = 30;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clean = (s) => String(s ?? '').replace(/\r/g, '').replace(/\s*§\s*/g, ' ').trim().slice(0, 1000);
const idOf = (section, text) => crypto.createHash('sha1').update(`${section}\n${text}`).digest('hex').slice(0, 10);

export const parseEntries = (raw) => String(raw ?? '').replace(/\r/g, '').split(/^\s*§\s*$/m).map((s) => s.trim()).filter(Boolean);
export const joinEntries = (entries) => entries.join(`\n${SEP}\n`);

export class HermesMemory extends EventEmitter {
  constructor(dir, historyDir) {
    super();
    this.dir = dir;
    this.historyDir = historyDir;
  }

  store(section) {
    const s = STORES.find((x) => x.section === section);
    if (!s) throw new Error('Unknown memory section.');
    return s;
  }

  readStore(s) {
    try {
      return parseEntries(fs.readFileSync(path.join(this.dir, s.file), 'utf8'));
    } catch {
      return [];
    }
  }

  facts() {
    return STORES.flatMap((s) => this.readStore(s).map((text) => ({ id: idOf(s.section, text), section: s.section, text, source: 'earlier', date: '', quote: '' })));
  }

  // Everything as plain markdown, for the "edit as text" box and the vault copy.
  read() {
    return STORES.map((s) => `# ${s.section}\n${this.readStore(s).map((t) => `- ${t.replace(/\n+/g, ' ')}`).join('\n')}`).join('\n\n') + '\n';
  }

  snapshot() {
    if (!this.historyDir) return;
    fs.mkdirSync(this.historyDir, { recursive: true });
    const now = new Date();
    const file = path.join(this.historyDir, `${dayKey(now)}.json`);
    if (!fs.existsSync(file)) {
      const stores = Object.fromEntries(STORES.map((s) => [s.section, this.readStore(s)]));
      fs.writeFileSync(file, JSON.stringify({ stores }), 'utf8');
    }
    const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    for (const f of fs.readdirSync(this.historyDir)) if (DAY_FILE.test(f) && f.slice(0, 10) < cutoff) fs.rmSync(path.join(this.historyDir, f), { force: true });
  }

  writeStore(s, entries) {
    const body = joinEntries(entries);
    if (body.length > s.limit) throw new Error(`"${s.section}" is limited to ${s.limit} characters (this would be ${body.length}). Shorten or delete something first.`);
    this.snapshot();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, s.file), body, 'utf8');
    this.emit('change');
  }

  add({ section, text }) {
    const s = this.store(section);
    const t = clean(text);
    if (!t) return null;
    const entries = this.readStore(s);
    if (entries.includes(t)) return null;
    this.writeStore(s, [...entries, t]);
    return { id: idOf(s.section, t), section: s.section, text: t };
  }

  update(id, { text }) {
    for (const s of STORES) {
      const entries = this.readStore(s);
      const i = entries.findIndex((e) => idOf(s.section, e) === id);
      if (i < 0) continue;
      const t = clean(text);
      if (!t) return false;
      entries[i] = t;
      this.writeStore(s, entries);
      return true;
    }
    return false;
  }

  remove(id) {
    for (const s of STORES) {
      const entries = this.readStore(s);
      const i = entries.findIndex((e) => idOf(s.section, e) === id);
      if (i < 0) continue;
      entries.splice(i, 1);
      this.writeStore(s, entries);
      return true;
    }
    return false;
  }

  // "Edit as text": "# Section" headings with "- entry" lines. Unknown headings are ignored.
  write(text) {
    const parsed = new Map();
    let cur = null;
    for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
      const h = /^#\s+(.+?)\s*$/.exec(line);
      if (h) {
        cur = SECTIONS.includes(h[1]) ? h[1] : null;
        if (cur && !parsed.has(cur)) parsed.set(cur, []);
        continue;
      }
      const b = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (cur && b) parsed.get(cur).push(clean(b[1]));
    }
    for (const s of STORES) if (parsed.has(s.section)) this.writeStore(s, parsed.get(s.section).filter(Boolean));
  }

  history() {
    if (!this.historyDir) return [];
    try {
      return fs.readdirSync(this.historyDir).filter((f) => DAY_FILE.test(f)).sort().reverse().map((f) => {
        const { stores = {} } = JSON.parse(fs.readFileSync(path.join(this.historyDir, f), 'utf8'));
        return { day: f.slice(0, 10), count: Object.values(stores).reduce((n, a) => n + a.length, 0) };
      });
    } catch {
      return [];
    }
  }

  restore(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return false;
    try {
      const { stores } = JSON.parse(fs.readFileSync(path.join(this.historyDir, `${day}.json`), 'utf8'));
      for (const s of STORES) if (Array.isArray(stores?.[s.section])) this.writeStore(s, stores[s.section].map(String));
      return true;
    } catch {
      return false;
    }
  }
}
