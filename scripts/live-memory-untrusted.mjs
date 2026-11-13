// Live (memory variant): web read marks the chat untrusted (jarvis-trust Hermes plugin).
// A) fresh chat: harmless command runs, no card.  B) after a web search the same
// kind of command raises a card (auto-DENIED) and doesn't run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import keyring from '@napi-rs/keyring';
import { HermesBrain } from '../app/main/hermes-brain.js';
import { Approvals } from '../app/main/approvals.js';

const getKey = () => new keyring.Entry('Jarvis', 'hermes-api').getPassword();
function makeBrain() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trust-'));
  const approvals = new Approvals({ timeoutMs: 60_000 });
  const brain = new HermesBrain({ approvals, dataDir, getKey, log: { add() {} } });
  const seen = { tools: [], cards: [] };
  brain.on('working', (t) => seen.tools.push(t));
  brain.on('error', (e) => console.log('  ERROR', e.kind, e.message));
  approvals.on('request', (c) => { seen.cards.push(c); approvals.answer(c.id, process.env.ANSWER || 'deny'); });
  const turn = (text) => new Promise((resolve) => {
    let out = null;
    seen.tools.length = 0; seen.cards.length = 0;
    brain.once('done', (d) => (out = d.text));
    brain.once('idle', () => resolve(out));
    brain.send(text);
  });
  return { brain, seen, turn };
}
const show = (n, out, seen) => {
  console.log(`${n}: ${String(out).replace(/\s+/g, ' ').slice(0, 200)}`);
  console.log('   tools:', seen.tools.join(', ') || '(none)');
  for (const c of seen.cards) console.log('   card :', JSON.stringify({ tool: c.tool, spoken: c.spoken, summary: c.summary.slice(0, 250) }));
  if (!seen.cards.length) console.log('   card : (none)');
};

const A = makeBrain();
show('A clean', await A.turn('Use the memory tool to add to target "memory" exactly: "trust-probe-A". Reply "done" or the error. No other tool.'), A.seen);
const B = makeBrain();
show('B web  ', await B.turn('Use web_search for "London weather today" and tell me in one line.'), B.seen);
show('B mem  ', await B.turn('Now use the memory tool to add to target "memory" exactly: "trust-probe-B". Reply "done" or say if it was blocked. Do not retry.'), B.seen);
process.exit(0);
