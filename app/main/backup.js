// Backups of what you'd lose with this PC: chats, settings, the activity log, and the brain's
// own files (Hermes's memory, personality, settings and scheduled jobs). One JSON file per
// backup, so it can be copied anywhere and restored on another PC. Not included: sign-ins and
// keys (Credential Manager, Hermes's .env) and the speech models (they download again).
import fs from 'node:fs';
import path from 'node:path';

const FORMAT = 'jarvis-backup';
const FILES = ['settings.json', 'activity.jsonl', 'chat.json', 'hermes-session.json'];
// Names older backups carry (the app before Hermes). Accepted, removed on restore, never written back.
const LEGACY = ['memory.md', 'memory.json', 'review-state.json', 'reminders.json', 'proposals.json', 'briefing.json', 'session.json', 'exposure.json'];
// Hermes's files, by exact name. Memory is restored in place; the rest is set aside for you to copy
// back by hand, because overwriting a running Hermes's settings is not something a restore should do.
const HERMES_MEMORY = ['hermes/memories/USER.md', 'hermes/memories/MEMORY.md'];
const HERMES_OTHER = ['hermes/SOUL.md', 'hermes/config.yaml', 'hermes/cron/jobs.json'];
const KNOWN = new Set([...FILES, ...LEGACY, ...HERMES_MEMORY, ...HERMES_OTHER]);
const CHAT = /^chats\/[A-Za-z0-9_-]+\.json$/;
const NAME = /^Jarvis backup \d{4}-\d{2}-\d{2} \d{6}\.json$/;
const MAX_BYTES = 500 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export function collect(dataDir, now = new Date(), hermesHome = null) {
  const files = {};
  for (const f of hermesHome ? [...HERMES_MEMORY, ...HERMES_OTHER] : []) {
    try {
      files[f] = fs.readFileSync(path.join(hermesHome, f.slice('hermes/'.length)), 'utf8');
    } catch {
      /* not there */
    }
  }
  for (const f of FILES) {
    try {
      files[f] = fs.readFileSync(path.join(dataDir, f), 'utf8');
    } catch {
      /* not created yet */
    }
  }
  let chats = [];
  try {
    chats = fs.readdirSync(path.join(dataDir, 'chats'));
  } catch {
    /* no chats yet */
  }
  for (const f of chats) {
    if (CHAT.test(`chats/${f}`)) files[`chats/${f}`] = fs.readFileSync(path.join(dataDir, 'chats', f), 'utf8');
  }
  return { format: FORMAT, version: 1, created: now.toISOString(), files };
}

export function writeBackup(dataDir, folder, now = new Date(), hermesHome = null) {
  fs.mkdirSync(folder, { recursive: true });
  let file = path.join(folder, `Jarvis backup ${stamp(now)}.json`);
  for (let s = 1; fs.existsSync(file); s++) file = path.join(folder, `Jarvis backup ${stamp(new Date(now.getTime() + s * 1000))}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(collect(dataDir, now, hermesHome)), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// Only Jarvis's own files, by exact name, ever come out of a backup.
export function readBackup(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('That file is too big to be a Jarvis backup.');
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error("That file isn't a Jarvis backup.");
  }
  if (b?.format !== FORMAT || b.version !== 1 || typeof b.files !== 'object' || !b.files) throw new Error("That file isn't a Jarvis backup.");
  for (const [name, text] of Object.entries(b.files)) {
    if (!(KNOWN.has(name) || CHAT.test(name)) || typeof text !== 'string') throw new Error('That backup has something in it Jarvis doesn’t recognise, so it wasn’t used.');
  }
  return { created: String(b.created ?? ''), files: b.files, chats: Object.keys(b.files).filter((n) => CHAT.test(n) && n !== 'chats/index.json').length };
}

// Replaces Jarvis's data with the backup's. Call only while nothing else writes, then restart.
export function restoreBackup(dataDir, backup, hermesHome = null) {
  const write = (rel, text) => {
    const dest = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.tmp`, text, 'utf8');
    fs.renameSync(`${dest}.tmp`, dest);
  };
  for (const f of FILES) {
    if (Object.hasOwn(backup.files, f)) write(f, backup.files[f]);
    else fs.rmSync(path.join(dataDir, f), { force: true });
  }
  for (const f of LEGACY) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.rmSync(path.join(dataDir, 'hermes-restore'), { recursive: true, force: true });
  for (const f of HERMES_OTHER) if (Object.hasOwn(backup.files, f)) write(path.join('hermes-restore', f.slice('hermes/'.length)), backup.files[f]);
  if (hermesHome) {
    for (const f of HERMES_MEMORY) {
      if (!Object.hasOwn(backup.files, f)) continue;
      const dest = path.join(hermesHome, f.slice('hermes/'.length));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.tmp`, backup.files[f], 'utf8');
      fs.renameSync(`${dest}.tmp`, dest);
    }
  }
  fs.rmSync(path.join(dataDir, 'chats'), { recursive: true, force: true });
  for (const [name, text] of Object.entries(backup.files)) if (CHAT.test(name)) write(name, text);
}

export function listBackups(folder) {
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((n) => NAME.test(n));
  } catch {
    return [];
  }
  return names.sort().reverse().map((n) => path.join(folder, n));
}

export function prune(folder, keep = 10) {
  for (const f of listBackups(folder).slice(keep)) fs.rmSync(f, { force: true });
}

// One backup a day while Jarvis runs (or soon after it starts, if a day has passed).
export class AutoBackup {
  constructor({ dataDir, settings, hermesHome = null, now = () => new Date(), firstDelayMs = 60_000, everyMs = 60 * 60 * 1000 }) {
    Object.assign(this, { dataDir, settings, hermesHome, now, firstDelayMs, everyMs });
    this.lastError = '';
  }

  start() {
    this.first = setTimeout(() => this.tick(), this.firstDelayMs);
    this.timer = setInterval(() => this.tick(), this.everyMs);
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  tick() {
    const s = this.settings.get();
    if (!s.autoBackup || !s.backupFolder) return null;
    const newest = listBackups(s.backupFolder)[0];
    if (newest && this.now() - fs.statSync(newest).mtime < DAY) return null;
    try {
      const file = writeBackup(this.dataDir, s.backupFolder, this.now(), this.hermesHome);
      prune(s.backupFolder);
      this.lastError = '';
      return file;
    } catch (e) {
      this.lastError = e.message;
      return null;
    }
  }
}
