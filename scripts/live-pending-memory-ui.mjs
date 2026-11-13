// Live UI check for the Memory page's approval queue, in a separate Jarvis instance with a
// throwaway Hermes home and data folder (your real memory and queue are never touched).
// It stages two writes, approves one and rejects the other through the real buttons, then
// checks USER.md. Run: node scripts/live-pending-memory-ui.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const REAL = path.join(process.env.LOCALAPPDATA, 'hermes');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ui-hermes-'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ui-data-'));
fs.mkdirSync(path.join(home, 'memories'), { recursive: true });
fs.writeFileSync(path.join(home, 'memories', 'USER.md'), 'Test user.', 'utf8');
fs.mkdirSync(path.join(home, 'pending', 'memory'), { recursive: true });
const stage = (id, content, origin, created_at) =>
  fs.writeFileSync(path.join(home, 'pending', 'memory', `${id}.json`), JSON.stringify({
    id, subsystem: 'memory', action: 'add', summary: content, origin, created_at,
    payload: { action: 'add', target: 'user', content, old_text: null },
  }));
stage('aaaa1111', 'UI test: likes Chinese food too.', 'assistant_tool', Date.now() / 1000 - 60);
stage('bbbb2222', 'UI test: should be rejected.', 'background_review', Date.now() / 1000);

const PORT = 9339;
const child = spawn(electron, ['.', `--user-data-dir=${data}`, `--remote-debugging-port=${PORT}`], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, HERMES_HOME: home, JARVIS_HERMES_INSTALL: REAL },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); ok &&= !!cond; };

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Jarvis window never appeared');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let n = 0;
  const waiting = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d); });
  const ev = (expr) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, (d) => resolve(d.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };

  check('badge shows 2', await until(`document.getElementById('memory-badge')?.textContent === '2' && !document.getElementById('memory-badge').hidden`));
  await ev(`document.querySelector('.nav-btn[data-page=memory]').click()`);
  check('queue section visible', await until(`!document.getElementById('mem-pending').hidden && document.querySelectorAll('#mem-pending-list li').length === 2`));
  const rows = await ev(`[...document.querySelectorAll('#mem-pending-list li')].map(li => li.innerText.replace(/\\s+/g,' '))`);
  console.log('   rows:', JSON.stringify(rows));
  check('newest first, origin shown', /rejected/.test(rows?.[0]) && /on its own/.test(rows?.[0]) && /Chinese/.test(rows?.[1]) && /Asked for in a chat/.test(rows?.[1]));

  const click = (text, label) => ev(`(() => { const li = [...document.querySelectorAll('#mem-pending-list li')].find(l => l.innerText.includes(${JSON.stringify(text)})); [...li.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click(); return true; })()`);
  await click('Chinese', 'Approve');
  check('approve clears it', await until(`document.querySelectorAll('#mem-pending-list li').length === 1`, 60000));
  console.log('   msg:', await ev(`document.getElementById('mem-pending-msg').textContent`));
  check('fact list shows it', await until(`document.getElementById('page-memory').innerText.includes('likes Chinese food too')`));
  await click('rejected', 'Reject');
  check('reject clears it, badge hidden', await until(`document.querySelectorAll('#mem-pending-list li').length === 0 && document.getElementById('memory-badge').hidden`, 60000));
  const user = fs.readFileSync(path.join(home, 'memories', 'USER.md'), 'utf8');
  check('USER.md has approved, not rejected', /likes Chinese food too/.test(user) && !/should be rejected/.test(user), JSON.stringify(user));
  check('queue folder empty', fs.readdirSync(path.join(home, 'pending', 'memory')).length === 0);
  ws.close();
} catch (e) {
  console.log('FAIL', e.message);
  ok = false;
} finally {
  child.kill();
}
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
