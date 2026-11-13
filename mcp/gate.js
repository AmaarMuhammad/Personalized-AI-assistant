// Trust gate for Jarvis's standalone MCP servers (used by Hermes).
//
// The servers enforce their own safety, so it holds whichever model or app
// calls them. Approvals go back to the caller as an MCP elicitation, which
// Hermes shows as its normal approval prompt.
//
// Rules:
// - Outward actions (send, invite, change a shared event, cancel) always ask.
// - Reading mail or calendar text marks the session "untrusted": somebody else
//   wrote it. From then on, local writes (drafts, own events) ask too.
// - The mark lives in a file shared by every Jarvis MCP server, so an email
//   read by one server also makes the desktop tools careful. It expires after
//   `ttlMs` (an MCP server can't see when you start a new chat).
// - Unknown tools ask. No answer, an error, or a client that can't ask = deny.

import fs from 'node:fs';
import path from 'node:path';

export const KINDS = {
  READ: 'read', // no outside text comes back
  UNTRUSTED_READ: 'untrusted-read', // returns text someone else wrote
  LOCAL: 'local', // changes only the user's own things
  OUTWARD: 'outward', // reaches other people; always asks
  ALWAYS_ASK: 'always-ask', // risky on this PC (e.g. runs a downloaded program); always asks
};

export function defaultStateDir() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.HOME || '.', '.local', 'share');
  return path.join(base, 'Jarvis', 'hermes-mcp');
}

export class McpGate {
  constructor({ policy, describe = () => '', stateDir = defaultStateDir(), ttlMs = 2 * 60 * 60_000, now = Date.now }) {
    Object.assign(this, { policy, describe, ttlMs, now });
    fs.mkdirSync(stateDir, { recursive: true });
    this.taintFile = path.join(stateDir, 'taint.json');
    this.logFile = path.join(stateDir, 'activity.jsonl');
  }

  // ---------- the shared "has read outside content" mark ----------

  untrusted() {
    let raw;
    try {
      raw = fs.readFileSync(this.taintFile, 'utf8');
    } catch (e) {
      return e.code !== 'ENOENT'; // no file = nothing read yet; a file we can't read = be careful
    }
    try {
      const { at } = JSON.parse(raw);
      return !Number.isFinite(at) || this.now() - at < this.ttlMs;
    } catch {
      return true; // a damaged mark must not read as "clean"
    }
  }

  markUntrusted(source) {
    fs.writeFileSync(this.taintFile, JSON.stringify({ at: this.now(), source }));
  }

  clear() {
    fs.rmSync(this.taintFile, { force: true });
  }

  // ---------- decisions ----------

  // A policy entry is a kind, or a function of the call's arguments returning
  // a kind or { kind, reason } (e.g. "a program you downloaded" always asks).
  kindOf(name, args) {
    const p = this.policy[name];
    const v = typeof p === 'function' ? p(args ?? {}) : p;
    return typeof v === 'object' && v ? v : { kind: v };
  }

  // { level: 'auto' | 'ask', reason }
  evaluate(name, args) {
    const { kind, reason } = this.kindOf(name, args);
    if (!kind) return { level: 'ask', reason: 'it is a tool I have no rule for' };
    if (kind === KINDS.ALWAYS_ASK) return { level: 'ask', reason: reason || 'it is risky' };
    if (kind === KINDS.OUTWARD) return { level: 'ask', reason: 'it reaches other people' };
    if (kind === KINDS.LOCAL && this.untrusted()) {
      return { level: 'ask', reason: 'this chat has read text someone else wrote (an email, event, the screen or the clipboard), so the idea may not be yours' };
    }
    return { level: 'auto', reason: '' };
  }

  log(row) {
    // Tool name and decision only: never message text or addresses.
    try {
      fs.appendFileSync(this.logFile, JSON.stringify({ at: new Date(this.now()).toISOString(), ...row }) + '\n');
    } catch {
      /* logging must never block a decision */
    }
  }

  // Wraps a tool handler. `ask(message)` must resolve to 'accept' | 'decline' | 'cancel'.
  wrap(name, handler, ask) {
    return async (args, extra) => {
      const v = this.evaluate(name, args);
      if (v.level === 'ask') {
        const message = `${this.describe(name, args) || `Use the tool ${name}`}?\n(Asking because ${v.reason}.)`;
        let answer = 'cancel';
        try {
          answer = await ask(message, extra);
        } catch {
          answer = 'cancel';
        }
        this.log({ tool: name, decision: answer === 'accept' ? 'allowed' : 'denied', by: 'user', reason: v.reason });
        if (answer !== 'accept') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'The user did not approve this, so nothing was done. Do not retry it or try to get the same result another way; tell the user and ask what they want.' }],
          };
        }
      } else {
        this.log({ tool: name, decision: 'allowed', by: 'rule' });
      }
      const result = await handler(args, extra);
      if (this.kindOf(name, args).kind === KINDS.UNTRUSTED_READ && !result?.isError) this.markUntrusted(name);
      return result;
    };
  }
}
