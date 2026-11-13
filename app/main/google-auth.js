// Signing in to Google for Gmail and Calendar, with Google's free APIs.
//
// You create one OAuth "Desktop app" client in Google Cloud (free, no
// billing) and give Jarvis its JSON file. Jarvis then runs Google's standard
// desktop sign-in: your browser shows Google's own consent page and sends the
// answer back to a one-off listener on 127.0.0.1.
//
// Lessons applied (OpenJarvis had a localhost server with no auth and no Host
// check, so DNS rebinding worked):
// - The listener exists only while you are signing in (5 minutes at most),
//   binds to 127.0.0.1 only, and answers exactly one path.
// - It checks the Host header and a random `state` value, and uses PKCE, so
//   another web page or program can't inject or steal the sign-in.
// - The client secret and refresh token live in Windows Credential Manager,
//   never in a plain file. The access token lives only in memory.

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', // search and read mail
  'https://www.googleapis.com/auth/gmail.compose', // drafts and sending
  'https://www.googleapis.com/auth/calendar.events', // read and create events
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export class GoogleAuthError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.kind = kind; // 'not-connected' | 'expired' | 'error'
  }
}

// The JSON file Google Cloud gives you for a "Desktop app" client.
export function parseClientFile(text) {
  let j;
  try {
    j = JSON.parse(String(text));
  } catch {
    throw new GoogleAuthError('That file isn’t a Google client file (it isn’t valid JSON).');
  }
  if (j?.web) throw new GoogleAuthError('This is a "Web application" client. Create a "Desktop app" client instead and choose its file.');
  const c = j?.installed;
  if (!c?.client_id || !c?.client_secret) throw new GoogleAuthError('That file isn’t a Google "Desktop app" client file.');
  return { clientId: String(c.client_id), clientSecret: String(c.client_secret) };
}

// Saves one small JSON blob in Windows Credential Manager.
export function keyringStore(Entry, service = 'Jarvis', account = 'google') {
  const entry = new Entry(service, account);
  return {
    get() {
      try {
        const s = entry.getPassword();
        return s ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    },
    set(value) {
      entry.setPassword(JSON.stringify(value));
    },
    clear() {
      try {
        entry.deletePassword();
      } catch {
        /* nothing saved */
      }
    },
  };
}

// For tests and development: keeps the blob in memory.
export function memoryStore(initial = null) {
  let v = initial;
  return { get: () => v, set: (x) => (v = x), clear: () => (v = null) };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export class GoogleAuth extends EventEmitter {
  constructor({ store, fetchFn = globalThis.fetch, openExternal, timeoutMs = 5 * 60_000 }) {
    super();
    Object.assign(this, { store, fetchFn, openExternal, timeoutMs });
    this.access = null; // { token, expires }
    this.pending = null; // sign-in in progress
  }

  status() {
    const s = this.store.get() ?? {};
    return { hasClient: !!s.clientId, connected: !!s.refreshToken, email: s.email ?? '', signingIn: !!this.pending };
  }

  setClient(text) {
    const client = parseClientFile(text);
    const old = this.store.get() ?? {};
    // A different client can't use the old sign-in.
    const keep = old.clientId === client.clientId ? { refreshToken: old.refreshToken, email: old.email } : {};
    this.store.set({ ...client, ...keep });
    this.access = null;
    this.emit('change', this.status());
    return this.status();
  }

  setEmail(email) {
    const s = this.store.get();
    if (s) this.store.set({ ...s, email: String(email ?? '') });
    this.emit('change', this.status());
  }

  // Runs Google's desktop sign-in. Resolves once you've approved in the browser.
  async connect() {
    const s = this.store.get();
    if (!s?.clientId) throw new GoogleAuthError('Choose your Google client file first.', 'not-connected');
    if (this.pending) return this.pending;
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    this.pending = new Promise((resolve, reject) => {
      let finished = false;
      let port = 0;
      const server = http.createServer((req, res) => {
        const done = (code, text) => {
          res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Jarvis</title><body style="font-family:Segoe UI,sans-serif;padding:3em"><h2>${text}</h2></body>`);
        };
        if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}`) return done(400, 'Not allowed.');
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== '/' || url.searchParams.get('state') !== state) return done(400, 'Not allowed.');
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error) {
          done(200, 'Sign-in was cancelled. You can close this tab.');
          return finish(new GoogleAuthError(error === 'access_denied' ? 'You cancelled the Google sign-in.' : `Google sign-in failed: ${error}`));
        }
        if (!code) return done(400, 'Not allowed.');
        done(200, 'Jarvis is connected to Google. You can close this tab.');
        this.exchange(code, verifier, `http://127.0.0.1:${port}`).then(() => finish(null), finish);
      });
      const timer = setTimeout(() => finish(new GoogleAuthError('The Google sign-in timed out. Try again.')), this.timeoutMs);
      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        server.close();
        server.closeAllConnections?.();
        this.pending = null;
        this.emit('change', this.status());
        err ? reject(err) : resolve(this.status());
      };
      server.on('error', (e) => finish(new GoogleAuthError(`Couldn’t start the sign-in: ${e.message}`)));
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        const q = new URLSearchParams({
          client_id: s.clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: SCOPES.join(' '),
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent', // always hand back a refresh token
        });
        this.authUrl = `${AUTH_URL}?${q}`;
        this.emit('change', this.status());
        Promise.resolve(this.openExternal(this.authUrl)).catch((e) => finish(new GoogleAuthError(`Couldn’t open the browser: ${e.message}`)));
      });
    });
    return this.pending;
  }

  async exchange(code, verifier, redirectUri) {
    const s = this.store.get();
    const t = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: s.clientId,
      client_secret: s.clientSecret,
    });
    if (!t.refresh_token) throw new GoogleAuthError('Google didn’t return a lasting sign-in. Disconnect Jarvis in your Google account settings and try again.');
    const granted = String(t.scope ?? '').split(' ');
    const missing = SCOPES.filter((x) => !granted.includes(x));
    if (missing.length) {
      throw new GoogleAuthError('Some permissions were left unticked on Google’s page. Connect again and tick all the boxes so Jarvis can read mail, write drafts and use your calendar.');
    }
    this.store.set({ ...s, refreshToken: t.refresh_token });
    this.access = { token: t.access_token, expires: Date.now() + (t.expires_in ?? 3600) * 1000 };
  }

  async tokenRequest(params) {
    let res;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    } catch (e) {
      throw new GoogleAuthError(`Couldn’t reach Google: ${e.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'invalid_grant') {
        throw new GoogleAuthError('Jarvis’s access to your Google account has expired or was removed. Reconnect it in Settings.', 'expired');
      }
      throw new GoogleAuthError(`Google sign-in error: ${body.error_description || body.error || res.status}`);
    }
    return body;
  }

  // A valid access token, refreshed when needed.
  async accessToken({ force = false } = {}) {
    if (!force && this.access && this.access.expires - 60_000 > Date.now()) return this.access.token;
    const s = this.store.get();
    if (!s?.refreshToken) throw new GoogleAuthError('Google isn’t connected yet. Connect it in Settings → Google account.', 'not-connected');
    try {
      const t = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: s.refreshToken,
        client_id: s.clientId,
        client_secret: s.clientSecret,
      });
      this.access = { token: t.access_token, expires: Date.now() + (t.expires_in ?? 3600) * 1000 };
      return this.access.token;
    } catch (e) {
      if (e.kind === 'expired') {
        this.store.set({ clientId: s.clientId, clientSecret: s.clientSecret });
        this.access = null;
        this.emit('change', this.status());
      }
      throw e;
    }
  }

  // Signs out and asks Google to cancel Jarvis's access. The client file is kept.
  async disconnect() {
    const s = this.store.get();
    if (s?.refreshToken) {
      try {
        await this.fetchFn(`${REVOKE_URL}?token=${encodeURIComponent(s.refreshToken)}`, { method: 'POST' });
      } catch {
        /* offline: the local sign-in is removed anyway */
      }
    }
    if (s?.clientId) this.store.set({ clientId: s.clientId, clientSecret: s.clientSecret });
    this.access = null;
    this.emit('change', this.status());
    return this.status();
  }
}
