# Jarvis: project context

Read this first. It describes what runs today. History and decisions live in the owner's
notes vault, not here.

## What this is
A personal assistant for the owner's Windows 11 PC, in two parts:
- **Hermes** is the brain: it runs every conversation, tool, schedule and memory, and serves the desk and the phone (Discord). It lives in `%LOCALAPPDATA%\hermes` and is not in this repo.
- **Jarvis** (this repo) is the desk face: voice in and out, the orb and dashboard, approval cards, the Memory page. It thinks about nothing; it calls Hermes's local API on `127.0.0.1:8642`.
- This repo also holds the pieces of Hermes that are ours: two MCP servers (`mcp/`) and the safety plugin (`hermes-plugins/jarvis-trust`).

**Standing constraints**
- Free only: nothing beyond the Claude Pro subscription. No paid APIs, no card on file.
- Models: Claude is the brain. If Claude is unavailable, the local Qwen model answers. No other providers (owner's decision, Nov 11 2026).
- Privacy: mail, memory and personal files never go to a free-tier cloud model.
- Outward actions always need the owner's approval, from every entry point.
- Done means run and observed, not "should work".

## Architecture
```
app/main/main.js            window, tray, hotkeys, IPC (every handler checks the sender is our own page)
app/main/hermes-brain.js    client for Hermes /v1/runs + its event stream; approvals -> cards; which model answered
app/main/health.js          plain checks, no model: gateway, Claude sign-in, Google, local model, safety plugin
app/main/hermes-memory.js   Memory page: reads and edits Hermes's USER.md / MEMORY.md, 30 days of history
app/main/pending-memory.js  memory writes Hermes staged for approval (memory.write_approval)
app/main/approvals.js       pending Approve/Deny cards; timeout, cancel or close = deny
app/main/chats.js, transcript.js   the current chat and the archive, with markdown copies in the vault folder
app/main/dashboard.js       calendar and mail cards, straight from Google REST (no model)
app/main/google-auth.js     Google OAuth (loopback, PKCE), token in Windows Credential Manager
app/main/backup.js          daily JSON backup: chats, settings, and Hermes's memory, SOUL.md, config.yaml, cron jobs
app/main/policy.js          labels for the Activity log only; decides nothing
app/main/{settings,activity-log,speech,voice}.js
app/tools/google-tools.js   Gmail/Calendar tool definitions, served to Hermes by mcp/google-server.js
app/voice/engine.js, worker.js   Whisper (hear), Kokoro (English), Piper (Urdu), in a utilityProcess
app/ui/                     index.html, styles.css, app.js, markdown.js (DOM-built, never innerHTML)
mcp/google-server.js        Gmail + Calendar for Hermes (11 tools)
mcp/desktop-server.js       open app/URL/path, screenshot, clipboard, notify (7 tools)
mcp/gate.js                 trust gate inside both MCP servers
hermes-plugins/jarvis-trust the "careful after outside text" rule for Hermes's own tools
scripts/                    live probes (live-*.mjs), game-mode watcher, health-check, briefing catch-up
```
Hermes's API key is in Credential Manager (`Jarvis` / `hermes-api`); the Google token is `Jarvis` / `google`.

## Safety model (keep these invariants)
Safety is enforced where the action happens, not in the Electron app.

1. **Outward actions always ask** (`mcp/gate.js`): send email, invite, change or cancel an event with other people, open a downloaded program. No "always allow". No answer, an error, or a caller that can't ask = deny.
2. **Outside text marks the chat** (`jarvis-trust`): web and browser tools, mail, calendar, screen, clipboard, a terminal command that fetches from the network, files under Downloads or `Vault\Chats`.
3. **A marked chat asks by default.** Every tool asks except the short `SAFE` list in the plugin. A tool the plugin has never heard of asks. Never turn this back into a list of guarded tools.
4. **The mark lasts as long as the session.** The text stays in the chat, so the caution does too. Do not add an expiry. (The shared `taint.json` the MCP gate reads still expires after 2 h; the plugin refreshes it while a marked session keeps using Jarvis tools.)
5. **Link rule.** Once a marked chat has also read private content (mail, files, command output), web lookups ask too: a query or URL can carry that content out.
6. **Own files always ask.** Writing to the Hermes home, `%LOCALAPPDATA%\Jarvis`, `%APPDATA%\Jarvis` or this repo asks, marked or not.
7. **Unreadable state = careful.** A damaged mark file means "marked", in the plugin and in the MCP gate.
8. **Memory changes need approval.** Hermes stages them (`memory.write_approval: true`); the Memory page approves or rejects. In a marked chat the plugin asks before the write is even staged.
9. **Calendar changes check the event first.** Update and cancel take `event_id` plus `current_title`; the handler refuses if the title differs or someone else organised it.
10. **The window is locked down.** contextIsolation and sandbox on, strict CSP, no navigation, links open in the browser, every IPC handler validates the sender. The mic is allowed only for our own page, audio only. Voice never approves anything.
11. **Scope of the plugin.** Sessions whose id starts `jarvis_` (the desk) and messaging surfaces (Discord). The Hermes desktop chat, where the owner watches each step, is not covered.

State files: `%LOCALAPPDATA%\Jarvis\hermes-mcp\` holds `taint.json`, `trust-sessions.json` and the MCP `activity.jsonl`.

**After changing the plugin:** copy `hermes-plugins/jarvis-trust/__init__.py` to `%LOCALAPPDATA%\hermes\plugins\jarvis-trust\`, run `hermes gateway restart`, then run the live probes. The health check reports a version mismatch.

**When changing safety behaviour:** add or adjust a test in `tests/trust_plugin_test.py` or `tests/mcp-*.test.js`, and prove the test fails without the rule (mutation check).

## Health and reliability
- `health.js` runs 45 s after start and every 30 min; Settings shows the result. A new problem raises a desktop notification and a note in the chat. `scripts/health-check.mjs` prints the same for the briefing pre-run script.
- The brain reports which model answered (`run.completed.runtime`). When it is not Claude, the app shows an amber badge, adds a note, and says so on a spoken turn.
- Requests to Hermes time out (30 s); a silent event stream is settled from the run status after 10 min unless a card is waiting; a gateway still starting at login is waited for (20 s).
- The 5 pm briefing and reminders are Hermes cron jobs. `scripts/briefing-catchup.ps1` (Startup folder) runs today's briefing if the PC came on too late for Hermes's own 2-hour grace.
- **Known limits:** Hermes drops a one-off job that is more than 120 s late (`ONESHOT_GRACE_SECONDS`), so a reminder set for a time the PC is off never fires. With the PC off there is no assistant at all, including on the phone.
- `scripts/game-mode.ps1` stops the local model while a game runs; Hermes side jobs then fall back to Claude.

## Data locations
- `%APPDATA%\Jarvis\`: settings.json, activity.jsonl, chat.json, hermes-session.json, chats\, memory-history\, models\ (speech).
- `%LOCALAPPDATA%\hermes\`: Hermes itself: config.yaml, SOUL.md, memories\USER.md and MEMORY.md, pending\memory\, cron\, logs\, state.db, plugins\.
- Backups: `Documents\Jarvis Backups` (OneDrive on this PC), newest 10. Restore puts memory back in place and sets Hermes's other files aside in `%APPDATA%\Jarvis\hermes-restore\` for copying by hand. Keys and sign-ins are never backed up.
- Vault copy (readable markdown): `%USERPROFILE%\Jarvis Workspace\Vault`.
- Voice debug captures (when `JARVIS_VOICE_DEBUG=1`): `JARVIS_VOICE_DEBUG_DIR`.

## Voice
- Hearing: Whisper large-v3-turbo (onnx-community, fp16), encoder on DirectML, decoder on CPU, CPU-only fallback. English speech: Kokoro. Urdu speech: Piper ur_PK. Models are pinned, sha256-verified, in `%APPDATA%\Jarvis\models`.
- transformers.js does not detect language; `detectLanguage()` compares the first-token logits for English against Urdu/Hindi.
- Push-to-talk on Ctrl+Alt+Space or the mic button. Recording ends after about 3 s of silence. Conversation mode reopens the mic after a spoken reply.
- `isNoiseTranscript` drops filler and Whisper's silence hallucinations.
- Measure changes with `scripts/voice-eval.mjs` against the saved recordings, not by ear.

## Tests
- `npm test`: Node tests in `tests/*.test.js`, then the plugin's Python tests (`tests/trust_plugin_test.py`).
- `npm run smoke`: the real Electron app against a fake Hermes, fake Google, fake mic and fake voice engine. Run a few seconds apart, and not while the real Jarvis is busy. From a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first.
- Live probes (`scripts/live-*.mjs`) need the real gateway and the API key; `live-draft-vs-send.mjs` creates a real Gmail draft; `live-memory-untrusted.mjs` leaves one item in the memory approval queue.

## Conventions
- Plain JavaScript ESM, no build step. Electron, `@modelcontextprotocol/sdk` and `@napi-rs/keyring` are pinned.
- `.cmd`, `.ps1` and `.vbs` files: CRLF, ASCII only.
- Scripts with apostrophes or regexes go in a file, not a shell heredoc.
- Changes outside this repo that persist (Startup folder, registry, Hermes's files) go in a script the owner runs: `scripts/install-system-hooks.ps1`.
- UI: neumorphic black and white; the orb is the only colour, one hue per state, amber for "needs you". Copy is plain, sentence case.
- Google OAuth app is in Testing, so the sign-in can lapse; the health check reports it and Settings has Reconnect.
