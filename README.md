# Jarvis: the desk face of your personal assistant

Your assistant has two parts. **Hermes** is the brain: it holds the conversation, the memory, the schedule and the tools, and it also answers you on Discord. **Jarvis**, this app, is the part on your desk: you talk to it, it shows your day, and it asks for your OK when something needs it.

It costs nothing beyond your Claude Pro subscription. Claude does the thinking. If Claude can't be reached, a small model on your own PC answers instead, and Jarvis tells you when that happens.

**What you can do with it**
- **Talk or type**, in English or Urdu. It answers out loud. Speech runs on your PC.
- **Email and calendar:** search, read and summarise Gmail, draft replies, send (it always asks first), read your calendar, find free time, add and change events.
- **Your PC:** open apps, files and websites, look at the screen, use the clipboard, run commands, find and edit files.
- **Research:** search the web, read pages, compare options.
- **Reminders and a daily briefing** on your phone through Discord, at 5 pm.
- **Memory:** it remembers what you tell it, only after you approve each item on the Memory page.

## Install (one time)

Jarvis needs Hermes installed and running first, with its API server on (`127.0.0.1:8642`) and the key saved in Windows Credential Manager as `Jarvis` / `hermes-api`.

1. **Install Node.js** (the LTS version from [nodejs.org](https://nodejs.org/en/download)).
2. **Double-click `setup.cmd`.** It checks Node.js, installs Jarvis, and adds shortcuts to the Start menu and desktop.
3. **Register Jarvis's tools with Hermes.** In Hermes's `config.yaml`, under `mcp_servers`, add `jarvis-google` (`node <this folder>/mcp/google-server.js`) and `jarvis-desktop` (`node <this folder>/mcp/desktop-server.js`), both with `elicitation: enabled: true`.
4. **Install the safety plugin.** Copy `hermes-plugins\jarvis-trust` into `%LOCALAPPDATA%\hermes\plugins\`, add `jarvis-trust` under `plugins: enabled:` in `config.yaml`, and run `hermes gateway restart`.
5. **Run `scripts\install-system-hooks.ps1` once.** It adds the health check to the briefing and the briefing catch-up to your Startup folder.
6. Start Jarvis from the Start menu, or press **Ctrl+Space**. In **Settings**, "Is everything working?" should show every line as working.

## Connect Gmail and Google Calendar (one time, about 10 minutes)

Jarvis uses Google's free Gmail and Calendar APIs. You create a private "key" for it in Google Cloud. It's free, and you don't need a billing account or card.

1. Open [console.cloud.google.com](https://console.cloud.google.com) and sign in with the Gmail account Jarvis should use. Accept the terms if asked.
2. **Make a project.** Click the project picker at the top-left, then **New project**. Name it `Jarvis`, click **Create**, and make sure it's selected at the top.
3. **Turn on the two APIs.** In the search bar at the top, type `Gmail API`, open it and click **Enable**. Do the same for `Google Calendar API`.
4. **Set up the sign-in screen.** Open the menu (☰), then **Google Auth Platform**, then **Branding** (or **Get started**).
   - App name: `Jarvis`. User support email: your email. Click **Next**.
   - Audience: **External**. Click **Next**.
   - Contact information: your email. Click **Next**, tick the agreement, then **Create**.
5. **Add yourself as a test user.** Go to **Google Auth Platform → Audience → + Add users**, enter your Gmail address and click **Save**. Don't upload a logo on the Branding page; a logo makes Google ask for a full app review.
   - While the app is in "Testing", Google ends the sign-in every 7 days. When that happens, Jarvis tells you (Settings, "Is everything working?", and at the top of the briefing), and you click **Reconnect** in Settings.
   - To avoid the weekly reconnect, the app has to be **published**. Google only allows that once the Branding page has a public homepage and a privacy-policy link, which isn't worth it for a personal app.
6. **Create the client.** Go to **Google Auth Platform → Clients → Create client**. Application type: **Desktop app**. Name: `Jarvis desktop`. Click **Create**, then **Download JSON** and save the file (for example, to Documents).
7. **Connect Jarvis.** In Jarvis, go to **Settings → Google account → Choose client file**, pick the file you downloaded, then click **Connect Google**. In your browser:
   - Choose your account.
   - Google says *"Google hasn't verified this app"*. This is expected, because you made the app yourself. Click **Advanced**, then **Go to Jarvis (unsafe)**.
   - **Tick every box**, then click **Continue**. The tab says Jarvis is connected.
8. Jarvis keeps the key in Windows Credential Manager, so you can delete the downloaded file now.

**Try it:** "What's on my calendar this week?", "Summarise today's email", "Draft a reply to the last email from Ali".

**Sending:** Jarvis always asks before it sends an email or invites people. Once you approve, it goes at once and can't be undone. "Draft" never sends.

## Using Jarvis

- **Home:** Jarvis opens on a dashboard.
  - **The orb** shows what it is doing: resting, listening, thinking, searching, speaking, done, or **amber when it needs your OK**.
  - **The cards** show today's calendar, unread email and anything waiting for you. They come straight from Google, so they use none of your Claude limit.
  - Typing opens the conversation. Talking stays on the dashboard, with the answer as a caption under the orb.
- **Ctrl+Space** shows or hides Jarvis from anywhere. Closing the window keeps it in the system tray; right-click the tray icon to quit.
- **Talk to it:** press **Ctrl+Alt+Space** (or the microphone button), speak, and pause. It stops listening after about 3 seconds of silence. Press the shortcut again or **Esc** to interrupt. The **Auto** switch keeps the conversation going without pressing each time.
  - The first time, about 1.8 GB of speech models download once (**Settings → Voice → Download voice models**).
  - Saying "yes" never approves anything. You click the card.
- **Which model answered:** a small badge at the top shows it. It turns amber and Jarvis says so when the local model answered instead of Claude. The local model is weaker, so double-check anything important.
- **New chat** starts a fresh conversation. The old one is kept on the **Chats** page.
- **Memory:** when the assistant wants to remember something, it waits on the **Memory** page until you approve or reject it.
- **Reminders and the briefing** are scheduled inside Hermes. Ask for them in a chat ("remind me on Friday at 6 pm to...").
  - Your PC must be on at that time. A one-off reminder that is more than two minutes late is dropped, so for anything that matters, put it in your calendar too.
- **Backup:** every day Jarvis saves your chats and settings, plus Hermes's memory, personality, settings and scheduled jobs, to `Documents\Jarvis Backups` (the last 10). Sign-ins and keys are never included.

## How it keeps you safe

- **It always asks before it** sends an email, invites people, changes or cancels an event other people are on, or opens a program you downloaded. There is no "always allow" for these.
- **Extra care after reading something someone else wrote.** Emails, calendar invites, web pages, downloads, the screen and the clipboard can hide instructions. Once a chat has read any of them, everything except plain reading asks you first, for the rest of that chat. **New chat** starts clean.
- **Your content stays in.** If that chat has also read your own mail or files, even web searches ask, because a search can carry your content out.
- **Its own files are off limits without your OK:** its settings, safety rules and code.
- **No answer means no.** A card you ignore is a refusal.
- **Activity page:** every action, and whether it ran by rule, was approved by you, or was declined.
- **Settings → "Is everything working?"** shows whether Hermes, Claude, Google, the local model and the safety plugin are all in place.

## Where things are

| What | Where |
|---|---|
| Jarvis's chats, settings and activity log | `%APPDATA%\Jarvis` (Settings → "Open Jarvis data folder") |
| Hermes: memory, settings, schedules, logs | `%LOCALAPPDATA%\hermes` |
| Daily backups | `Documents\Jarvis Backups` (Settings → Backup) |
| Readable copy of memory and chats | `Jarvis Workspace\Vault` in your user folder |

## If something goes wrong

- **"Can't reach Hermes"**: the Hermes gateway isn't running. Start it (`hermes gateway start`) or sign out and in again.
- **The badge is amber / "the local model answered"**: Claude's sign-in has lapsed. Run `claude` once and sign in, then try again.
- **No email or calendar**: Google has disconnected. **Settings → Google account → Reconnect**.
- **It asks before everything**: the chat has read outside text. Press **New chat**.
- **Ctrl+Space does nothing**: another app uses it. Jarvis falls back to **Ctrl+Shift+Space**, or choose another shortcut in Settings.
