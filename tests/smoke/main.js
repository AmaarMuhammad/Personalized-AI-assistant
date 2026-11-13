// End-to-end smoke test of the real Electron app with a simulated Claude.
// Run: xvfb-run electron tests/smoke/main.js <output-dir>
import { app, nativeTheme } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? path.join(os.tmpdir(), 'jarvis-smoke');
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-smoke-home-'));
for (const d of ['Documents', 'Downloads', 'Desktop', 'Pictures']) fs.mkdirSync(path.join(home, d), { recursive: true });
fs.writeFileSync(path.join(home, 'Documents', 'old-notes.txt'), 'old');
// A key file: with full access, touching credentials is one of the few things that still asks.
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'KEY');
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this for the home folder, not HOME
// The owner's JARVIS_VOICE_DEBUG user variables must not send fake recordings to the real capture folder.
delete process.env.JARVIS_VOICE_DEBUG;
delete process.env.JARVIS_VOICE_DEBUG_DIR;
app.setPath('userData', path.join(home, 'AppData', 'Jarvis'));
// Backups go to the fake home, never the real (OneDrive) Documents.
const backups = path.join(home, 'Documents', 'Jarvis Backups');
fs.mkdirSync(path.join(home, 'AppData', 'Jarvis'), { recursive: true });
fs.writeFileSync(path.join(home, 'AppData', 'Jarvis', 'settings.json'), JSON.stringify({ backupFolder: backups }));
// Hermes's own memory files, as the Memory page reads them (a fake Hermes home).
const hermesHome = path.join(home, 'hermes');
process.env.HERMES_HOME = hermesHome;
fs.mkdirSync(path.join(hermesHome, 'memories'), { recursive: true });
fs.writeFileSync(path.join(hermesHome, 'memories', 'USER.md'), ['Lives in Springfield.', '§', 'Prefers short answers.'].join(String.fromCharCode(10)));
fs.writeFileSync(path.join(hermesHome, 'memories', 'MEMORY.md'), 'Vault is on D:.');

// A simulated microphone, and a stand-in voice engine (the real models are tested separately).
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const { EventEmitter } = await import('node:events');
const voiceCalls = [];
globalThis.__JARVIS_TEST_VOICE__ = Object.assign(new EventEmitter(), {
  transcribe: async (audio) => (voiceCalls.push(['transcribe', audio.length]), { text: 'What is the weather today?', language: 'english' }),
  speak: async (text, language) => (voiceCalls.push(['speak', text, language]), { audio: new Float32Array(2400), sampleRate: 24000 }),
  prepare: async () => ({ device: 'gpu' }),
  stop: () => {},
});
const seenPrompts = [];

// A stand-in Google for the dashboard: a day of meetings and a few unread emails.
const googleCalls = [];
globalThis.__JARVIS_TEST_GOOGLE__ = async (method, url, opts = {}) => {
  googleCalls.push(url);
  const at = (h, m = 0, d = 0) => {
    const t = new Date();
    t.setDate(t.getDate() + d);
    t.setHours(h, m, 0, 0);
    return t.toISOString();
  };
  if (url.includes('/events') && opts.query?.maxResults === 250) {
    // The months ahead: an exam, and a weekly class that must show once.
    const day = (d) => ({ dateTime: at(10, 0, d) });
    return { items: [
      { id: 'c1', recurringEventId: 'wk', summary: 'Weekly class', status: 'confirmed', start: day(3), end: day(3) },
      { id: 'c2', recurringEventId: 'wk', summary: 'Weekly class', status: 'confirmed', start: day(10), end: day(10) },
      { id: 'x1', summary: 'Final exam', status: 'confirmed', start: day(40), end: day(40) },
    ] };
  }
  if (url.includes('/events')) {
    // A day around now: one meeting done, one under way, two to come.
    const rel = (min) => new Date(Date.now() + min * 60000).toISOString();
    const ev = (summary, from, mins) => ({ summary, status: 'confirmed', start: { dateTime: rel(from) }, end: { dateTime: rel(from + mins) } });
    return { items: [ev('Standup', -170, 15), ev('Design review', -24, 60), ev('Call with Ali', 126, 30), ev('Gym', 306, 60)] };
  }
  if (url.endsWith('/labels/INBOX')) return { messagesUnread: 4 };
  if (url.includes('/messages?') || url.endsWith('/messages')) return { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] };
  const mail = { m1: ['Ali Khan <ali@example.com>', 'Invoice for September'], m2: ['"HBL" <alerts@hbl.example>', 'Your e-statement is ready'], m3: ['sara@example.com', 'Lunch on Friday?'] };
  const [from, subject] = mail[url.split('/').pop().split('?')[0]] ?? ['x@example.com', 'Hello'];
  return { internalDate: String(Date.now() - 3_600_000), payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] } };
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulated Hermes API server: answers, and asks to delete a file when told to.
const hermesRuns = new Map(); // run_id → { push, end, approval }
globalThis.__JARVIS_TEST_HERMES__ = async (url, init = {}) => {
  const route = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : null;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (init.method === 'POST' && route === '/v1/runs') {
    const id = `run_${hermesRuns.size + 1}`;
    seenPrompts.push(body.input); // as Hermes receives it, voice hint included
    const text = body.input;
    const run = {
      frames: [], wake: null, closed: false, approval: null,
      push(e) { this.frames.push(`event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`); this.wake?.(); },
      end() { this.closed = true; this.wake?.(); },
    };
    hermesRuns.set(id, run);
    const say = async (s, ms) => {
      for (const w of s.split(' ')) { run.push({ event: 'message.delta', delta: w + ' ' }); await sleep(ms); }
    };
    (async () => {
      await sleep(20);
      if (/delete/i.test(text)) {
        run.push({ event: 'tool.started', tool: 'mcp__jarvis_desktop__recycle', preview: path.join(home, '.ssh', 'id_rsa') });
        const choice = await new Promise((r) => {
          run.approval = r;
          run.push({ event: 'approval.request', request_id: 'req-1', pattern_key: 'mcp_elicitation',
            command: 'Delete id_rsa, to the Recycle Bin?\n(Asking because it touches passwords, keys or saved sign-ins.)',
            description: "Approval requested by MCP server 'jarvis-desktop'." });
        });
        await say(choice === 'deny' ? 'Okay, I left it alone.' : 'Done — **id_rsa** is in the Recycle Bin.', 15);
      } else {
        run.push({ event: 'tool.started', tool: 'web_search', preview: 'weather in Shekhupura' });
        await say('Here’s what I found:\n\n- It’s **sunny**, around 31°C\n- Light breeze in the evening\n\nSources:\n- [Example Weather](https://example.com/weather)', 10);
      }
      run.push({ event: 'run.completed', output: '' , usage: { total_tokens: 1 } });
      run.end();
    })();
    return { ok: true, status: 202, json: async () => ({ run_id: id, status: 'started' }) };
  }
  const m = /^\/v1\/runs\/([^/]+)(?:\/(events|approval|stop))?$/.exec(route);
  const run = m && hermesRuns.get(m[1]);
  if (run && m[2] === 'events') {
    init.signal?.addEventListener('abort', () => run.end());
    async function* stream() {
      while (true) {
        if (run.frames.length) { yield new TextEncoder().encode(run.frames.shift()); continue; }
        if (run.closed) return;
        await new Promise((r) => (run.wake = r));
        run.wake = null;
      }
    }
    return { ok: true, status: 200, body: stream() };
  }
  if (run && m[2] === 'approval') { run.approval?.(body.choice); return ok({ ok: true }); }
  if (run && m[2] === 'stop') { run.end(); return ok({ ok: true }); }
  return ok({ status: 'completed', output: '' });
};

globalThis.__JARVIS_TEST_READY__ = async ({ win }) => {
  try {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') console.log(`RENDERER ${e.level}: ${e.message}`); });
    const waitFor = async (code, ms = 8000) => {
      for (let t = 0; t < ms; t += 100) {
        if (await js(code)) return true;
        await sleep(100);
      }
      return false;
    };
    const shot = async (name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await sleep(600);
    win.show();
    check('window loads our page', (await js('document.title')) === 'Jarvis');
    check('page has no Node access', (await js('typeof require + typeof process')) === 'undefinedundefined');
    check('bridge exposes only the jarvis API', (await js('Object.keys(window.jarvis).length')) > 10);
    await shot('1-empty.png');

    // The home screen: the orb on its stage, the day around it.
    check('the app opens on the dashboard', await js(`document.getElementById('page-chat').classList.contains('home-mode')`));
    check('the orb is drawing', await waitFor(`!!document.getElementById('orb').shadowRoot?.querySelectorAll('canvas').length && document.getElementById('orb').getAttribute('state') === 'idle'`, 3000));
    check('Today card lists the coming 3 months, a repeating event once', await waitFor(`(() => { const t = document.getElementById('day-body').innerText; return /Coming up/i.test(t) && /Final exam/.test(t) && (t.match(/Weekly class/g) || []).length === 1; })()`, 5000));
    check('today and inbox show on the dashboard', await waitFor(`/Design review/.test(document.getElementById('day-body').innerText) && /Ali Khan/.test(document.getElementById('mail-body').innerText) && document.getElementById('mail-count').textContent === '4'`, 5000));
    check('the dashboard reads Google directly, not through Claude', googleCalls.length > 0 && seenPrompts.length === 0);
    check('the cards line up: Today spans Inbox and Needs you, and no Reminders card', await js(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return Math.abs(r('card-day').top - r('card-mail').top) < 1 && Math.abs(r('card-day').bottom - r('card-needs').bottom) < 1 && !document.getElementById('card-reminders'); })()`));
    check('the briefing line sums up the day', /Design review until .*4 unread emails/.test(await js(`document.getElementById('head-sub').textContent`)));
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await sleep(900);
      await shot(`0-home-${theme}.png`);
    }
    // Every window size, from wide to a docked side panel.
    const [w0, h0] = win.getSize();
    for (const [w, h] of [[1440, 900], [760, 900], [420, 900]]) {
      win.setSize(w, h);
      await sleep(900);
      await shot(`0-home-${w}.png`);
      if (w === 1440) check('the hint is centred over the message box on a wide window', await js(`(() => { const h = document.getElementById('hint'), a = h.getBoundingClientRect(), b = document.getElementById('composer').getBoundingClientRect(); return getComputedStyle(h).textAlign === 'center' && Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 1; })()`));
    }
    check('a docked window keeps every card on screen', await js(`getComputedStyle(document.querySelector('.rail')).flexDirection === 'row' && document.getElementById('card-needs').getBoundingClientRect().width > 300`));
    win.setSize(w0, h0);
    await sleep(500);
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme;
      for (const st of ['idle', 'listening', 'thinking', 'searching', 'speaking', 'attention', 'done']) {
        await js(`document.getElementById('orb').setAttribute('state', '${st}'); document.getElementById('orb').setAttribute('level', '0.7')`);
        await sleep(1300);
        const r = await js(`(() => { const b = document.querySelector('.lens').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
        fs.writeFileSync(path.join(out, `orb-${theme}-${st}.png`), (await win.webContents.capturePage(r)).toPNG());
      }
    }
    await js(`document.getElementById('orb').setAttribute('state', 'idle')`);
    nativeTheme.themeSource = 'system';

    await js(`document.getElementById('input').value='What is the weather today?'; document.getElementById('composer').requestSubmit();`);
    check('typing opens the conversation', await waitFor(`!document.getElementById('page-chat').classList.contains('home-mode')`, 2000));
    await waitFor(`/sunny/.test(document.querySelector('.msg.assistant .reply')?.innerText || '') && document.getElementById('stop').hidden`, 8000);
    const reply = await js(`document.querySelector('.msg.assistant .reply')?.innerText || ''`);
    check('a question gets a streamed, formatted answer', /sunny/.test(reply), reply.slice(0, 60));
    check('links render as links, not raw markdown', await waitFor(`!!document.querySelector('.reply a[title="https://example.com/weather"]')`, 3000));
    check('the step list shows what Jarvis did', /Search the web/.test(await js(`document.querySelector('.steps')?.innerText || ''`)));
    // Saved as it goes: the vault copy exists after the first answer, without pressing New chat.
    const vaultChatsDir = path.join(home, 'Jarvis Workspace', 'Vault', 'Chats');
    const vaultText = () => (fs.existsSync(vaultChatsDir) ? fs.readdirSync(vaultChatsDir).map((f) => fs.readFileSync(path.join(vaultChatsDir, f), 'utf8')).join('\n') : '');
    const until = async (fn, ms = 3000) => {
      for (let t = 0; t < ms; t += 100) {
        if (fn()) return true;
        await sleep(100);
      }
      return false;
    };
    check('the chat is in the vault after the first answer, before New chat', await until(() => /What is the weather today\?/.test(vaultText()) && /sunny/.test(vaultText()) && /· typed · English/.test(vaultText())));
    const urdu = 'میرا نام عمار ہے، کل کا موسم کیسا ہوگا؟';
    await js(`document.getElementById('input').value = ${JSON.stringify(urdu)}; document.getElementById('composer').requestSubmit();`);
    await waitFor(`!document.getElementById('stop').hidden`, 2000);
    await waitFor(`document.getElementById('stop').hidden`, 5000);
    check('Urdu typed in the window shows as written', (await js(`[...document.querySelectorAll('.conversation .msg.user')].pop().textContent`)) === urdu);
    check('and is saved to the vault as written, tagged Urdu', await until(() => vaultText().includes(`typed · Urdu\n\n${urdu}`)));
    await shot('2-answer.png');

    await js(`document.getElementById('input').value='Delete my old notes file'; document.getElementById('composer').requestSubmit();`);
    await sleep(800);
    check('deleting shows an approval card', (await js(`document.querySelectorAll('.conversation .approval:not(.settled)').length`)) === 1);
    check('the card says what will happen', /id_rsa/.test(await js(`document.querySelector('.conversation .approval-what').innerText`)));
    check('and Jarvis says out loud what it wants to do and why', await until(() => voiceCalls.some((c) => c[0] === 'speak' && /Delete id_rsa, to the Recycle Bin\?/.test(c[1]))));
    check('the badge counts pending approvals', (await js(`document.getElementById('approval-badge').textContent`)) === '1');
    await shot('3-approval.png');
    await js(`document.querySelector('.conversation .approval [data-choice="deny"]').click()`);
    check('"Don’t allow" is respected', await waitFor(`/left it alone/.test([...document.querySelectorAll('.msg.assistant .reply')].pop()?.innerText || '')`, 5000));
    check('the file is untouched', fs.existsSync(path.join(home, '.ssh', 'id_rsa')));
    await shot('4-declined.png');

    await js(`document.querySelector('[data-page=activity]').click()`);
    await sleep(500);
    const act = await js(`document.getElementById('activity-list').innerText`);
    check('activity log lists the declined delete', /You declined/.test(act) && /id_rsa/.test(act));
    await shot('5-activity.png');

    await js(`document.querySelector('[data-page=settings]').click()`);
    await sleep(500);
    check('settings shows the safety rules Hermes enforces, read-only', /Always asks you, every time/.test(await js(`document.getElementById('safety-rules').innerText`)) && (await js(`document.querySelectorAll('#safety-rules select, #safety-rules input, #safety-rules textarea').length`)) === 0);
    check('no settings control pretends to change what Hermes does', (await js(`!document.getElementById('trust-table') && !document.getElementById('s-allowedRoots') && !document.getElementById('s-personality')`)));
    await shot('6-settings.png');
    check('settings shows the Google account section', /Not connected/.test(await js(`document.getElementById('g-status').textContent`)));
    check('no in-app morning briefing: Hermes cron does it', await js(`!document.getElementById('b-on') && !document.getElementById('b-run')`));
    await js(`document.getElementById('g-status').scrollIntoView()`);
    await shot('6b-google.png');
    await js(`document.getElementById('bk-now').click()`);
    check('Back up now writes a backup file', await waitFor(`document.getElementById('bk-msg').textContent === 'Backed up.'`, 3000) && fs.readdirSync(backups).some((n) => /^Jarvis backup .*.json$/.test(n)));

    await js(`document.querySelector('[data-page=memory]').click()`);
    await sleep(400);
    check('memory page shows Hermes memory (About you and Hermes notes)', /About you/.test(await js(`document.getElementById('memory-text').value`)) && /Hermes notes/.test(await js(`document.getElementById('memory-text').value`)) && /Prefers short answers/.test(await js(`document.getElementById('memory-text').value`)));
    check('no suggestion cards: Hermes asks in chat instead', (await js(`document.querySelectorAll('.proposal').length`)) === 0);
    await shot('7-memory.png');
    const vaultMemory = path.join(home, 'Jarvis Workspace', 'Vault', 'Memory.md');
    await js(`{ const s = document.getElementById('mem-search'); s.value = 'short'; s.dispatchEvent(new Event('input')); }`);
    check('memory can be searched', (await js(`document.querySelectorAll('#mem-facts .fact').length`)) === 1);
    await js(`{ const s = document.getElementById('mem-search'); s.value = ''; s.dispatchEvent(new Event('input')); }`);
    await js(`[...document.querySelectorAll('.fact')].find((f) => /short answers/.test(f.innerText)).querySelector('button:last-child').click()`);
    check('a fact can be deleted, and it is gone from Hermes USER.md', (await waitFor(`!/short answers/.test(document.getElementById('mem-facts').innerText)`, 3000)) && !/short answers/.test(fs.readFileSync(path.join(hermesHome, 'memories', 'USER.md'), 'utf8')));
    check('the vault has a readable copy of memory', fs.existsSync(vaultMemory) && /Springfield/.test(fs.readFileSync(vaultMemory, 'utf8')));
    check('an earlier version is there to go back to', (await js(`document.getElementById('mem-history').options.length`)) >= 1 && !(await js(`document.getElementById('mem-restore').disabled`)));

    await js(`document.querySelector('[data-page=chat]').click()`);
    await js(`document.getElementById('new-chat').click()`);
    await sleep(800);
    await js(`document.querySelector('[data-page=chats]').click()`);
    await sleep(500);
    check('New chat keeps the old one on the Chats page', /What is the weather today\?/.test(await js(`document.getElementById('chat-list').innerText`)));
    await js(`document.querySelector('.chat-item').click()`);
    await sleep(400);
    check('an old chat opens to read', /sunny/.test(await js(`document.getElementById('chat-view-body').innerText`)));
    const vaultChats = path.join(home, 'Jarvis Workspace', 'Vault', 'Chats');
    check('the vault has a markdown copy of the chat', fs.existsSync(vaultChats) && fs.readdirSync(vaultChats).some((f) => /What is the weather today/.test(f)));
    await js(`document.getElementById('chat-rename').click()`);
    await js(`document.getElementById('chat-rename-input').value = 'Weather check'; document.getElementById('chat-rename-form').requestSubmit();`);
    await sleep(600);
    check('a chat can be renamed', (await js(`document.getElementById('chat-view-title').textContent`)) === 'Weather check' && /Weather check/.test(await js(`document.getElementById('chat-list').innerText`)) && fs.readdirSync(path.join(home, 'Jarvis Workspace', 'Vault', 'Chats')).some((f) => /Weather check\.md$/.test(f)));
    await shot('8-chats.png');
    await js(`document.getElementById('chat-continue').click()`);
    await sleep(800);
    check('Continue brings the chat back', !(await js(`document.getElementById('page-chat').hidden`)) && /sunny/.test(await js(`document.getElementById('conversation').innerText`)));

    // Voice: click the mic, "speak" into the simulated microphone, click again to finish.
    await js(`document.querySelector('[data-page=chat]').click(); document.getElementById('rail-orb').click()`);
    await sleep(300);
    await js(`window.__captions = []; new MutationObserver(() => window.__captions.push(document.getElementById('caption').textContent)).observe(document.getElementById('caption'), { childList: true, characterData: true, subtree: true })`);
    await js(`document.getElementById('mic').click()`);
    await sleep(1200);
    check('the orb listens with you', await js(`document.getElementById('orb').getAttribute('state') === 'listening'`));
    check('the mic button starts listening', await js(`document.getElementById('mic').classList.contains('listening')`));
    await js(`document.getElementById('mic').click()`);
    await waitFor(`window.__voicePlayed > 0`, 8000);
    for (let t = 0; t < 5000 && voiceCalls.filter((c) => c[0] === 'speak').length < 2; t += 100) await sleep(100);
    check('what you said is transcribed and sent', voiceCalls.some((c) => c[0] === 'transcribe' && c[1] > 8000) && seenPrompts.some((p) => /\[Voice:/.test(p) && /What is the weather today\?/.test(p)));
    check('the reply is spoken, sentence by sentence', voiceCalls.filter((c) => c[0] === 'speak').length >= 2 && !voiceCalls.some((c) => c[0] === 'speak' && /\*\*|https?:|Sources/.test(c[1])));
    check('the reply audio plays in the window', (await js(`window.__voicePlayed`)) >= 1);
    await sleep(600);
    const said = voiceCalls.filter((c) => c[0] === 'speak').map((c) => c[1].replace(/\s+/g, ' ').trim());
    await waitFor(`document.getElementById('caption').textContent === ${JSON.stringify(said.at(-1) ?? '')}`, 5000);
    const shown = (await js(`window.__captions`)).filter(Boolean);
    check('captions follow the voice: only the sentence being spoken, word by word', shown.length > said.length && shown.every((t) => said.some((x) => x.startsWith(t))), JSON.stringify(shown.slice(0, 6)));
    const lastSaid = voiceCalls.filter((c) => c[0] === 'speak').pop()?.[1] ?? '';
    check('talking from the dashboard stays there, captioned by what is being said', (await js(`document.getElementById('page-chat').classList.contains('home-mode')`)) && lastSaid.length > 0 && (await js(`document.getElementById('caption').textContent`)) === lastSaid.replace(/\s+/g, ' ').trim(), lastSaid);
    await shot('9-voice.png');

    // Conversation mode: once the spoken reply ends, the mic opens again by itself; Esc ends it.
    await waitFor(`!document.getElementById('mic').classList.contains('hearing') && document.getElementById('orb').getAttribute('state') !== 'speaking'`, 8000);
    await js(`document.getElementById('auto-listen').click()`);
    check('the Auto switch turns conversation mode on', await waitFor(`document.getElementById('auto-listen').getAttribute('aria-pressed') === 'true'`, 2000));
    await js(`document.getElementById('mic').click()`);
    await sleep(1200);
    await js(`document.getElementById('mic').click()`);
    check('after a spoken reply, it listens for your answer', await waitFor(`document.getElementById('mic').classList.contains('listening') && /Listening for your answer/.test(document.getElementById('hint').textContent)`, 10000));
    await sleep(400);
    await shot('9b-voice-follow-up.png');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);
    check('Esc ends the conversation', !(await js(`document.getElementById('mic').classList.contains('listening')`)));

    // An approval asked for while the dashboard is up is answered right there, under the orb.
    await js(`window.jarvis.send('Delete my old notes file', { spoken: false })`);
    check('an approval on the dashboard stays on the dashboard', (await waitFor(`!!document.querySelector('#home-approvals .approval:not(.settled)')`, 3000)) && (await js(`document.getElementById('page-chat').classList.contains('home-mode')`)));
    check('the dashboard card says what will happen', /id_rsa/.test(await js(`document.querySelector('#home-approvals .approval-what').innerText`)));
    await sleep(1200);
    const onScreen = `(() => { const a = document.querySelector('#home-approvals .approval-actions').getBoundingClientRect(), h = document.getElementById('home').getBoundingClientRect(); return a.height > 0 && a.top >= h.top && a.bottom <= h.bottom; })()`;
    check('its buttons are on screen without scrolling by hand', await js(onScreen));
    await shot('10-home-approval.png');
    const [w1, h1] = win.getSize();
    win.setSize(420, 900);
    await sleep(900);
    await js(`document.querySelector('#home-approvals .approval-actions').scrollIntoView({ block: 'nearest' })`);
    check('in a docked window too', await js(onScreen));
    await shot('10-home-approval-420.png');
    win.setSize(w1, h1);
    await sleep(500);
    await js(`document.querySelector('#home-approvals [data-choice="deny"]').click()`);
    check('answering it there settles both copies and the card leaves', (await waitFor(`!document.querySelector('#home-approvals .approval') && !document.getElementById('home').classList.contains('has-approval') && [...document.querySelectorAll('.conversation .approval')].pop().classList.contains('was-denied')`, 4000)) && fs.existsSync(path.join(home, '.ssh', 'id_rsa')));

    // Delete: the chat leaves the list and its vault copy goes to the Recycle Bin.
    await js(`window.confirm = () => true; document.getElementById('new-chat').click()`);
    await sleep(800);
    await js(`document.querySelector('[data-page=chats]').click()`);
    await sleep(500);
    const before = await js(`document.querySelectorAll('.chat-item').length`);
    const mdBefore = fs.readdirSync(vaultChatsDir).length;
    await js(`document.querySelector('.chat-item').click()`);
    await sleep(400);
    await js(`document.getElementById('chat-delete').click()`);
    check('a chat can be deleted; its vault copy leaves the vault', (await waitFor(`document.querySelectorAll('.chat-item').length === ${before - 1}`, 3000)) && (await until(() => fs.readdirSync(vaultChatsDir).length === mdBefore - 1)));

    // The page must not be able to navigate away or open arbitrary windows.
    await js(`location.href='https://example.com'`).catch(() => {});
    await sleep(500);
    check('page cannot navigate away', win.webContents.getURL().startsWith('file://'));
  } catch (e) {
    check('smoke run', false, String(e?.stack ?? e));
  } finally {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    app.exit(results.every((r) => r.ok) ? 0 : 1);
  }
};

await import('../../app/main/main.js');
