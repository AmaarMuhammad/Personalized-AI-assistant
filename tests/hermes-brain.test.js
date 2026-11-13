// HermesBrain against a fake Hermes API server: streaming, tools, approvals,
// session continuity, errors and stop. No network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesBrain, sseEvents, approvalCard, uiToolName } from '../app/main/hermes-brain.js';
import { Approvals } from '../app/main/approvals.js';

const sse = (events) => events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`).join('');

// A controllable SSE body: push() frames, end() closes.
function streamBody() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(events) {
      queue.push(sse(events));
      wake?.();
    },
    end() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield new TextEncoder().encode(queue.shift());
          continue;
        }
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

function fakeHermes({ startStatus = 202, script } = {}) {
  const calls = [];
  const bodies = [];
  const fetchFn = async (url, init = {}) => {
    const route = url.replace('http://127.0.0.1:8642', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, route, body, auth: init.headers?.Authorization });
    if (init.method === 'POST' && route === '/v1/runs') {
      if (startStatus !== 202) return { ok: false, status: startStatus, json: async () => ({}) };
      const id = `run_${calls.length}`;
      const b = streamBody();
      bodies.push({ id, body: b, input: body });
      return { ok: true, status: 202, json: async () => ({ run_id: id, status: 'started' }) };
    }
    if (init.method === 'GET' && route.endsWith('/events')) {
      const id = route.split('/')[3];
      const b = bodies.find((x) => x.id === id);
      init.signal?.addEventListener('abort', () => b.body.end()); // a real fetch body ends on abort
      queueMicrotask(() => script?.(b.body, calls));
      return { ok: true, status: 200, body: b.body };
    }
    if (init.method === 'GET' && route.startsWith('/v1/runs/')) {
      return { ok: true, json: async () => ({ status: 'completed', output: 'from status' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchFn, calls, bodies };
}

function setup(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hb-'));
  const approvals = new Approvals({ timeoutMs: 2000 });
  const hermes = fakeHermes(opts);
  const brain = new HermesBrain({ approvals, dataDir, getKey: () => 'k123', fetchFn: hermes.fetchFn, finishGraceMs: 50 });
  const seen = { text: '', working: [], done: [], errors: [], events: [] };
  for (const e of ['busy', 'idle']) brain.on(e, () => seen.events.push(e));
  brain.on('text', (t) => (seen.text += t));
  brain.on('working', (n) => seen.working.push(n));
  brain.on('done', (d) => seen.done.push(d));
  brain.on('error', (e) => seen.errors.push(e));
  const idle = () => new Promise((r) => brain.once('idle', r));
  return { brain, approvals, hermes, seen, idle, dataDir };
}

test('Hermes tool names map to the names the window labels', () => {
  assert.equal(uiToolName('mcp__jarvis_google__gmail_send'), 'mcp__google__gmail_send');
  assert.equal(uiToolName('mcp__jarvis_desktop__recycle'), 'mcp__jarvis__recycle');
  assert.equal(uiToolName('web_search'), 'WebSearch');
  assert.equal(uiToolName('something_new'), 'something_new');
});

test('sseEvents parses frames split across chunks and CRLF', async () => {
  const raw = 'event: a\r\ndata: {"event":"a","n":1}\r\n\r\nevent: b\ndata: {"eve';
  const rest = 'nt":"b","n":2}\n\n: keep-alive\n\n';
  const out = [];
  for await (const e of sseEvents([new TextEncoder().encode(raw), rest])) out.push(e.n);
  assert.deepEqual(out, [1, 2]);
});

test('a turn streams text, reports tools, finishes with done and idle', async () => {
  const t = setup({
    script: (b) => {
      b.push([{ event: 'tool.started', tool: 'mcp__jarvis_google__calendar_events' }]);
      b.push([{ event: 'message.delta', delta: 'Hel' }, { event: 'message.delta', delta: 'lo' }]);
      b.push([{ event: 'run.completed', output: 'Hello', usage: { total_tokens: 5 } }]);
    },
  });
  const done = t.idle();
  assert.equal(await t.brain.send('hi'), true);
  await done;
  assert.equal(t.seen.text, 'Hello');
  assert.deepEqual(t.seen.working, ['mcp__google__calendar_events']); // Hermes name → the window's name
  assert.equal(t.seen.done[0].text, 'Hello');
  assert.deepEqual(t.seen.events, ['busy', 'idle']);
  assert.equal(t.hermes.calls[0].auth, 'Bearer k123');
});

test('an empty final output keeps the streamed reply', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'message.delta', delta: 'streamed text' }, { event: 'run.completed', output: '' }]) });
  const p = t.idle();
  await t.brain.send('x');
  await p;
  assert.equal(t.seen.done[0].text, 'streamed text');
});

test('every turn uses the same Hermes session until reset', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'run.completed', output: 'ok' }]) });
  let p = t.idle();
  await t.brain.send('one');
  await p;
  p = t.idle();
  await t.brain.send('two');
  await p;
  const sids = t.hermes.bodies.map((b) => b.input.session_id);
  assert.equal(sids[0], sids[1]);
  assert.match(sids[0], /^jarvis_\d{8}_/);
  await t.brain.reset();
  p = t.idle();
  await t.brain.send('three');
  await p;
  assert.notEqual(t.hermes.bodies[2].input.session_id, sids[0]);
});

test('resumeChat continues an earlier Hermes session', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'run.completed', output: 'ok' }]) });
  t.brain.resumeChat('old-session-7');
  const p = t.idle();
  await t.brain.send('again');
  await p;
  assert.equal(t.hermes.bodies[0].input.session_id, 'old-session-7');
});

test('spoken turns carry the voice hint', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'run.completed', output: 'ok' }]) });
  const p = t.idle();
  await t.brain.send('what time is it', { spoken: true });
  await p;
  assert.match(t.hermes.bodies[0].input.input, /^\[Voice:/);
  assert.match(t.hermes.bodies[0].input.input, /what time is it$/);
});

test('a busy brain refuses a second message', async () => {
  const t = setup({ script: () => {} });
  assert.equal(await t.brain.send('first'), true);
  assert.equal(await t.brain.send('second'), false);
  await t.brain.interrupt();
});

test('approval request becomes a card; Approve sends "once" with the request id', async () => {
  const t = setup({
    script: (b) =>
      b.push([{
        event: 'approval.request', request_id: 'req-9', pattern_key: 'mcp_elicitation',
        command: 'Send an email to a@b.c, subject "x": "y"?\n(Asking because it reaches other people.)',
        description: "Approval requested by MCP server 'jarvis-google'.",
      }]),
  });
  const card = new Promise((r) => t.approvals.once('request', r));
  await t.brain.send('send it');
  const c = await card;
  assert.equal(c.tool, 'jarvis-google');
  assert.equal(c.canAlways, false);
  assert.equal(c.spoken, 'Send an email to a@b.c, subject "x": "y"?');
  t.approvals.answer(c.id, 'always'); // not offered → treated as once
  await new Promise((r) => setTimeout(r, 10));
  const ans = t.hermes.calls.find((x) => x.route.endsWith('/approval'));
  assert.deepEqual(ans.body, { choice: 'once', request_id: 'req-9' });
  const p = t.idle();
  t.hermes.bodies[0].body.push([{ event: 'run.completed', output: 'sent' }]);
  await p;
});

test('Deny and an unanswered card both send "deny" (fail closed)', async () => {
  const t = setup({
    script: (b) => b.push([{ event: 'approval.request', request_id: 'r1', command: 'rm -rf x' }]),
  });
  t.approvals.timeoutMs = 30;
  await t.brain.send('do it');
  await new Promise((r) => setTimeout(r, 80));
  const ans = t.hermes.calls.find((x) => x.route.endsWith('/approval'));
  assert.equal(ans.body.choice, 'deny');
  assert.equal(approvalCard({ command: 'rm -rf x' }).tool, 'terminal');
  await t.brain.interrupt();
});

test('activity log: an asked-about action is logged once, as your answer, never as "allowed by rule"', async () => {
  const added = [];
  const t = setup({
    script: (b) => {
      b.push([
        { event: 'tool.started', tool: 'web_search', preview: 'q' },
        { event: 'tool.started', tool: 'mcp__jarvis_google__gmail_send', preview: 'x' },
        { event: 'approval.request', request_id: 'r', command: 'Send this email to a@b.c now? It can\'t be undone.\nSubject "s": "b"?' },
      ]);
    },
  });
  t.brain.log = { add: (e) => added.push(e) };
  const card = new Promise((r) => t.approvals.once('request', r));
  await t.brain.send('send it');
  const c = await card;
  assert.equal(c.spoken, 'Send this email to a@b.c now? It can\'t be undone.');
  assert.deepEqual(added.map((e) => [e.tool, e.by]), [['WebSearch', 'rule']]); // nothing logged for the send yet
  t.approvals.answer(c.id, 'deny');
  await new Promise((r) => setTimeout(r, 10));
  const send = added.filter((e) => e.tool === 'mcp__google__gmail_send');
  assert.equal(send.length, 1);
  assert.equal(send[0].by, 'you');
  assert.equal(send[0].decision, 'deny');
  assert.match(send[0].summary, /Subject "s"/);
  const p = t.idle();
  t.hermes.bodies[0].body.push([{ event: 'run.completed', output: 'not sent' }]);
  await p;
});

test('activity log: an outward action Hermes ran without asking is logged when it completes', async () => {
  const added = [];
  const t = setup({
    script: (b) => b.push([
      { event: 'tool.started', tool: 'terminal', preview: 'Get-Date' },
      { event: 'tool.completed', tool: 'terminal' },
      { event: 'run.completed', output: 'ok' },
    ]),
  });
  t.brain.log = { add: (e) => added.push(e) };
  const p = t.idle();
  await t.brain.send('time?');
  await p;
  assert.deepEqual(added.map((e) => [e.tool, e.by, e.decision]), [['PowerShell', 'rule', 'allow']]);
});

test('a plugin approval card shows the plugin\'s question, not the placeholder', () => {
  const c = approvalCard({ command: '<terminal> (plugin approval rule)', description: 'Run this command: echo hi? This chat has read text someone else wrote (web_search: x), so the idea may not be yours.' });
  assert.match(c.spoken, /^Run this command: echo hi\?/);
  assert.equal(c.tool, 'terminal');
});

test('a failed run reports the error and goes idle', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'run.failed', error: 'provider down' }]) });
  const p = t.idle();
  await t.brain.send('x');
  await p;
  assert.match(t.seen.errors[0].message, /provider down/);
  assert.equal(t.seen.done.length, 0);
});

test('Hermes not running → clear offline error, not stuck busy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hb-'));
  const brain = new HermesBrain({
    approvals: new Approvals(), dataDir, getKey: () => 'k',
    fetchFn: async () => { throw new TypeError('fetch failed'); },
  });
  const errors = [];
  brain.on('error', (e) => errors.push(e));
  await brain.send('hello');
  assert.equal(errors[0].kind, 'offline');
  assert.equal(brain.busy, false);
});

test('wrong key → auth error', async () => {
  const t = setup({ startStatus: 401 });
  await t.brain.send('hello');
  assert.equal(t.seen.errors[0].kind, 'auth');
  assert.equal(t.brain.busy, false);
});

test('a dropped stream is settled from the run status', async () => {
  const t = setup({ script: (b) => { b.push([{ event: 'message.delta', delta: 'par' }]); b.end(); } });
  const p = t.idle();
  await t.brain.send('x');
  await p;
  assert.equal(t.seen.done[0].text, 'from status');
});

test('interrupt denies open cards, calls stop, and never leaves the app busy', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'approval.request', request_id: 'r', command: 'x' }]) });
  const settled = new Promise((r) => t.approvals.once('settled', r));
  await t.brain.send('long task');
  await new Promise((r) => setTimeout(r, 10));
  const p = t.idle();
  await t.brain.interrupt();
  assert.equal((await settled).choice, 'deny');
  assert.ok(t.hermes.calls.some((c) => c.route.endsWith('/stop')));
  await p;
  assert.equal(t.brain.busy, false);
});

// ---- Nov 2026: robustness and "which model answered" ----
import { servedBy } from '../app/main/hermes-brain.js';

function bare(fetchFn, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hb-'));
  const approvals = new Approvals({ timeoutMs: 2000 });
  const brain = new HermesBrain({ approvals, dataDir, getKey: () => 'k', fetchFn, finishGraceMs: 50, sleep: async () => {}, ...extra });
  const errors = [];
  const done = [];
  brain.on('error', (e) => errors.push(e));
  brain.on('done', (d) => done.push(d));
  return { brain, approvals, errors, done };
}

test('a reply Jarvis cannot read ends the turn with an error, never a stuck "working"', async () => {
  for (const json of [async () => { throw new Error('not json'); }, async () => ({ status: 'started' })]) {
    const t = bare(async () => ({ ok: true, status: 202, json }));
    assert.equal(await t.brain.send('hi'), true);
    assert.equal(t.errors.length, 1);
    assert.equal(t.brain.busy, false);
  }
});

test('a gateway that is still starting is waited for; one that never comes up is reported', async () => {
  let n = 0;
  const up = fakeHermes({ script: (b) => b.push([{ event: 'run.completed', output: 'ok' }]) });
  const t = bare(async (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/runs') && ++n < 3) throw new TypeError('fetch failed');
    return up.fetchFn(url, init);
  });
  const idle = new Promise((r) => t.brain.once('idle', r));
  await t.brain.send('hi');
  await idle;
  assert.equal(n, 3);
  assert.equal(t.done[0].text, 'ok');
  const down = bare(async () => { throw new TypeError('fetch failed'); }, { startupWaitMs: 0 });
  await down.brain.send('hi');
  assert.match(down.errors[0].message, /reach Hermes/);
  assert.equal(down.brain.busy, false);
});

test('a request Hermes never answers times out instead of hanging', async () => {
  const t = bare((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { requestMs: 30 });
  await t.brain.send('hi');
  assert.match(t.errors[0].message, /didn’t answer in time/);
  assert.equal(t.brain.busy, false);
});

test('a late start from a turn you already stopped does not take over the next turn', async () => {
  let release;
  const hermes = fakeHermes({ script: (b) => b.push([{ event: 'run.completed', output: 'second' }]) });
  let first = true;
  const t = bare(async (url, init) => {
    if (first && init.method === 'POST' && url.endsWith('/v1/runs')) {
      first = false;
      await new Promise((r) => (release = r));
      return { ok: true, status: 202, json: async () => ({ run_id: 'stale' }) };
    }
    return hermes.fetchFn(url, init);
  });
  const p1 = t.brain.send('one');
  await new Promise((r) => setTimeout(r, 5));
  await t.brain.reset(); // New chat while the first start is still on its way
  const idle = new Promise((r) => t.brain.once('idle', r));
  await t.brain.send('two');
  release();
  await p1;
  await idle;
  assert.equal(t.done.length, 1);
  assert.equal(t.done[0].text, 'second');
  assert.notEqual(t.brain.runId, 'stale');
});

test('a stream that goes silent is settled from the run status; a waiting card keeps it open', async () => {
  const t = setup({ script: (b) => b.push([{ event: 'message.delta', delta: 'par' }]) });
  t.brain.idleMs = 30;
  const p = t.idle();
  await t.brain.send('x');
  await p;
  assert.equal(t.seen.done[0].text, 'from status');

  const w = setup({ script: (b) => b.push([{ event: 'approval.request', request_id: 'r', command: 'x' }]) });
  w.brain.idleMs = 20;
  await w.brain.send('x');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.brain.busy, true, 'still waiting for your answer');
  await w.brain.interrupt();
});

test('done says which model answered, and flags anything that is not Claude', async () => {
  assert.deepEqual(servedBy({ provider: 'anthropic', model: 'claude-sonnet-5-5' }), { provider: 'anthropic', model: 'claude-sonnet-5-5', fallback: false });
  assert.equal(servedBy({ provider: 'local', model: 'qwen3.5-9b' }).fallback, true);
  assert.equal(servedBy({ provider: 'custom', model: 'qwen3.5-9b' }).fallback, true);
  assert.equal(servedBy(null), null);
  const t = setup({ script: (b) => b.push([{ event: 'run.completed', output: 'hi', runtime: { provider: 'local', model: 'qwen3.5-9b', route_source: 'global' } }]) });
  const p = t.idle();
  await t.brain.send('x');
  await p;
  assert.equal(t.seen.done[0].runtime.fallback, true);
});
