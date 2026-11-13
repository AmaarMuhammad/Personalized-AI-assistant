// The health check: each silent failure seen in Nov 2026 must be reported, and a whole system reports nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHealth, problems, claudeFallbackSeen } from '../app/main/health.js';

const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
const FAIL_LINE = "2026-11-11 09:00:00,157 WARNING hermes_cli.runtime_provider: Primary provider auth failed (No Anthropic credentials found.). Falling back to local/qwen3.5-9b";

function world({ log = '', plugin = 'same', enabled = true } = {}) {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-health-h-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-health-r-'));
  fs.mkdirSync(path.join(hermesHome, 'logs'));
  fs.writeFileSync(path.join(hermesHome, 'logs', 'agent.log'), log);
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), `plugins:\n  enabled:\n${enabled ? '    - jarvis-trust\n' : '    - other\n'}`);
  fs.mkdirSync(path.join(repoDir, 'hermes-plugins', 'jarvis-trust'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'hermes-plugins', 'jarvis-trust', '__init__.py'), 'rules v2');
  if (plugin !== 'missing') {
    fs.mkdirSync(path.join(hermesHome, 'plugins', 'jarvis-trust'), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, 'plugins', 'jarvis-trust', '__init__.py'), plugin === 'same' ? 'rules v2' : 'rules v1');
  }
  return { hermesHome, repoDir };
}
const net = (down = []) => async (url) => {
  if (down.some((d) => url.includes(d))) throw new TypeError('fetch failed');
  return { ok: true };
};
const ids = (r) => problems(r).map((x) => x.id);

test('a whole system reports nothing', async () => {
  const r = await checkHealth({ ...world(), googleConnected: () => true, fetchFn: net(), now: NOW });
  assert.deepEqual(ids(r), []);
  assert.equal(r.length, 5);
});

test('the Claude sign-in expiring and the local model answering is reported for a day', async () => {
  const w = world({ log: `${FAIL_LINE}\n` });
  assert.deepEqual(ids(await checkHealth({ ...w, googleConnected: () => true, fetchFn: net(), now: NOW })), ['claude']);
  assert.deepEqual(ids(await checkHealth({ ...w, googleConnected: () => true, fetchFn: net(), now: NOW + 26 * 60 * 60_000 })), []);
  assert.equal(claudeFallbackSeen('2026-11-11 09:00:00,1 INFO something else', NOW), false);
});

test('Google disconnected, the gateway down and a missing, disabled or outdated safety plugin are each reported', async () => {
  assert.deepEqual(ids(await checkHealth({ ...world(), googleConnected: () => false, fetchFn: net(), now: NOW })), ['google']);
  assert.deepEqual(ids(await checkHealth({ ...world(), googleConnected: () => true, fetchFn: net([':8642']), now: NOW })), ['gateway']);
  for (const w of [world({ plugin: 'missing' }), world({ enabled: false }), world({ plugin: 'old' })]) {
    assert.deepEqual(ids(await checkHealth({ ...w, googleConnected: () => true, fetchFn: net(), now: NOW })), ['safety-plugin']);
  }
});

test('the local model being off is shown but is not an alarm on its own (a game may be running)', async () => {
  const r = await checkHealth({ ...world(), googleConnected: () => true, fetchFn: net([':8080']), now: NOW });
  assert.equal(r.find((x) => x.id === 'local-model').ok, false);
  assert.deepEqual(ids(r), []);
});
