// The Memory page's queue of memory writes waiting for approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingMemory, findHermesPython } from '../app/main/pending-memory.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pending-'));
const stage = (home, rec) => {
  const dir = path.join(home, 'pending', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec), 'utf8');
};
const addRec = (id, content, extra = {}) => ({
  id, subsystem: 'memory', action: 'add', summary: `add: ${content}`, origin: 'assistant_tool', created_at: 1792200000,
  payload: { action: 'add', target: 'user', content, old_text: null }, ...extra,
});

test('No queue folder means nothing is waiting', () => {
  assert.deepEqual(new PendingMemory({ hermesHome: tmp() }).list(), []);
});

test('Lists each waiting write with its section, origin and full text, newest first', () => {
  const home = tmp();
  stage(home, addRec('aaaaaaaa', 'Prefers burgers slightly.', { created_at: 1792100000 }));
  stage(home, {
    id: 'bbbbbbbb', origin: 'background_review', created_at: 1792300000,
    payload: { action: 'batch', target: 'memory', operations: [
      { action: 'add', content: 'Uses git-bash.' },
      { action: 'replace', old_text: 'PC', content: 'PC: new GPU', matched_entry: 'PC: 32 GB RAM' },
    ] },
  });
  const items = new PendingMemory({ hermesHome: home }).list();
  assert.deepEqual(items.map((i) => i.id), ['bbbbbbbb', 'aaaaaaaa']);
  assert.equal(items[0].section, 'Hermes notes');
  assert.equal(items[0].auto, true);
  assert.equal(items[0].origin, 'Hermes noticed this on its own');
  assert.deepEqual(items[0].ops[1], { action: 'replace', text: 'PC: new GPU', replaces: 'PC: 32 GB RAM' });
  assert.equal(items[1].section, 'About you');
  assert.equal(items[1].origin, 'Asked for in a chat');
  assert.equal(items[1].ops[0].text, 'Prefers burgers slightly.');
  assert.equal(items[1].created, new Date(1792100000 * 1000).toISOString());
});

test('Broken files, and files whose name and id disagree, are skipped', () => {
  const home = tmp();
  const dir = path.join(home, 'pending', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cccccccc.json'), '{half', 'utf8');
  fs.writeFileSync(path.join(dir, 'dddddddd.json'), JSON.stringify(addRec('eeeeeeee', 'x')), 'utf8');
  stage(home, addRec('ffffffff', 'kept'));
  assert.deepEqual(new PendingMemory({ hermesHome: home }).list().map((i) => i.id), ['ffffffff']);
});

test('Ids that are not Hermes ids never reach Hermes', async () => {
  let calls = 0;
  const q = new PendingMemory({ hermesHome: tmp(), run: async () => (calls++, '{}') });
  for (const id of ['../memories/USER', 'all', 'ABCDEF12', '1234567', '', null]) {
    const r = await q.approve(id);
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 0);
});

test('Approve and reject go to Hermes; success only when Hermes removed the item', async () => {
  const home = tmp();
  stage(home, addRec('aaaaaaaa', 'one'));
  stage(home, addRec('bbbbbbbb', 'two'));
  const seen = [];
  const q = new PendingMemory({
    hermesHome: home,
    run: async (args, env) => {
      seen.push({ args, env });
      if (args[1] === 'aaaaaaaa') return 'noise\n{"out": "Approved 1 memory write(s).", "pending": false}\n';
      return '{"out": "Failed: too long", "pending": true}';
    },
  });
  let changes = 0;
  q.on('change', () => changes++);
  assert.deepEqual(await q.approve('aaaaaaaa'), { ok: true, message: 'Approved 1 memory write(s).' });
  assert.deepEqual(await q.reject('bbbbbbbb'), { ok: false, message: 'Failed: too long' });
  assert.deepEqual(seen.map((s) => s.args), [['approve', 'aaaaaaaa'], ['reject', 'bbbbbbbb']]);
  assert.equal(seen[0].env.HERMES_HOME, home);
  assert.equal(changes, 1);
});

test('An item that is already gone is reported, not sent to Hermes', async () => {
  let calls = 0;
  const q = new PendingMemory({ hermesHome: tmp(), run: async () => (calls++, '{}') });
  const r = await q.reject('aaaaaaaa');
  assert.equal(r.ok, false);
  assert.match(r.message, /no longer waiting/);
  assert.equal(calls, 0);
});

test('Hermes failing is reported, not thrown', async () => {
  const home = tmp();
  stage(home, addRec('aaaaaaaa', 'one'));
  const q = new PendingMemory({ hermesHome: home, run: async () => { throw new Error('boom'); } });
  const r = await q.approve('aaaaaaaa');
  assert.equal(r.ok, false);
  assert.match(r.message, /boom/);
});

// End to end through the real Hermes code, against a throwaway HERMES_HOME (your real memory is never touched).
const REAL = path.join(process.env.LOCALAPPDATA ?? '', 'hermes');
const hasHermes = !!findHermesPython(REAL) && fs.existsSync(path.join(REAL, 'hermes-agent', 'hermes_cli', 'write_approval_commands.py'));

test('Real Hermes: approve writes USER.md and clears the item; reject only clears', { skip: !hasHermes && 'Hermes not installed here', timeout: 120_000 }, async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'memories'), { recursive: true });
  stage(home, addRec('1a2b3c4d', 'Jarvis queue test: prefers burgers slightly.'));
  stage(home, addRec('5e6f7a8b', 'Jarvis queue test: should never be saved.'));
  const q = new PendingMemory({ hermesHome: home, installDir: REAL });

  const a = await q.approve('1a2b3c4d');
  assert.equal(a.ok, true, a.message);
  const user = fs.readFileSync(path.join(home, 'memories', 'USER.md'), 'utf8');
  assert.match(user, /prefers burgers slightly/);

  const r = await q.reject('5e6f7a8b');
  assert.equal(r.ok, true, r.message);
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'memories', 'USER.md'), 'utf8'), /never be saved/);
  assert.deepEqual(q.list(), []);
});
