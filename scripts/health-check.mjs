// Prints what is broken, one line each, or nothing when all is well. No model involved.
// Used by the briefing's pre-run script so a problem heads the briefing on your phone.
// Run: node scripts/health-check.mjs [--all]
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import keyring from '@napi-rs/keyring';
import { checkHealth, problems } from '../app/main/health.js';

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hermesHome = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
const googleConnected = () => {
  try {
    return !!JSON.parse(new keyring.Entry('Jarvis', 'google').getPassword() || '{}').refreshToken;
  } catch {
    return false;
  }
};
const results = await checkHealth({ hermesHome, repoDir, googleConnected });
const show = process.argv.includes('--all') ? results : problems(results);
for (const r of show) console.log(`${r.ok ? 'OK     ' : 'PROBLEM'} ${r.id}: ${r.ok ? 'fine' : r.message}`);
