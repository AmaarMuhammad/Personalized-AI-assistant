// Your settings, saved in Jarvis's data folder.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ENGLISH_VOICES, URDU_VOICES } from '../voice/engine.js';

// `folders` are the real locations Windows reports (Desktop, Documents and Pictures are often moved into OneDrive).
export function defaultSettings(home, P = path, folders = null) {
  return {
    assistantName: 'Jarvis',
    userName: '',
    workspace: P.join(home, 'Jarvis Workspace'),
    hotkey: 'Control+Space',
    startAtLogin: true,
    theme: 'system', // system | light | dark
    // A readable markdown copy of your memory and past chats (e.g. for Obsidian).
    vaultFolder: P.join(home, 'Jarvis Workspace', 'Vault'),
    // Voice: press the shortcut, speak, and Jarvis answers out loud.
    voiceHotkey: 'Control+Alt+Space',
    speakReplies: true,
    keepListening: false, // conversation mode: after a spoken reply, listen again for your answer
    speakApprovals: true, // say out loud what Jarvis needs your OK for, and why
    voiceLanguage: 'auto', // auto | english | urdu
    englishVoice: 'bm_george',
    urduVoice: 'fasih',
    // A daily copy of memory, chats and settings; somewhere that syncs (OneDrive) survives this PC.
    autoBackup: true,
    backupFolder: P.join(folders ? folders.documents : P.join(home, 'Documents'), 'Jarvis Backups'),
  };
}

export class Settings extends EventEmitter {
  constructor(file, defaults) {
    super();
    this.file = file;
    this.defaults = defaults;
    this.value = { ...defaults };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.value = { ...defaults, ...sanitize(saved, defaults) };
    } catch {
      /* first run */
    }
  }

  get() {
    return this.value;
  }

  update(patch) {
    this.value = { ...this.value, ...sanitize(patch, this.defaults) };
    this.save();
    this.emit('change', this.value);
    return this.value;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

// Only known keys with the right types get through, whatever the UI sends.
function sanitize(patch, defaults) {
  const out = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in defaults)) continue;
    if (k === 'theme') {
      if (['system', 'light', 'dark'].includes(v)) out[k] = v;
    } else if (k === 'voiceLanguage') {
      if (['auto', 'english', 'urdu'].includes(v)) out[k] = v;
    } else if (k === 'englishVoice') {
      if (Object.hasOwn(ENGLISH_VOICES, v)) out[k] = v;
    } else if (k === 'urduVoice') {
      if (Object.hasOwn(URDU_VOICES, v)) out[k] = v;
    } else if (typeof v === typeof defaults[k]) {
      out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
    }
  }
  return out;
}
