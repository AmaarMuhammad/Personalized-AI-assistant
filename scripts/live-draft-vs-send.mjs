// Live: "draft" must create a draft with no send card; "send" must raise the
// send card (auto-DENIED here, so nothing ever leaves). Prints tools + log lines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import keyring from '@napi-rs/keyring';
import { HermesBrain } from '../app/main/hermes-brain.js';
import { Approvals } from '../app/main/approvals.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-live-'));
const approvals = new Approvals({ timeoutMs: 60_000 });
const logged = [];
const brain = new HermesBrain({
  approvals, dataDir, log: { add: (e) => logged.push(e) },
  getKey: () => new keyring.Entry('Jarvis', 'hermes-api').getPassword(),
});
const tools = [];
const cards = [];
brain.on('working', (t) => tools.push(t));
brain.on('error', (e) => console.log('  ERROR', e.kind, e.message));
approvals.on('request', (c) => { cards.push(c.spoken); approvals.answer(c.id, 'deny'); });

const turn = (text, opts) => new Promise((resolve) => {
  let out = null;
  tools.length = 0; cards.length = 0; logged.length = 0;
  brain.once('done', (d) => (out = d.text));
  brain.once('idle', () => resolve(out));
  brain.send(text, opts);
});
const show = (n, out) => {
  console.log(`${n}: ${String(out).slice(0, 220)}`);
  console.log('   tools:', tools.filter((t) => /gmail|google/.test(t)).join(', ') || '(none)');
  console.log('   cards:', cards.length ? cards.join(' | ') : '(none)');
  console.log('   log  :', logged.filter((e) => /gmail|google/.test(e.tool)).map((e) => `${e.tool} ${e.decision} by ${e.by}`).join('; ') || '(none)');
};

show('DRAFT', await turn('Draft me an email to probe@example.com saying the Jarvis live test passed. Subject: Jarvis draft test.', { spoken: true }));
show('SEND ', await turn('Now send an email to probe@example.com, subject "Jarvis send test", body "probe".', { spoken: true }));
process.exit(0);
