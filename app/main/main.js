// Jarvis desktop app: window, tray, hotkey, and the wiring between the
// interface and the brain. There is no web server: the window talks to the
// brain only through Electron's private IPC channel.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, Notification, nativeImage, session, dialog, utilityProcess, nativeTheme } from 'electron';
import keyring from '@napi-rs/keyring';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Settings, defaultSettings } from './settings.js';
import { Approvals } from './approvals.js';
import { ActivityLog } from './activity-log.js';
import { HermesMemory } from './hermes-memory.js';
import { PendingMemory } from './pending-memory.js';
import { HermesBrain } from './hermes-brain.js';
import { Transcript } from './transcript.js';
import { GoogleAuth, keyringStore, memoryStore } from './google-auth.js';
import { googleClient } from '../tools/google-tools.js';
import { ChatArchive } from './chats.js';
import { VoiceService } from './voice.js';
import { SentenceSplitter, isNoiseTranscript, utterance } from './speech.js';
import { scriptLanguage } from '../voice/engine.js';
import { Dashboard } from './dashboard.js';
import { checkHealth, problems } from './health.js';
import { AutoBackup, writeBackup, readBackup, restoreBackup, prune } from './backup.js';

// Debug only (JARVIS_VOICE_DEBUG=1): keep each recording as a 16 kHz WAV beside its transcript,
// so a mishearing can be replayed and a fix tested against your real voice. Stays on this PC.
function saveVoiceDebug(audio, res, lang) {
  try {
    const dir = process.env.JARVIS_VOICE_DEBUG_DIR || path.join(app.getPath('userData'), 'voice-debug');
    fs.mkdirSync(dir, { recursive: true });
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const pcm = Buffer.alloc(audio.length * 2);
    for (let i = 0; i < audio.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(path.join(dir, `${id}.wav`), Buffer.concat([h, pcm]));
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ text: res?.text, language: res?.language, setting: lang }));
  } catch { /* debug only */ }
}


const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(here, '..', 'ui');
const UI_URL = pathToFileURL(path.join(UI_DIR, 'index.html')).href;
const ICON = path.join(here, '..', 'assets', 'icon.png');
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('Jarvis.Assistant');
  app.whenReady().then(boot);
}

let win = null;
let tray = null;
let quitting = false;

function boot() {
  const home = os.homedir();
  const dataDir = app.getPath('userData');
  const folders = Object.fromEntries(['documents', 'desktop', 'downloads', 'pictures'].map((k) => [k, app.getPath(k)]));
  const settings = new Settings(path.join(dataDir, 'settings.json'), defaultSettings(home, path, folders));

  const approvals = new Approvals();
  const log = new ActivityLog(path.join(dataDir, 'activity.jsonl'));
  // Hermes owns memory; this page reads and edits its files in place.
  const hermesHome = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
  const memory = new HermesMemory(path.join(hermesHome, 'memories'), path.join(dataDir, 'memory-history'));
  // Memory writes Hermes staged for approval (memory.write_approval). Approving one changes memory.
  const pendingMemory = new PendingMemory({ hermesHome, installDir: process.env.JARVIS_HERMES_INSTALL || hermesHome });
  pendingMemory.on('change', ({ verb }) => {
    if (verb === 'approve') memory.emit('change');
  });
  const transcript = new Transcript(path.join(dataDir, 'chat.json'));
  const notify = (title, body) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(title).slice(0, 100), body: String(body ?? '').slice(0, 400) });
    n.on('click', () => showWindow());
    n.show();
  };
  // Only the automated test harness sets these, from inside this same process.
  const testHermes = globalThis.__JARVIS_TEST_HERMES__;
  const testing = !!testHermes;
  const googleAuth = new GoogleAuth({
    // The automated tests never touch your real Credential Manager.
    store: testing ? memoryStore() : keyringStore(keyring.Entry),
    openExternal: (url) => shell.openExternal(url),
  });
  // Phase 7: Hermes (local API server) is the brain. Its key is in Credential Manager (Jarvis / hermes-api).
  const brain = new HermesBrain({
    settings, approvals, dataDir, log,
    getKey: () => (testHermes ? 'test-key' : new keyring.Entry('Jarvis', 'hermes-api').getPassword()),
    ...(testHermes ? { fetchFn: testHermes } : {}),
  });

  // ---- past chats and suggested memories ----
  const chats = new ChatArchive({ dir: path.join(dataDir, 'chats'), vaultDir: () => settings.get().vaultFolder, trash: (f) => shell.trashItem(f) });
  transcript.on('change', (items) => chats.writeLive(items));
  chats.writeLive(transcript.all());
  const writeVaultMemory = () => {
    try {
      const dir = settings.get().vaultFolder;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'Memory.md'),
        `<!-- A copy of what Jarvis remembers. Edit it in Jarvis (Memory page); changes here are overwritten. -->\n${memory.read()}`,
        'utf8',
      );
    } catch {
      /* the vault copy is a convenience */
    }
  };
  memory.on('change', writeVaultMemory);
  writeVaultMemory();

  // Ends the current chat and keeps it in the archive (if it has anything in it).
  // The session id is read before the reset clears it.
  const endCurrentChat = async () => {
    const sessionId = brain.savedSessionId();
    await brain.reset();
    const rec = chats.archive({ items: transcript.all(), sessionId });
    transcript.clear();
    return rec;
  };

  const emit = (type, data) => win?.webContents.send('jarvis:event', { type, data });

  // ---- voice ----
  const voice = globalThis.__JARVIS_TEST_VOICE__ ?? new VoiceService({
    fork: (...a) => utilityProcess.fork(...a),
    workerPath: path.join(here, '..', 'voice', 'worker.js'),
    modelsDir: path.join(dataDir, 'models'),
  });
  voice.on('progress', (p) => emit('voice-progress', p));
  const voices = () => ({ englishVoice: settings.get().englishVoice, urduVoice: settings.get().urduVoice });
  const voiceReady = () => {
    if (globalThis.__JARVIS_TEST_VOICE__) return true;
    try {
      return fs.readdirSync(path.join(dataDir, 'models')).length > 0;
    } catch {
      return false;
    }
  };
  // `gen` changes whenever speech is stopped, so audio still being made for an old reply is dropped.
  const speech = { gen: 0, splitter: null, chain: Promise.resolve(), spokenTurn: false };
  const say = (sentence) => {
    const u = utterance(sentence);
    if (!u) return;
    const gen = speech.gen;
    speech.chain = speech.chain.then(async () => {
      if (gen !== speech.gen) return;
      try {
        const r = await voice.speak(u.text, u.language, voices());
        if (gen === speech.gen) emit('voice-audio', { gen, audio: r.audio, sampleRate: r.sampleRate, text: u.text });
      } catch (e) {
        if (gen === speech.gen) emit('voice-error', `Couldn't speak: ${e.message}`);
      }
    });
  };
  const stopSpeaking = () => {
    speech.gen++;
    speech.splitter = null;
    emit('voice-stop', { gen: speech.gen });
  };

  // ---- brain → window ----
  let reply = '';
  brain.on('busy', () => {
    reply = '';
    emit('busy');
  });
  brain.on('text', (t) => {
    reply += t;
    emit('text', t);
    if (speech.splitter) for (const s of speech.splitter.push(t)) say(s);
  });
  brain.on('working', (name) => emit('working', name));
  // Say so, once, when Claude stops answering and the local model takes over (and when Claude is back).
  let onFallback = false;
  brain.on('done', ({ text, runtime }) => {
    transcript.add('assistant', reply || text, { lang: scriptLanguage(reply || text) });
    emit('done', { text: reply || text, runtime: runtime ?? null });
    if (runtime && runtime.fallback !== onFallback) {
      onFallback = runtime.fallback;
      const note = onFallback
        ? `Claude wasn't available, so the local model (${runtime.model || runtime.provider}) answered. It is weaker: double-check anything important.`
        : 'Claude is answering again.';
      emit('model-note', { text: note, fallback: onFallback });
      if (speech.splitter) say(note);
      if (onFallback) notify(`${settings.get().assistantName} is on the local model`, 'Claude is not available. Check the Claude sign-in that Hermes uses.');
    }
    if (speech.splitter) {
      for (const s of reply ? speech.splitter.flush() : [text]) say(s);
      speech.splitter = null;
    }
    // Tells the window the spoken reply has been handed over in full, so conversation mode can listen again.
    if (speech.spokenTurn) {
      const gen = speech.gen;
      speech.chain = speech.chain.then(() => {
        if (gen === speech.gen) emit('voice-done', { gen });
      });
    }
  });
  brain.on('error', (e) => {
    transcript.add('error', e.message);
    emit('error', e);
  });
  brain.on('usage', (u) => emit('usage', u));
  brain.on('idle', () => {
    speech.splitter = null;
    speech.spokenTurn = false;
    emit('idle');
  });
  approvals.on('request', (card) => {
    emit('approval', card);
    // Spoken whether you typed or talked, once the speech models are on this PC (never starts a download).
    if (settings.get().speakApprovals && card.spoken && voiceReady()) say(card.spoken);
    if (!win?.isFocused()) notify(`${settings.get().assistantName} needs your OK`, card.summary);
  });
  approvals.on('settled', (s) => emit('approval-settled', s));
  log.on('entry', (row) => emit('activity', row));

  // ---- email and calendar ----
  googleAuth.on('change', (st) => emit('google', st));

  const testGoogle = globalThis.__JARVIS_TEST_GOOGLE__;
  const dashboard = new Dashboard({
    connected: testGoogle ? () => true : () => googleAuth.status().connected,
    call: testGoogle ?? googleClient({ auth: googleAuth }),
  });

  const autoBackup = new AutoBackup({ dataDir, settings, hermesHome });
  autoBackup.start();

  // ---- health: say so when something the assistant depends on is broken ----
  let health = [];
  let told = new Set();
  const runHealth = async () => {
    if (testing) return health;
    try {
      health = await checkHealth({ hermesHome, repoDir: path.join(here, '..', '..'), googleConnected: () => googleAuth.status().connected });
    } catch {
      return health;
    }
    const bad = problems(health);
    emit('health', health);
    for (const p of bad) if (!told.has(p.id)) notify(`${settings.get().assistantName}: something needs fixing`, p.message);
    told = new Set(bad.map((p) => p.id));
    return health;
  };
  const healthFirst = setTimeout(runHealth, 45_000);
  const healthTimer = setInterval(runHealth, 30 * 60_000);
  healthFirst.unref?.();
  healthTimer.unref?.();

  nativeTheme.themeSource = settings.get().theme;
  settings.on('change', (s) => {
    nativeTheme.themeSource = s.theme;
    fs.mkdirSync(s.workspace, { recursive: true });
    applyLoginItem(s.startAtLogin);
    registerHotkey(s.hotkey);
    registerVoiceHotkey(s.voiceHotkey);
  });

  // ---- window → brain (every handler checks the message came from our own page) ----
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (event.senderFrame?.url !== UI_URL) throw new Error('blocked');
      return fn(...args);
    });

  handle('chat:send', async (text, opts) => {
    const clean = String(text ?? '').slice(0, 20_000).trim();
    if (!clean) return false;
    const spoken = opts?.spoken === true;
    if (brain.busy) return false;
    stopSpeaking();
    if (spoken && settings.get().speakReplies) speech.splitter = new SentenceSplitter();
    speech.spokenTurn = spoken;
    const accepted = await brain.send(clean, { spoken });
    if (accepted) transcript.add('user', clean, { via: spoken ? 'voice' : 'typed', lang: scriptLanguage(clean) });
    else {
      speech.splitter = null;
      speech.spokenTurn = false;
    }
    return accepted;
  });
  handle('voice:transcribe', async (audio) => {
    // 16 kHz mono from the microphone; at most two minutes.
    if (!(audio instanceof Float32Array) || audio.length < 1600 || audio.length > 16_000 * 120) return { text: '' };
    const lang = settings.get().voiceLanguage;
    try {
      const res = await voice.transcribe(audio, lang === 'auto' ? null : lang);
      if (process.env.JARVIS_VOICE_DEBUG) saveVoiceDebug(audio, res, lang);
      return isNoiseTranscript(res?.text) ? { ...res, text: '' } : res;
    } catch (e) {
      return { text: '', error: e.message };
    }
  });
  handle('voice:stop', () => stopSpeaking());
  handle('voice:prepare', async () => {
    try {
      return await voice.prepare(voices());
    } catch (e) {
      return { error: e.message };
    }
  });
  handle('voice:test', async () => {
    stopSpeaking();
    say(settings.get().voiceLanguage === 'urdu' ? 'السلام علیکم، میں آپ کا اسسٹنٹ ہوں۔' : `Hello, I'm ${settings.get().assistantName}. This is how I sound.`);
    return true;
  });
  handle('chat:stop', () => brain.interrupt());
  handle('chat:new', async () => {
    await endCurrentChat();
    return true;
  });
  handle('chats:list', () => chats.list());
  handle('chats:get', (id) => chats.get(String(id)));
  handle('chats:delete', (id) => chats.delete(String(id)));
  handle('chats:rename', (id, title) => chats.rename(String(id), String(title ?? ''))?.title ?? null);
  handle('chats:continue', async (id) => {
    const rec = chats.get(String(id));
    if (!rec?.sessionId || brain.busy) return false;
    await endCurrentChat();
    chats.remove(rec.id);
    brain.resumeChat(rec.sessionId);
    transcript.replace(rec.items);
    return true;
  });
  handle('memory:facts', () => memory.facts());
  handle('memory:add', (section, text) => memory.add({ section: String(section), text: String(text ?? '') }));
  handle('memory:update', (id, text, section) => memory.update(String(id), { text: String(text ?? '') }));
  handle('memory:remove', (id) => memory.remove(String(id)));
  handle('memory:history', () => memory.history());
  handle('memory:restore', (day) => memory.restore(String(day)));
  handle('memory:pending', () => pendingMemory.list());
  handle('memory:approvePending', async (id) => {
    const r = await pendingMemory.approve(String(id ?? ''));
    if (r.ok) log.add({ tool: 'memory_approve', summary: `Approved staged memory write ${String(id)}`, decision: 'allow', by: 'you', via: 'memory page' });
    return r;
  });
  handle('memory:rejectPending', async (id) => {
    const r = await pendingMemory.reject(String(id ?? ''));
    if (r.ok) log.add({ tool: 'memory_reject', summary: `Rejected staged memory write ${String(id)}`, decision: 'deny', by: 'you', via: 'memory page' });
    return r;
  });
  handle('chat:history', () => transcript.all());
  handle('approval:answer', (id, choice) => approvals.answer(String(id), String(choice)));
  handle('approval:list', () => approvals.list());
  handle('activity:list', () => log.recent(300));
  handle('memory:get', () => memory.read());
  handle('memory:set', (text) => {
    memory.write(String(text ?? ''));
    return true;
  });
  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => settings.update(patch ?? {}));
  handle('app:openLink', (url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
    } catch {
      /* not a link */
    }
  });
  handle('app:openFolder', (which) => {
    const s = settings.get();
    const target = which === 'data' ? dataDir : which === 'vault' ? s.vaultFolder : which === 'backups' ? s.backupFolder : s.workspace;
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });
  handle('app:status', () => ({
    hotkey: settings.get().hotkey,
    name: settings.get().assistantName,
    version: app.getVersion(),
  }));
  handle('health:get', () => runHealth());
  handle('google:status', () => googleAuth.status());
  handle('google:chooseClient', async () => {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose the Google client file you downloaded',
      properties: ['openFile'],
      filters: [{ name: 'Google client file', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { ...googleAuth.status(), error: '' };
    try {
      const text = fs.readFileSync(pick.filePaths[0], 'utf8');
      return { ...googleAuth.setClient(text), error: '' };
    } catch (e) {
      return { ...googleAuth.status(), error: e.message };
    }
  });
  handle('google:connect', async () => {
    try {
      await googleAuth.connect();
      const profile = await googleClient({ auth: googleAuth })('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      googleAuth.setEmail(profile.emailAddress);
      return { ...googleAuth.status(), error: '' };
    } catch (e) {
      return { ...googleAuth.status(), error: e.message };
    }
  });
  handle('google:disconnect', () => googleAuth.disconnect());
  handle('dashboard:get', (opts) => dashboard.get({ fresh: opts?.fresh === true }));
  handle('backup:now', () => {
    const folder = settings.get().backupFolder;
    try {
      const file = writeBackup(dataDir, folder, new Date(), hermesHome);
      prune(folder);
      return { file };
    } catch (e) {
      return { error: e.message };
    }
  });
  handle('backup:restore', async () => {
    const folder = settings.get().backupFolder;
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose a Jarvis backup',
      defaultPath: folder,
      properties: ['openFile'],
      filters: [{ name: 'Jarvis backup', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
    let backup;
    try {
      backup = readBackup(pick.filePaths[0]);
    } catch (e) {
      return { error: e.message };
    }
    const when = new Date(backup.created);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Restore backup',
      message: `Restore the backup from ${Number.isNaN(when.getTime()) ? 'an unknown date' : when.toLocaleString()}?`,
      detail:
        `It has ${backup.chats} past chat${backup.chats === 1 ? '' : 's'}. Your chats, settings and what Jarvis remembers are replaced with the backup's. Hermes's own settings, personality and scheduled jobs from the backup are put in a "hermes-restore" folder in Jarvis's data folder for you to copy back if you need them. ` +
        'A backup of what you have now is made first. Jarvis then restarts.',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return { canceled: true };
    if (brain.busy) return { error: `${settings.get().assistantName} is working on something. Try again when it's finished.` };
    try {
      writeBackup(dataDir, folder, new Date(), hermesHome);
      prune(folder);
    } catch (e) {
      return { error: `Couldn't back up your current data first, so nothing was changed: ${e.message}` };
    }
    autoBackup.stop();
    voice.stop();
    brain.shutdown();
    restoreBackup(dataDir, backup, hermesHome);
    // Exit at once: no quit handlers, so nothing writes the old data back over the restore.
    app.relaunch();
    app.exit(0);
    return { restarting: true };
  });

  // ---- window, tray, hotkey ----
  hardenSessions();
  createWindow();
  createTray(settings);
  registerHotkey(settings.get().hotkey);
  registerVoiceHotkey(settings.get().voiceHotkey);
  applyLoginItem(settings.get().startAtLogin);
  fs.mkdirSync(settings.get().workspace, { recursive: true });

  app.on('second-instance', () => showWindow());
  globalThis.__JARVIS_TEST_READY__?.({ win, brain, approvals, settings, dataDir });
  app.on('before-quit', () => {
    quitting = true;
    voice.stop();
    autoBackup.stop();
    brain.shutdown();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    /* stay in the tray */
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 400,
    minHeight: 520,
    show: !startHidden,
    title: 'Jarvis',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#1c1c1c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  win.loadURL(UI_URL);
  // The window only ever shows our own page; links open in your browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== UI_URL) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function hardenSessions() {
  // Only one exception: our own page may use the microphone (audio only, never the
  // camera), for push-to-talk. Location, notifications and the rest stay refused.
  const ours = (wc) => !!win && wc === win.webContents && wc.getURL() === UI_URL;
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) =>
    cb(perm === 'media' && ours(wc) && (details?.mediaTypes ?? []).length > 0 && details.mediaTypes.every((t) => t === 'audio')),
  );
  session.defaultSession.setPermissionCheckHandler((wc, perm, _origin, details) => perm === 'media' && ours(wc) && details?.mediaType === 'audio');
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('jarvis:event', { type: 'focus-input' });
}

function createTray(settings) {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip(settings.get().assistantName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${settings.get().assistantName}`, click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', showWindow);
}

// Push-to-talk: press to start listening (it stops when you go quiet), press
// again to stop early, or press while Jarvis is talking to interrupt.
let currentVoiceHotkey = null;
function registerVoiceHotkey(accel) {
  if (currentVoiceHotkey) globalShortcut.unregister(currentVoiceHotkey);
  currentVoiceHotkey = null;
  try {
    if (accel && globalShortcut.register(accel, () => {
      showWindow();
      win?.webContents.send('jarvis:event', { type: 'voice-toggle' });
    })) currentVoiceHotkey = accel;
  } catch {
    /* invalid accelerator text */
  }
}

let currentHotkey = null;
function registerHotkey(accel) {
  if (currentHotkey) globalShortcut.unregister(currentHotkey);
  currentHotkey = null;
  const toggle = () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow());
  for (const candidate of [accel, 'Control+Shift+Space']) {
    try {
      if (candidate && globalShortcut.register(candidate, toggle)) {
        currentHotkey = candidate;
        return;
      }
    } catch {
      /* invalid accelerator text */
    }
  }
}

function applyLoginItem(on) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const args = app.isPackaged ? ['--hidden'] : [path.resolve(here, '..', '..'), '--hidden'];
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args });
}

