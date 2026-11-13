// Is the assistant whole right now? No model is involved: these are plain checks, so a broken
// brain can still be reported. Each returns { id, ok, message } with a message you can act on.
//
// Why this exists: in Nov 2026 the Claude sign-in expired and Google disconnected, and for days
// nothing said so. The local model answered and briefings went out without mail or calendar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function up(fetchFn, url) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The last lines of Hermes's log: did it fail to sign in to Claude recently and fall back?
export function claudeFallbackSeen(logText, now = Date.now(), withinMs = 24 * 60 * 60_000) {
  let last = 0;
  for (const line of String(logText).split('\n')) {
    if (!/Primary provider auth failed|Provider fallback: anthropic/i.test(line)) continue;
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(line);
    if (m) last = Math.max(last, new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime());
  }
  return last > 0 && now - last < withinMs;
}

function tail(file, bytes = 400_000) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export async function checkHealth({
  hermesHome, repoDir, googleConnected,
  fetchFn = globalThis.fetch, now = Date.now(),
  hermesUrl = 'http://127.0.0.1:8642', llamaUrl = 'http://127.0.0.1:8080',
}) {
  const out = [];
  const add = (id, ok, message) => out.push({ id, ok, message });

  add('gateway', await up(fetchFn, `${hermesUrl}/health`),
    'Hermes is not running, so nothing works: no chat, no phone, no briefing. Start the Hermes gateway.');

  let fallback = false;
  try {
    fallback = claudeFallbackSeen(tail(path.join(hermesHome, 'logs', 'agent.log')), now);
  } catch {
    /* no log yet */
  }
  add('claude', !fallback,
    'Claude was not available in the last day, so the weaker local model has been answering. Sign in again: run "claude" once, then "hermes auth add anthropic" if it still fails.');

  add('google', !!googleConnected(),
    'Google is disconnected, so there is no email or calendar. Reconnect it in Jarvis: Settings, Email and calendar.');

  add('local-model', await up(fetchFn, `${llamaUrl}/health`),
    'The local model is not running (normal while a game is open). If Claude is unavailable too, there is no brain at all.');

  let plugin = false;
  let why = 'The safety plugin (jarvis-trust) is not installed in Hermes.';
  try {
    const installed = path.join(hermesHome, 'plugins', 'jarvis-trust', '__init__.py');
    const ours = path.join(repoDir, 'hermes-plugins', 'jarvis-trust', '__init__.py');
    const enabled = /^\s*-\s*jarvis-trust\s*$/m.test(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8'));
    if (!fs.existsSync(installed)) why = 'The safety plugin (jarvis-trust) is not installed in Hermes.';
    else if (!enabled) why = 'The safety plugin (jarvis-trust) is installed but not enabled in Hermes’s config.yaml.';
    else if (sha(installed) !== sha(ours)) why = 'The safety plugin in Hermes is not the same version as the one in the Jarvis folder. Copy it across and restart the gateway.';
    else plugin = true;
  } catch {
    /* treated as missing */
  }
  add('safety-plugin', plugin, `${why} Until it is fixed, a chat that read an email or web page is not made careful.`);
  return out;
}

export const problems = (results) => results.filter((r) => !r.ok && r.id !== 'local-model');
