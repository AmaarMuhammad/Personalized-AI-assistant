// The brain, Phase 7: Hermes (running on this PC) does the thinking, the tools,
// the memory and the model choice. Jarvis is the face: it sends what you said,
// streams the reply back, and shows Hermes's approval requests as cards.
//
// Same interface as v1's Brain (events: busy, text, working, done, error,
// usage, idle), so the rest of the app doesn't change.
//
// Transport: Hermes API server (loopback, bearer key) — POST /v1/runs, then
// the run's SSE events. Only /v1/runs carries approval.request events, which
// is why chat completions aren't used.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SPOKEN_HINT } from './speech.js';
import { entryFor } from './policy.js';

export const HERMES_URL = 'http://127.0.0.1:8642';
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

// Splits an SSE byte stream into parsed JSON events.
export async function* sseEvents(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* a keep-alive or a frame we don't understand */
      }
    }
  }
}

// Hermes tool names → the names the window already has labels and icons for.
const BUILTIN = {
  web_search: 'WebSearch', web_extract: 'WebFetch', terminal: 'PowerShell', read_file: 'Read',
  search_files: 'Grep', write_file: 'Write', patch: 'Edit', todo: 'TodoWrite',
};
export function uiToolName(tool) {
  const t = String(tool ?? '');
  if (BUILTIN[t]) return BUILTIN[t];
  const m = /^mcp__jarvis_(google|desktop)__(.+)$/.exec(t);
  if (m) return `mcp__${m[1] === 'google' ? 'google' : 'jarvis'}__${m[2]}`;
  return t;
}

// Hermes's own plumbing, not something you'd want listed as a step.
const QUIET = new Set(['tool_search', 'tool_describe', 'tool_call', 'skill_view', 'skills_list', 'todo']);

// An approval.request from Hermes → the card Jarvis already knows how to show.
export function approvalCard(ev) {
  // Plugin rules (e.g. jarvis-trust) put a placeholder in `command` and the real question in `description`.
  const placeholder = /^<[^>]+> \(plugin approval rule\)$/.test(String(ev.command ?? '').trim());
  const text = String((placeholder ? ev.description : ev.command) ?? ev.description ?? 'Hermes wants to do something.').trim();
  const fromMcp = /MCP server '([^']+)'/.exec(ev.description ?? '')?.[1];
  return {
    tool: fromMcp ? `${fromMcp}` : ev.pattern_key === 'mcp_elicitation' ? 'tool' : 'terminal',
    summary: text,
    reasons: [ev.description].filter(Boolean),
    escalated: false,
    canAlways: false, // "always" lives in Hermes's own allowlist, never granted from a card
    spoken: text.split('\n')[0],
  };
}

// Which model answered, from run.completed's `runtime`. `fallback` is true when it wasn't Claude.
export function servedBy(runtime) {
  const r = runtime && typeof runtime === 'object' ? runtime : null;
  const provider = String(r?.provider ?? r?.served?.provider ?? '').toLowerCase();
  const model = String(r?.model ?? r?.served?.model ?? '');
  if (!provider && !model) return null;
  return { provider, model, fallback: !(provider === 'anthropic' || /claude/i.test(model)) };
}

export class HermesBrain extends EventEmitter {
  constructor({ settings, approvals, dataDir, getKey, log = null, baseUrl = HERMES_URL, fetchFn = globalThis.fetch, finishGraceMs = 5000,
    requestMs = 30_000, idleMs = 10 * 60_000, startupWaitMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    super();
    Object.assign(this, { settings, approvals, dataDir, getKey, baseUrl, fetchFn, finishGraceMs, log, requestMs, idleMs, startupWaitMs, sleep });
    this.turn = 0; // a late answer from an older turn must not touch a newer one
    this.sessionFile = path.join(dataDir, 'hermes-session.json');
    this.busy = false;
    this.runId = null;
    this.abort = null; // ends the current run's event stream and its approval cards
    this.pending = []; // outward steps not logged yet: waiting to see if Hermes asks you
  }

  // ---- conversation id (Hermes session) ----
  savedSessionId() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')).id ?? null;
    } catch {
      return null;
    }
  }

  saveSessionId(id) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.sessionFile, JSON.stringify({ id }), 'utf8');
  }

  resumeChat(sessionId) {
    this.saveSessionId(sessionId);
  }

  headers() {
    return { Authorization: `Bearer ${this.getKey()}`, 'Content-Type': 'application/json' };
  }

  // `timeoutMs: 0` is for the event stream, which stays open as long as the run does.
  async call(method, route, body, signal, timeoutMs = this.requestMs) {
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
    return this.fetchFn(`${this.baseUrl}${route}`, {
      method,
      headers: this.headers(),
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signals.length ? { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] } : {}),
    });
  }

  // Right after login the gateway may still be starting: wait for it instead of failing the first message.
  async startRun(body) {
    const until = Date.now() + this.startupWaitMs;
    for (;;) {
      try {
        return await this.call('POST', '/v1/runs', body);
      } catch (e) {
        if (e?.name === 'TimeoutError' || Date.now() >= until) throw e;
        await this.sleep(1500);
      }
    }
  }

  // ---- a turn ----
  async send(text, { spoken = false } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean || this.busy) return false;
    this.busy = true;
    const turn = ++this.turn;
    this.emit('busy');
    let sessionId = this.savedSessionId();
    if (!sessionId) {
      sessionId = `jarvis_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${randomUUID().slice(0, 8)}`;
      this.saveSessionId(sessionId);
    }
    const input = spoken ? `${SPOKEN_HINT}\n${clean}` : clean;
    let res;
    try {
      res = await this.startRun({ input, session_id: sessionId });
    } catch (e) {
      if (turn !== this.turn) return true;
      this.fail('offline', e?.name === 'TimeoutError'
        ? 'Hermes didn’t answer in time. It may be busy or stuck; try again, or restart the Hermes gateway.'
        : 'Can’t reach Hermes. Check the Hermes gateway is running, then try again.');
      this.finishTurn();
      return true;
    }
    if (turn !== this.turn) return true; // you stopped or started a new chat while this was on its way
    if (!res.ok) {
      const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'limit' : 'error';
      const msg = {
        auth: 'Hermes refused Jarvis’s key. The API key in Credential Manager (Jarvis / hermes-api) doesn’t match Hermes’s .env.',
        limit: 'Hermes is busy with other work right now. Try again in a moment.',
      }[kind] ?? `Hermes couldn’t start that (HTTP ${res.status}).`;
      this.fail(kind, msg);
      this.finishTurn();
      return true;
    }
    let runId = null;
    try {
      runId = (await res.json())?.run_id ?? null;
    } catch {
      /* not JSON */
    }
    if (turn !== this.turn) return true;
    if (!runId) {
      this.fail('error', 'Hermes gave an answer Jarvis couldn’t read, so nothing was started. Try again.');
      this.finishTurn();
      return true;
    }
    this.runId = runId;
    this.abort = new AbortController();
    this.pump(runId, this.abort).catch(() => {});
    return true;
  }

  async pump(runId, ctl) {
    let ended = false;
    let streamed = '';
    try {
      const res = await this.call('GET', `/v1/runs/${runId}/events`, null, ctl.signal, 0);
      if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
      for await (const ev of this.watched(sseEvents(res.body))) {
        if (this.runId !== runId) return; // a newer turn took over
        const t = ev.event ?? ev.type;
        if (t === 'message.delta' && ev.delta) {
          streamed += ev.delta;
          this.emit('text', ev.delta);
        } else if (t === 'tool.started' && ev.tool) {
          const name = uiToolName(ev.tool);
          this.emit('working', name);
          if (!QUIET.has(ev.tool)) {
            const label = entryFor(name)?.label ?? name;
            const preview = String(ev.preview ?? '').trim();
            const summary = preview ? `${label}: ${preview}` : label;
            const step = { tool: name, summary: summary.slice(0, 200) };
            // Outward actions may be about to ask you: don't log "allowed" before you've answered.
            if (entryFor(name)?.outward) this.pending.push(step);
            else this.log?.add({ ...step, decision: 'allow', by: 'rule', via: 'hermes' });
          }
        } else if (t === 'tool.completed' && ev.tool) {
          // Finished without asking you: Hermes's own rules let it through.
          const i = this.pending.findIndex((s) => s.tool === uiToolName(ev.tool));
          if (i >= 0) this.log?.add({ ...this.pending.splice(i, 1)[0], decision: 'allow', by: 'rule', via: 'hermes' });
        } else if (t === 'approval.request') {
          this.onApproval(runId, ev, ctl.signal);
        } else if (TERMINAL.has(t)) {
          ended = true;
          this.onEnd(t, ev, streamed);
          break;
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
    }
    if (!ended && this.runId === runId && !ctl.signal.aborted) await this.settleFromStatus(runId, streamed);
  }

  // Ends the stream when Hermes has said nothing for `idleMs`, unless it is waiting for your answer on a card.
  async *watched(events) {
    const it = events[Symbol.asyncIterator]();
    try {
      for (;;) {
        let timer;
        const idle = new Promise((resolve) => {
          timer = setTimeout(() => resolve('idle'), this.idleMs);
          timer.unref?.();
        });
        const next = await Promise.race([it.next(), idle]);
        clearTimeout(timer);
        if (next === 'idle') {
          if (this.approvals.list().length) continue;
          return;
        }
        if (next.done) return;
        yield next.value;
      }
    } finally {
      it.return?.().catch?.(() => {});
    }
  }

  // The stream dropped before the run ended: ask Hermes how it went.
  async settleFromStatus(runId, streamed) {
    try {
      const res = await this.call('GET', `/v1/runs/${runId}`);
      const s = res.ok ? await res.json() : {};
      if (s.status === 'completed') return this.onEnd('run.completed', s, streamed);
      if (s.status === 'failed') return this.onEnd('run.failed', s, streamed);
    } catch {
      /* fall through */
    }
    this.fail('error', 'Lost the connection to Hermes before it finished. The task may still be running in Hermes.');
    this.finishTurn();
  }

  onApproval(runId, ev, signal) {
    const card = approvalCard(ev);
    const step = this.pending.pop(); // the action this card is about
    this.approvals.request(card, signal).then((choice) => {
      try {
      this.log?.add({ tool: step?.tool ?? card.tool, summary: card.summary.split('\n').slice(0, 2).join(' ').slice(0, 300), decision: choice === 'deny' ? 'deny' : 'allow', by: 'you', via: 'hermes' });
      if (signal.aborted && choice === 'deny') return; // the run is already over
      const body = { choice: choice === 'deny' ? 'deny' : 'once', ...(ev.request_id ? { request_id: ev.request_id } : {}) };
      this.call('POST', `/v1/runs/${runId}/approval`, body).catch(() => {
        /* Hermes fails closed on its own if no answer arrives */
      });
      } catch {
        /* a failed log write must not leave Hermes waiting; its own timeout denies */
      }
    }).catch(() => {});
  }

  onEnd(type, ev, streamed) {
    if (type === 'run.completed') {
      const text = (typeof ev.output === 'string' && ev.output.trim()) ? ev.output : streamed; // empty output must not wipe the streamed reply
      if (ev.usage) this.emit('usage', ev.usage);
      this.emit('done', { text, usage: ev.usage ?? null, runtime: servedBy(ev.runtime) });
    } else if (type === 'run.failed') {
      this.fail('error', `Hermes hit an error: ${ev.error ?? 'unknown error'}`);
    }
    // cancelled / interrupted: you stopped it, nothing to report
    this.finishTurn();
  }

  fail(kind, message) {
    this.emit('error', { kind, message });
  }

  finishTurn() {
    this.pending = [];
    this.abort?.abort();
    this.abort = null;
    this.runId = null;
    this.turn++;
    if (!this.busy) return;
    this.busy = false;
    this.emit('idle');
  }

  async interrupt() {
    this.approvals.denyAll();
    const runId = this.runId;
    if (runId) {
      try {
        await this.call('POST', `/v1/runs/${runId}/stop`, {}, null, 5000);
      } catch {
        /* already gone */
      }
    }
    // If the stopped run never reports back, don't leave the app stuck on "working".
    setTimeout(() => {
      if (this.busy && this.runId === runId) this.finishTurn();
    }, this.finishGraceMs).unref?.();
  }

  // Start a fresh conversation. Hermes's long-term memory is kept.
  async reset() {
    await this.interrupt();
    const wasBusy = this.busy;
    this.finishTurn(); // emits idle if a turn was running
    try {
      fs.unlinkSync(this.sessionFile);
    } catch {
      /* none saved */
    }
    if (!wasBusy) this.emit('idle');
  }

  shutdown() {
    this.approvals.denyAll();
    this.abort?.abort();
  }
}
