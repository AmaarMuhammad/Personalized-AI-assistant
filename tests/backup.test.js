// Backups: everything worth keeping comes back exactly, a tampered or foreign file is
// refused whole, old backups are pruned, and the daily backup runs once a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeBackup, readBackup, restoreBackup, listBackups, prune, AutoBackup } from '../app/main/backup.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-${p}-`));

function seed(dir) {
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"userName":"Sam"}');
  fs.writeFileSync(path.join(dir, 'chat.json'), '[{"role":"user","text":"hi"}]');
  fs.writeFileSync(path.join(dir, 'hermes-session.json'), '{"id":"jarvis_1"}');
  fs.writeFileSync(path.join(dir, 'chats', 'index.json'), '[{"id":"a1"}]');
  fs.writeFileSync(path.join(dir, 'chats', 'a1.json'), '{"id":"a1","title":"Plans"}');
  fs.writeFileSync(path.join(dir, 'models', 'whisper.onnx'), 'big');
}

function seedHermes(dir) {
  fs.mkdirSync(path.join(dir, 'memories'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cron'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memories', 'USER.md'), 'Lives in Springfield.');
  fs.writeFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'Vault is on D:.');
  fs.writeFileSync(path.join(dir, 'SOUL.md'), 'Blunt.');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: x');
  fs.writeFileSync(path.join(dir, 'cron', 'jobs.json'), '{"jobs":[]}');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
}

test('a backup restores settings, chats and the live chat with its session, and leaves models alone', () => {
  const data = tmp('data');
  const out = tmp('out');
  seed(data);
  const file = writeBackup(data, out, new Date(2026, 9, 9, 6, 30, 5));
  assert.equal(path.basename(file), 'Jarvis backup 2026-10-09 063005.json');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /whisper/, 'speech models are not backed up');

  const other = tmp('other');
  fs.mkdirSync(path.join(other, 'chats'));
  fs.writeFileSync(path.join(other, 'hermes-session.json'), '{"id":"jarvis_other"}');
  fs.writeFileSync(path.join(other, 'reminders.json'), '[1]');
  fs.writeFileSync(path.join(other, 'exposure.json'), '[]');
  fs.writeFileSync(path.join(other, 'chats', 'zz.json'), '{}');
  const b = readBackup(file);
  assert.equal(b.chats, 1);
  restoreBackup(other, b);
  assert.equal(fs.readFileSync(path.join(other, 'chats', 'a1.json'), 'utf8'), '{"id":"a1","title":"Plans"}');
  assert.equal(fs.existsSync(path.join(other, 'chats', 'zz.json')), false, 'chats not in the backup are gone');
  // The live chat and its Hermes session travel together: the text of one chat must never continue another's session.
  assert.equal(fs.readFileSync(path.join(other, 'chat.json'), 'utf8'), '[{"role":"user","text":"hi"}]');
  assert.equal(fs.readFileSync(path.join(other, 'hermes-session.json'), 'utf8'), '{"id":"jarvis_1"}');
  assert.equal(fs.existsSync(path.join(other, 'reminders.json')), false, 'leftovers from the old app are removed');
  assert.equal(fs.existsSync(path.join(other, 'exposure.json')), false);
});

test('the brain is backed up too: memory comes back in place, settings are set aside, keys are never copied', () => {
  const data = tmp('data');
  const out = tmp('out');
  const hermes = tmp('hermes');
  seed(data);
  seedHermes(hermes);
  const file = writeBackup(data, out, new Date(2026, 10, 11, 9, 0, 0), hermes);
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /Lives in Springfield/);
  assert.match(raw, /Blunt/);
  assert.doesNotMatch(raw, /SECRET/, 'the .env with keys is never backed up');

  const data2 = tmp('data2');
  const hermes2 = tmp('hermes2');
  fs.mkdirSync(path.join(hermes2, 'memories'));
  fs.writeFileSync(path.join(hermes2, 'memories', 'USER.md'), 'wrong');
  fs.writeFileSync(path.join(hermes2, 'config.yaml'), 'live: config');
  restoreBackup(data2, readBackup(file), hermes2);
  assert.equal(fs.readFileSync(path.join(hermes2, 'memories', 'USER.md'), 'utf8'), 'Lives in Springfield.');
  assert.equal(fs.readFileSync(path.join(hermes2, 'memories', 'MEMORY.md'), 'utf8'), 'Vault is on D:.');
  assert.equal(fs.readFileSync(path.join(hermes2, 'config.yaml'), 'utf8'), 'live: config', 'a running Hermes keeps its settings');
  assert.equal(fs.readFileSync(path.join(data2, 'hermes-restore', 'config.yaml'), 'utf8'), 'model: x');
  assert.equal(fs.readFileSync(path.join(data2, 'hermes-restore', 'SOUL.md'), 'utf8'), 'Blunt.');
  assert.equal(fs.readFileSync(path.join(data2, 'hermes-restore', 'cron', 'jobs.json'), 'utf8'), '{"jobs":[]}');
});

test('a backup made by the old app is still accepted', () => {
  const dir = tmp('old');
  const f = path.join(dir, 'old.json');
  fs.writeFileSync(f, JSON.stringify({ format: 'jarvis-backup', version: 1, created: '', files: { 'memory.md': 'x', 'reminders.json': '[]', 'settings.json': '{}' } }));
  const data = tmp('data');
  restoreBackup(data, readBackup(f));
  assert.equal(fs.existsSync(path.join(data, 'settings.json')), true);
  assert.equal(fs.existsSync(path.join(data, 'memory.md')), false, 'old memory is not written back: Hermes owns memory now');
});

test('a backup that reaches outside Jarvis\'s files is refused, and nothing is written', () => {
  const dir = tmp('bad');
  const write = (name, files) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify({ format: 'jarvis-backup', version: 1, created: '', files }));
    return f;
  };
  for (const files of [
    { 'settings.json': 'ok', '../evil.cmd': 'x' },
    { 'hermes/.env': 'x' },
    { 'hermes/memories/../../evil.md': 'x' },
    { 'chats/../../evil.json': 'x' },
    { 'chats\\..\\evil.json': 'x' },
    { 'C:/Users/PC/evil.json': 'x' },
    { 'Cache/evil.js': 'x' },
    { 'settings.json': 42 },
  ]) {
    assert.throws(() => readBackup(write('b.json', files)), /recognise/);
  }
  fs.writeFileSync(path.join(dir, 'not.json'), '{"hello":1}');
  assert.throws(() => readBackup(path.join(dir, 'not.json')), /isn't a Jarvis backup/);
  fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
  assert.throws(() => readBackup(path.join(dir, 'junk.json')), /isn't a Jarvis backup/);
});

test('only the newest 10 backups are kept, and other files are never touched', () => {
  const data = tmp('data');
  const out = tmp('out');
  seed(data);
  fs.writeFileSync(path.join(out, 'my notes.json'), 'mine');
  for (let i = 0; i < 13; i++) writeBackup(data, out, new Date(2026, 9, 1 + i, 8, 0, 0));
  prune(out);
  const left = listBackups(out).map((f) => path.basename(f));
  assert.equal(left.length, 10);
  assert.equal(left[0], 'Jarvis backup 2026-10-13 080000.json');
  assert.equal(left.at(-1), 'Jarvis backup 2026-10-04 080000.json');
  assert.ok(fs.existsSync(path.join(out, 'my notes.json')));
});

test('the daily backup runs once a day, and not when it is turned off', () => {
  const data = tmp('data');
  const out = tmp('out');
  seed(data);
  let s = { autoBackup: true, backupFolder: out };
  let now = new Date();
  const auto = new AutoBackup({ dataDir: data, settings: { get: () => s }, now: () => now });
  assert.ok(auto.tick(), 'first run backs up');
  assert.equal(auto.tick(), null, 'not again the same day');
  now = new Date(Date.now() + 25 * 60 * 60 * 1000);
  assert.ok(auto.tick(), 'a day later it backs up again');
  assert.equal(listBackups(out).length, 2);
  now = new Date(Date.now() + 50 * 60 * 60 * 1000);
  s = { autoBackup: false, backupFolder: out };
  assert.equal(auto.tick(), null);
  assert.equal(listBackups(out).length, 2);
});
