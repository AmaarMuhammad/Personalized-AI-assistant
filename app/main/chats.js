// Your past chats. New chat keeps the old conversation here instead of
// throwing it away, so you can read it again or continue it.
//
// The records Jarvis uses live in its protected data folder. A readable
// markdown copy of each chat also goes to your vault's Chats folder (for
// Obsidian or any editor); editing those copies changes nothing in Jarvis.
// The current chat's copy is rewritten after every message, so it survives a
// crash; New chat then keeps that same file rather than writing a second one.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SHOWN = new Set(['user', 'assistant', 'error', 'reminder', 'briefing', 'mail']);

export function chatTitle(items) {
  const first = items.find((i) => i.role === 'user')?.text ?? items.find((i) => i.role === 'briefing')?.text ?? 'Chat';
  const line = first.split('\n').find((l) => l.trim()) ?? 'Chat';
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}

// Safe as a Windows file name: no reserved characters, no trailing dots or spaces.
const fileSafe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').slice(0, 60) || 'Chat';

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};

const LANGUAGE = { english: 'English', urdu: 'Urdu' };
const tags = (i) => [i.via, LANGUAGE[i.lang]].filter(Boolean).map((t) => ` · ${t}`).join('');

export function chatMarkdown(rec) {
  const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const lines = [
    '---',
    `started: ${rec.started}`,
    `ended: ${rec.ended}`,
    `messages: ${rec.messages}`,
    'source: Jarvis (a copy; edits here change nothing in Jarvis)',
    '---',
    '',
    `# ${rec.title}`,
    '',
  ];
  for (const i of rec.items) {
    if (!SHOWN.has(i.role)) continue;
    if (i.role === 'user') lines.push(`**You** · ${time(i.ts)}${tags(i)}`, '', i.text, '');
    else if (i.role === 'assistant') lines.push(`**Jarvis** · ${time(i.ts)}${tags(i)}`, '', i.text, '');
    else lines.push(`> *${i.role === 'error' ? 'Problem' : i.role[0].toUpperCase() + i.role.slice(1)}: ${i.text.replace(/\n/g, ' ')}*`, '');
  }
  return lines.join('\n');
}

function summary(items) {
  const started = items[0]?.ts ?? new Date().toISOString();
  return {
    title: chatTitle(items),
    started,
    ended: items[items.length - 1]?.ts ?? started,
    messages: items.filter((i) => i.role === 'user' || i.role === 'assistant').length,
    items,
  };
}

export class ChatArchive {
  constructor({ dir, vaultDir = () => null, trash = async (file) => fs.rmSync(file, { force: true }) }) {
    this.dir = dir;
    this.vaultDir = vaultDir;
    this.trash = trash;
    this.indexFile = path.join(dir, 'index.json');
    this.live = null; // the current chat's vault copy
  }

  list() {
    try {
      const all = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }

  get(id) {
    if (!/^[a-z0-9-]{6,40}$/.test(String(id))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  // Rewrites the current chat's vault copy; called after every message.
  writeLive(items) {
    if (!items?.some((i) => i.role === 'user' || i.role === 'briefing')) {
      this.live = null; // archived or cleared: that file now belongs to the archive
      return null;
    }
    const rec = summary(items);
    const file = this.markdownPath(rec);
    if (!file) return null;
    try {
      if (this.live && this.live !== file) fs.rmSync(this.live, { force: true }); // the title or vault folder changed
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, chatMarkdown(rec), 'utf8');
      this.live = file;
      return file;
    } catch {
      return null; // the vault copy is a convenience; chat.json has the chat either way
    }
  }

  // Keeps the chat. Returns the record, or null when there was nothing to keep.
  archive({ items, sessionId = null }) {
    if (!items?.some((i) => i.role === 'user' || i.role === 'briefing')) return null;
    const rec = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      ...summary(items),
      sessionId,
      items,
    };
    rec.markdown = this.writeMarkdown(rec, this.live);
    this.live = null;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${rec.id}.json`), JSON.stringify(rec), 'utf8');
    const { items: _items, ...meta } = rec;
    this.saveIndex([meta, ...this.list()]);
    return rec;
  }

  // Takes a chat out of the archive (when you continue it, it becomes the current chat again).
  remove(id) {
    const rec = this.get(id);
    if (!rec) return null;
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    if (rec.markdown) fs.rmSync(rec.markdown, { force: true });
    this.saveIndex(this.list().filter((m) => m.id !== id));
    return rec;
  }

  // Deletes a chat for good. Its vault copy goes to the Recycle Bin, in case you change your mind.
  async delete(id) {
    const rec = this.get(id);
    if (!rec) return false;
    if (rec.markdown && fs.existsSync(rec.markdown)) {
      try {
        await this.trash(rec.markdown);
      } catch {
        /* a vault copy that can't be moved is left where it is */
      }
    }
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    this.saveIndex(this.list().filter((m) => m.id !== id));
    return true;
  }

  // Gives a chat a name of your choosing; the vault copy is renamed to match.
  rename(id, title) {
    const rec = this.get(id);
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!rec || !clean) return null;
    if (rec.markdown) fs.rmSync(rec.markdown, { force: true });
    rec.title = clean;
    rec.markdown = this.writeMarkdown(rec);
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(rec), 'utf8');
    this.saveIndex(this.list().map((m) => (m.id === id ? { ...m, title: clean, markdown: rec.markdown } : m)));
    return rec;
  }

  markdownPath(rec) {
    const vault = this.vaultDir();
    return vault ? path.join(vault, 'Chats', `${stamp(new Date(rec.started))} ${fileSafe(rec.title)}.md`) : null;
  }

  // `reuse` is the live copy of this same chat, which is overwritten rather than duplicated.
  writeMarkdown(rec, reuse = null) {
    let file = this.markdownPath(rec);
    if (!file) return null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (reuse && reuse !== file) fs.rmSync(reuse, { force: true });
      if (file !== reuse && fs.existsSync(file)) file = file.replace(/\.md$/, ` (${rec.id}).md`);
      fs.writeFileSync(file, chatMarkdown(rec), 'utf8');
      return file;
    } catch {
      return null; // the vault copy is a convenience; the chat is kept either way
    }
  }

  saveIndex(list) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
    fs.renameSync(tmp, this.indexFile);
  }
}
