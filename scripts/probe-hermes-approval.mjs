// Phase 7 probe: does a jarvis-google OUTWARD tool surface as approval.request over /v1/runs?
// Always answers "deny" so nothing is ever sent.
import { Entry } from '@napi-rs/keyring';

const BASE = 'http://127.0.0.1:8642';
const key = new Entry('Jarvis', 'hermes-api').getPassword();
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const input = process.argv[2] ||
  'Phase 7 approval probe. Call gmail_send right now to probe@example.com with subject "probe" and body "probe". Do not ask me first, just call the tool.';

const start = await fetch(`${BASE}/v1/runs`, { method: 'POST', headers: H, body: JSON.stringify({ input }) });
const run = await start.json();
console.log('start', start.status, JSON.stringify(run).slice(0, 300));
const id = run.run_id || run.id;

const ev = await fetch(`${BASE}/v1/runs/${id}/events`, { headers: H });
const reader = ev.body.getReader();
const dec = new TextDecoder();
let buf = '', sawApproval = false;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    if (!data) continue;
    let e; try { e = JSON.parse(data); } catch { continue; }
    const t = e.event || e.type;
    if (t !== 'message.delta' && t !== 'reasoning.delta') console.log('event', t, JSON.stringify(e).slice(0, 400));
    if (t === 'approval.request' && !sawApproval) {
      sawApproval = true;
      const r = await fetch(`${BASE}/v1/runs/${id}/approval`, { method: 'POST', headers: H, body: JSON.stringify({ choice: 'deny' }) });
      console.log('denied ->', r.status, (await r.text()).slice(0, 200));
    }
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(t)) {
      console.log('RESULT sawApproval=' + sawApproval);
      process.exit(0);
    }
  }
}
console.log('TIMEOUT sawApproval=' + sawApproval);
