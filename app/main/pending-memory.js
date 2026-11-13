// Memory writes waiting for your OK.
//
// With memory.write_approval on, Hermes doesn't save a new fact straight away. It stages it as
// hermes\pending\memory\<id>.json, from a Jarvis chat, a Discord chat or its background learner,
// and nothing reaches USER.md / MEMORY.md until someone approves it. Saying "yes" in a chat
// is not approval. This module lists that queue for the Memory page.
//
// Listing reads the JSON files directly. Approve and reject go through Hermes's own code
// (hermes_cli.write_approval_commands, the same path as typing /memory approve <id>), so
// Hermes's character limits and replace/remove rules still apply and Jarvis never writes
// memory around the approval step. Only the Memory page can call this; it is not a tool
// Hermes can use.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Hermes ids are uuid4().hex[:8]. Anything else is refused before it gets near a file path.
const ID = /^[0-9a-f]{8}$/;

const TARGETS = { user: 'About you', memory: 'Hermes notes' };
const ORIGINS = {
  background_review: 'Hermes noticed this on its own',
  assistant_tool: 'Asked for in a chat',
  foreground: 'Asked for in a chat',
};

// Runs inside Hermes's Python. argv: verb, id. Prints one JSON line.
const BRIDGE = `
import json, os, sys
sys.path.insert(0, os.environ['JARVIS_HERMES_AGENT'])
# Hermes's start-up finds its installed packages through the install's own home. The queue and
# memory files are then read from HERMES_HOME (only the tests point that somewhere else).
target = os.environ['HERMES_HOME']
os.environ['HERMES_HOME'] = os.environ.get('JARVIS_HERMES_INSTALL_HOME') or target
import hermes_bootstrap  # noqa: F401
os.environ['HERMES_HOME'] = target
from hermes_cli.write_approval_commands import handle_pending_subcommand
from tools import write_approval as wa
from tools.memory_tool import load_on_disk_store
verb, pid = sys.argv[1], sys.argv[2]
store = load_on_disk_store() if verb == 'approve' else None
out = handle_pending_subcommand(wa.MEMORY, [verb, pid], memory_store=store)
print(json.dumps({'out': out, 'pending': wa.get_pending(wa.MEMORY, pid) is not None}))
`;

export function findHermesPython(installDir) {
  try {
    const tools = path.join(installDir, 'tools');
    const dir = fs.readdirSync(tools).filter((d) => /^python-/i.test(d)).sort().pop();
    const exe = dir && path.join(tools, dir, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    return exe && fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

const opsOf = (payload) => {
  const p = payload ?? {};
  const list = p.action === 'batch' && Array.isArray(p.operations) ? p.operations : [p];
  return list.map((op) => ({
    action: String(op.action ?? ''),
    text: String(op.content ?? ''),
    // What a replace/remove will change. Hermes pins the whole entry; old_text is only the search.
    replaces: String(op.matched_entry ?? op.old_text ?? ''),
  }));
};

export class PendingMemory extends EventEmitter {
  // hermesHome: where Hermes keeps its data (pending\, memories\).
  // installDir: where Hermes's code and Python live. Usually the same folder.
  // run(args, env): for tests; defaults to Hermes's own Python.
  constructor({ hermesHome, installDir = hermesHome, run } = {}) {
    super();
    this.hermesHome = hermesHome;
    this.installDir = installDir;
    this.dir = path.join(hermesHome, 'pending', 'memory');
    this.run = run ?? ((args, env) => this.runPython(args, env));
  }

  list() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const items = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8').replace(/^\uFEFF/, ''));
        if (!r || typeof r !== 'object' || !ID.test(String(r.id)) || `${r.id}.json` !== f) continue;
        const target = r.payload?.target;
        items.push({
          id: r.id,
          section: TARGETS[target] ?? String(target ?? ''),
          origin: ORIGINS[r.origin] ?? 'Asked for in a chat',
          auto: r.origin === 'background_review',
          created: Number.isFinite(r.created_at) ? new Date(r.created_at * 1000).toISOString() : '',
          ops: opsOf(r.payload),
        });
      } catch {
        /* a half-written or foreign file: skip it, Hermes will report it itself */
      }
    }
    return items.sort((a, b) => (b.created > a.created ? 1 : b.created < a.created ? -1 : 0));
  }

  count() {
    return this.list().length;
  }

  approve(id) {
    return this.decide('approve', id);
  }

  reject(id) {
    return this.decide('reject', id);
  }

  async decide(verb, id) {
    const pid = String(id ?? '');
    if (!ID.test(pid)) return { ok: false, message: 'That isn’t a pending memory id.' };
    if (!fs.existsSync(path.join(this.dir, `${pid}.json`))) return { ok: false, message: 'That item is no longer waiting. It was already approved or rejected.' };
    let res;
    try {
      const stdout = await this.run([verb, pid], { JARVIS_HERMES_AGENT: path.join(this.installDir, 'hermes-agent'), JARVIS_HERMES_INSTALL_HOME: this.installDir, HERMES_HOME: this.hermesHome });
      const line = String(stdout).trim().split(/\r?\n/).pop();
      res = JSON.parse(line);
    } catch (e) {
      return { ok: false, message: `Hermes couldn’t do that: ${String(e?.message ?? e).slice(0, 300)}` };
    }
    // The file going away is the only proof it worked; Hermes deletes it only on success.
    const ok = !res.pending;
    if (ok) this.emit('change', { verb, id: pid });
    return { ok, message: String(res.out ?? '') };
  }

  runPython(args, env) {
    const python = findHermesPython(this.installDir);
    if (!python) return Promise.reject(new Error('Hermes’s Python was not found.'));
    return new Promise((resolve, reject) => {
      execFile(
        python,
        ['-I', '-c', BRIDGE, ...args],
        { cwd: this.hermesHome, env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' }, timeout: 60_000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop())) : resolve(stdout)),
      );
    });
  }
}
