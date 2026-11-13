// Live check of HermesBrain against the real local Hermes: two turns in one
// session (memory carries over), then an outward tool whose approval card is DENIED.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import keyring from '@napi-rs/keyring';
import { HermesBrain } from '../app/main/hermes-brain.js';
import { Approvals } from '../app/main/approvals.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-live-'));
const approvals = new Approvals({ timeoutMs: 60_000 });
const brain = new HermesBrain({ approvals, dataDir, getKey: () => new keyring.Entry('Jarvis', 'hermes-api').getPassword() });
brain.on('working', (t) => console.log('  working:', t));
brain.on('error', (e) => console.log('  ERROR', e.kind, e.message));
approvals.on('request', (c) => {
  console.log('  CARD:', c.tool, '|', c.spoken, '| canAlways', c.canAlways);
  approvals.answer(c.id, 'deny');
});

const turn = (text, opts) => new Promise((resolve) => {
  let out = null;
  brain.once('done', (d) => (out = d.text));
  brain.once('idle', () => resolve(out));
  brain.send(text, opts);
});

console.log('1:', await turn('Remember this word for this chat: tamarind. Reply only OK.'));
console.log('2:', await turn('Which word did I ask you to remember? One word.', { spoken: true }));
console.log('3:', await turn('Send an email to probe@example.com, subject "probe", body "probe". Call gmail_send now without asking me in chat.'));
console.log('session file:', fs.readFileSync(path.join(dataDir, 'hermes-session.json'), 'utf8'));
process.exit(0);
