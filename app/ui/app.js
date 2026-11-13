(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.jarvis;

  const WORKING = {
    Read: 'Reading a file', Glob: 'Looking for files', Grep: 'Searching inside files', Write: 'Writing a file',
    Edit: 'Editing a file', WebSearch: 'Searching the web', WebFetch: 'Reading a web page',
    PowerShell: 'Running a command', Bash: 'Running a command', TodoWrite: 'Planning the steps',
    mcp__jarvis__screenshot: 'Looking at your screen', mcp__jarvis__open_app: 'Opening an app',
    mcp__jarvis__open_url: 'Opening a website', mcp__jarvis__open_path: 'Opening a file',
    mcp__jarvis__recycle: 'Deleting', mcp__jarvis__move_path: 'Moving files', mcp__jarvis__copy_path: 'Copying files',
    mcp__jarvis__remember: 'Saving to memory',
    mcp__google__gmail_search: 'Searching your email', mcp__google__gmail_read: 'Reading an email',
    mcp__google__gmail_draft: 'Writing a draft', mcp__google__gmail_send: 'Sending an email',
    mcp__google__calendar_events: 'Checking your calendar', mcp__google__calendar_free_time: 'Finding free time',
    mcp__google__calendar_create_event: 'Adding to your calendar', mcp__google__calendar_invite: 'Sending invitations',
    mcp__google__calendar_update_event: 'Changing an event', mcp__google__calendar_update_shared_event: 'Changing an event',
    mcp__google__calendar_cancel_event: 'Cancelling an event',
  };
  const DECISION = {
    'allow:rule': ['done', 'Done'],
    'allow:you': ['approved', 'You approved'],
    'deny:you': ['declined', 'You declined'],
    'deny:rule': ['blocked', 'Blocked by safety rules'],
  };

  let name = 'Jarvis';
  let busy = false;
  let turn = null; // { el, reply, steps, text }
  let pendingCount = 0;
  const cards = new Map();
  let prefs = {};

  // ---------- navigation ----------
  function show(page) {
    for (const s of document.querySelectorAll('.page')) s.hidden = s.id !== `page-${page}`;
    for (const b of document.querySelectorAll('.nav-btn')) {
      if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    if (page === 'activity') loadActivity();
    if (page === 'chats') loadChats();
    if (page === 'memory') loadMemory();
    if (page === 'settings') loadSettings();
    if (page === 'chat') $('input').focus();
  }
  for (const b of document.querySelectorAll('.nav-btn')) {
    b.addEventListener('click', () => {
      show(b.dataset.page);
      if (b.dataset.page === 'chat') setMode('home');
    });
  }

  // ---------- chat ----------
  const conv = $('conversation');
  const scrollDown = () => {
    conv.scrollTop = conv.scrollHeight;
  };

  function addUser(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    conv.append(el);
  }

  function addAssistant(text) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const reply = document.createElement('div');
    reply.className = 'reply';
    const steps = document.createElement('ul');
    steps.className = 'steps';
    el.append(steps, reply);
    if (text) reply.append(window.renderMarkdown(text));
    conv.append(el);
    return { el, reply, steps, text: text || '' };
  }

  // What the assistant depends on, and what to do about anything that is broken.
  const HEALTH_NAMES = { gateway: 'Hermes (the brain)', claude: 'Claude', google: 'Email and calendar', 'local-model': 'Local model', 'safety-plugin': 'Safety plugin' };
  let healthShown = '';
  function renderHealth(results) {
    const list = $('health-list');
    if (!list || !Array.isArray(results)) return;
    list.replaceChildren(...results.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = `${HEALTH_NAMES[r.id] ?? r.id}: `;
      li.append(b, r.ok ? 'working.' : r.message);
      return li;
    }));
    const bad = results.filter((r) => !r.ok && r.id !== 'local-model');
    const key = bad.map((r) => r.id).join(',');
    if (key && key !== healthShown) for (const r of bad) addNote('reminder', r.message, null);
    healthShown = key;
  }

  function addNote(kind, text, action) {
    if (kind === 'error') setMode('chat');
    const el = document.createElement('div');
    el.className = `msg note-${kind}`;
    const p = document.createElement('p');
    p.textContent = text;
    el.append(p);
    if (action) el.append(action);
    conv.append(el);
    scrollDown();
  }

  let renderQueued = false;
  function renderReply() {
    if (renderQueued || !turn) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!turn) return;
      turn.reply.replaceChildren(window.renderMarkdown(turn.text));
      scrollDown();
    });
  }

  function setBusy(on, label) {
    busy = on;
    busyLabel = label || 'Thinking';
    $('status').hidden = !on;
    $('status-text').textContent = busyLabel;
    $('send').hidden = on;
    $('stop').hidden = !on;
    updateOrb();
  }

  const input = $('input');
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  async function sendMessage(text, spoken = false) {
    if (busy) {
      $('hint').textContent = `${name} is still working on your last request. Wait for it, or press Stop.`;
      return false;
    }
    $('hint').textContent = '';
    if (!spoken) followUp = false;
    // Typing opens the conversation; talking from the dashboard stays there, with captions.
    if (spoken && mode === 'home') {
      voiceCaptions = !!prefs.speakReplies;
      captionHeard = 0;
      captionFull = '';
      showCaption('');
    }
    else setMode('chat');
    addUser(text);
    turn = addAssistant('');
    scrollDown();
    const ok = await api.send(text, { spoken });
    if (!ok) {
      turn.el.remove();
      turn = null;
      $('hint').textContent = `${name} is still working on your last request.`;
    }
    return ok;
  }

  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (busy) return sendMessage(text);
    input.value = '';
    grow();
    await sendMessage(text);
  });

  // ---------- voice: listen, then speak the answer ----------
  let voiceState = 'idle'; // idle | listening | hearing | speaking
  let rec = null;
  let voiceGen = 0;
  let followUp = false; // conversation mode: listen again once this spoken reply has finished
  let playCtx = null;
  let playAt = 0;
  const playing = new Set();
  const RATE = 16000;

  function setVoice(state, note) {
    voiceState = state;
    if (state !== 'listening' && state !== 'speaking') setOrbLevel(0.3);
    updateOrb();
    $('mic').classList.toggle('listening', state === 'listening');
    $('mic').classList.toggle('hearing', state === 'hearing');
    $('hush').hidden = state !== 'speaking';
    if (note !== undefined) $('hint').textContent = note;
    else if (state === 'listening' && rec?.followUp) $('hint').textContent = 'Listening for your answer… stay quiet, or press Esc, to end the conversation.';
    else if (state === 'listening') $('hint').textContent = 'Listening… speak now. It stops after ~3 s of silence (or press the shortcut again).';
    else if (state === 'hearing') $('hint').textContent = 'Understanding what you said…';
    else if (state === 'idle' && /^(Listening|Understanding)/.test($('hint').textContent)) $('hint').textContent = '';
  }

  async function startListening(isFollowUp = false) {
    if (busy) {
      $('hint').textContent = `${name} is still working. Wait for it, or press Stop.`;
      return;
    }
    stopPlayback();
    api.stopSpeaking();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setVoice('idle', `${name} can't use the microphone. Check Windows Settings → Privacy & security → Microphone.`);
      return;
    }
    const ctx = new AudioContext({ sampleRate: RATE });
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    const r = { stream, ctx, node, chunks: [], total: 0, voiced: 0, heard: false, quiet: 0, floor: null, followUp: isFollowUp };
    node.onaudioprocess = (e) => {
      if (rec !== r) return;
      const x = e.inputBuffer.getChannelData(0);
      r.chunks.push(new Float32Array(x));
      r.total += x.length;
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      if (r.floor === null) r.floor = rms;
      const threshold = Math.max(0.012, r.floor * 3);
      if (rms > threshold) {
        r.heard = true;
        r.voiced += x.length;
        r.quiet = 0;
      } else if (r.heard) {
        r.quiet += x.length / RATE;
      } else {
        r.floor = r.floor * 0.8 + rms * 0.2; // learn the room's background noise
      }
      setOrbLevel(Math.min(1, Math.max(0, (rms - r.floor) / 0.08)));
      if (r.heard && r.quiet > 3) finishListening(); // 3 s of silence before thinking starts; long enough for a breath or a mid-sentence pause
      else if (!r.heard && r.total > RATE * 8) cancelListening(r.followUp ? 'Conversation ended. Press the shortcut or the mic to talk again.' : 'I didn’t hear anything. Press the shortcut and try again.');
      else if (r.total > RATE * 60) finishListening();
    };
    source.connect(node);
    node.connect(ctx.destination);
    rec = r;
    setVoice('listening');
  }

  function closeRecording(r) {
    try {
      r.node.disconnect();
      r.stream.getTracks().forEach((t) => t.stop());
      r.ctx.close();
    } catch {
      /* already closed */
    }
  }

  function cancelListening(note = '') {
    const r = rec;
    rec = null;
    if (r) closeRecording(r);
    setVoice('idle', note);
  }

  async function finishListening() {
    const r = rec;
    if (!r) return;
    rec = null;
    closeRecording(r);
    const audio = new Float32Array(r.total);
    let at = 0;
    for (const c of r.chunks) {
      audio.set(c, at);
      at += c.length;
    }
    const missed = r.followUp ? 'Conversation ended. Press the shortcut or the mic to talk again.' : 'I didn’t catch that. Press the shortcut and try again.';
    // A click is not worth waking Whisper for: even a quick "yes" spans two 128 ms chunks of voice.
    if (r.voiced < RATE * 0.2) return setVoice('idle', missed);
    setVoice('hearing');
    const res = await api.transcribe(audio);
    if (res?.error) return setVoice('idle', `Voice problem: ${res.error}`);
    const text = String(res?.text ?? '').trim();
    if (!text) return setVoice('idle', missed);
    setVoice('idle', '');
    await sendMessage(text, true);
  }

  function playChunk({ gen, audio, sampleRate, text }) {
    if (gen < voiceGen || !audio?.length) return;
    if (!playCtx) {
      playCtx = new AudioContext();
      playMeter = playCtx.createAnalyser();
      playMeter.fftSize = 1024;
      playMeter.connect(playCtx.destination);
    }
    const buf = playCtx.createBuffer(1, audio.length, sampleRate);
    buf.copyToChannel(audio instanceof Float32Array ? audio : Float32Array.from(audio), 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playMeter);
    const at = Math.max(playCtx.currentTime + 0.05, playAt);
    src.start(at);
    playAt = at + buf.duration;
    if (voiceCaptions && text) cueCaption(text, at - playCtx.currentTime, buf.duration);
    playing.add(src);
    src.onended = () => {
      playing.delete(src);
      if (!playing.size && voiceState === 'speaking') setVoice('idle');
      maybeFollowUp();
    };
    window.__voicePlayed = (window.__voicePlayed ?? 0) + 1;
    if (voiceState === 'idle') setVoice('speaking');
    if (!metering) meterSpeech();
  }

  // The orb pulses with Jarvis's own voice while it speaks.
  let playMeter = null;
  let metering = false;
  const meterBuf = new Float32Array(1024);
  function meterSpeech() {
    if (voiceState !== 'speaking') {
      metering = false;
      return;
    }
    metering = true;
    playMeter.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (const x of meterBuf) sum += x * x;
    setOrbLevel(Math.min(1, Math.sqrt(sum / meterBuf.length) * 5));
    requestAnimationFrame(meterSpeech);
  }

  function stopPlayback() {
    for (const s of playing) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    playing.clear();
    playAt = 0;
    clearCues();
    if (voiceState === 'speaking') setVoice('idle');
  }

  // Conversation mode: once the reply has been spoken in full and nothing waits on you, listen again.
  // Approvals stay on screen, so a waiting approval ends the conversation instead.
  function maybeFollowUp() {
    if (!followUp || busy || voiceState !== 'idle' || playing.size) return;
    followUp = false;
    if (!prefs.keepListening || pendingCount > 0) return;
    setTimeout(() => {
      if (!busy && voiceState === 'idle' && !playing.size && pendingCount === 0) startListening(true);
    }, 350); // let the speakers fall quiet so the room's noise is learned, not the last word
  }

  function renderAutoListen() {
    const on = !!prefs.keepListening;
    $('auto-listen').setAttribute('aria-pressed', String(on));
    $('auto-listen').title = on
      ? 'Conversation mode is on: after a spoken reply, Jarvis listens for your answer. Click to turn off.'
      : 'Conversation mode is off. Turn it on to keep talking without pressing the mic each time.';
  }

  function toggleVoice() {
    if (voiceState === 'listening') return finishListening();
    if (voiceState === 'hearing') return;
    if (voiceState === 'speaking') api.stopSpeaking(); // interrupt, then listen
    startListening();
  }

  $('mic').addEventListener('click', toggleVoice);
  $('auto-listen').addEventListener('click', async () => {
    prefs = await api.setSettings({ keepListening: !prefs.keepListening });
    renderAutoListen();
    if (!prefs.keepListening) followUp = false;
  });
  $('hush').addEventListener('click', () => api.stopSpeaking());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && voiceState === 'listening') cancelListening('');
    else if (e.key === 'Escape' && voiceState === 'speaking') api.stopSpeaking();
  });

  $('stop').addEventListener('click', () => api.stop());
  $('new-chat').addEventListener('click', async () => {
    if (busy && !confirm('Stop the current task and start a new chat?')) return;
    await api.newChat();
    conv.replaceChildren();
    turn = null;
    intro();
    setMode('home');
  });
  $('open-workspace').addEventListener('click', () => api.openFolder('workspace'));
  $('open-data').addEventListener('click', () => api.openFolder('data'));
  $('health-check').addEventListener('click', async () => renderHealth(await api.health()));

  function intro() {
    if (conv.children.length) return;
    const el = document.createElement('div');
    el.className = 'empty';
    const h = document.createElement('h2');
    h.textContent = 'What can I take off your plate?';
    const p = document.createElement('p');
    p.textContent = 'Try: "Find the PDFs I downloaded this week and sort them into folders", "Research the best budget laptops and save a comparison", or "Remind me at 5pm to call the bank".';
    el.append(h, p);
    conv.append(el);
  }

  // ---------- approvals ----------
  function updateBadge() {
    const b = $('approval-badge');
    b.hidden = pendingCount === 0;
    b.textContent = String(pendingCount);
    updateOrb();
    renderNeeds();
  }

  function buildApproval(card) {
    const node = $('approval-template').content.firstElementChild.cloneNode(true);
    node.querySelector('.approval-lead').textContent = card.escalated
      ? `${name} wants to do something that needs extra care`
      : `${name} needs your OK`;
    node.querySelector('.approval-what').textContent = card.summary;
    const why = node.querySelector('.approval-why');
    for (const r of card.reasons || []) {
      const li = document.createElement('li');
      li.textContent = r;
      why.append(li);
    }
    if (!card.canAlways) node.querySelector('.always').remove();
    for (const btn of node.querySelectorAll('button[data-choice]')) {
      btn.addEventListener('click', () => api.answer(card.id, btn.dataset.choice));
    }
    if (card.escalated) node.classList.add('escalated');
    return node;
  }

  // On the dashboard, the same card sits under the orb (already amber), so a request made from home
  // is answered there; the copy in the conversation keeps the story in order.
  const homeCards = new Map();
  function addApproval(card) {
    if (cards.has(card.id)) return;
    if (mode !== 'home') setMode('chat');
    document.querySelector('.empty')?.remove();
    const node = buildApproval(card);
    const home = buildApproval(card);
    home.classList.add('home-approval');
    $('home-approvals').append(home);
    homeCards.set(card.id, home);
    $('home').classList.add('has-approval');
    // Once the orb has stepped back, make sure the buttons are on screen, even in a short window.
    if (mode === 'home') setTimeout(() => home.querySelector('.approval-actions').scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 400);
    // Shown inside the reply it belongs to, so the story reads in order.
    if (turn) turn.el.insertBefore(node, turn.reply);
    else conv.append(node);
    cards.set(card.id, node);
    pendingCount++;
    updateBadge();
    scrollDown();
    // Never pull focus out of the message box: an Enter meant for a message must not approve.
    if (document.activeElement !== input) (mode === 'home' ? home : node).querySelector('.approve').focus({ preventScroll: true });
  }

  function settleApproval({ id, choice }) {
    const node = cards.get(id);
    if (!node) return;
    cards.delete(id);
    pendingCount = Math.max(0, pendingCount - 1);
    updateBadge();
    markSettled(node, choice);
    const home = homeCards.get(id);
    homeCards.delete(id);
    if (home) {
      markSettled(home, choice);
      setTimeout(() => {
        home.classList.add('leaving');
        setTimeout(() => {
          home.remove();
          if (!homeCards.size) $('home').classList.remove('has-approval');
        }, 300);
      }, 1400);
    }
  }

  function markSettled(node, choice) {
    node.classList.add('settled', choice === 'deny' ? 'was-denied' : 'was-allowed');
    for (const b of node.querySelectorAll('button')) b.disabled = true;
    node.querySelector('.approval-actions').hidden = true;
    const res = node.querySelector('.approval-result');
    res.hidden = false;
    res.textContent = choice === 'deny' ? 'Not allowed.' : choice === 'always' ? 'Allowed, and won’t ask again for this.' : 'Allowed.';
  }

  // ---------- events from the brain ----------
  api.onEvent(({ type, data }) => {
    switch (type) {
      case 'busy':
        followUp = false;
        workingTool = null;
        setBusy(true, 'Thinking');
        break;
      case 'working':
        workingTool = data;
        setBusy(true, WORKING[data] || 'Working');
        break;
      case 'text':
        if (!turn) turn = addAssistant('');
        turn.text += data;
        renderReply();
        if (captioning) {
          captionFull = turn.text;
          if (!voiceCaptions) showCaption(turn.text);
        }
        break;
      case 'activity':
        if (turn && data.tool !== 'TodoWrite' && data.by !== 'you') {
          const [cls, label] = DECISION[`${data.decision}:${data.by}`] || ['done', ''];
          const li = document.createElement('li');
          li.className = `step ${cls}`;
          li.textContent = data.summary;
          li.title = label + (data.reasons?.length ? ` — ${data.reasons.join(' ')}` : '');
          turn.steps.append(li);
          scrollDown();
        }
        if (!$('page-activity').hidden) prependActivity(data);
        break;
      case 'approval':
        addApproval(data);
        setBusy(true, 'Waiting for your OK');
        break;
      case 'approval-settled':
        settleApproval(data);
        if (busy) setBusy(true, 'Working');
        break;
      case 'done':
        if (turn && !turn.text && data.text) {
          turn.text = data.text;
          renderReply();
        }
        if (data.runtime) {
          const b = $('model-badge');
          b.textContent = data.runtime.fallback ? `Local model: ${data.runtime.model || data.runtime.provider}` : data.runtime.model || data.runtime.provider;
          b.classList.toggle('fallback', !!data.runtime.fallback);
          b.title = data.runtime.fallback ? 'Claude was not available, so the local model answered.' : 'The model that answered last.';
          b.hidden = false;
        }
        break;
      case 'health':
        renderHealth(data);
        break;
      case 'model-note':
        addNote('reminder', data.text, null);
        $('hint').textContent = data.text;
        break;
      case 'error':
        addNote('error', data.message, null);
        break;
      case 'google':
        renderGoogle(data);
        googleState = data;
        renderNeeds();
        refreshDashboard(true);
        break;
      case 'voice-toggle':
        toggleVoice();
        break;
      case 'voice-audio':
        playChunk(data);
        break;
      case 'voice-done':
        if (voiceCaptions) finishVoiceCaptions();
        followUp = true;
        maybeFollowUp();
        break;
      case 'voice-stop':
        followUp = false;
        voiceGen = data.gen;
        stopPlayback();
        break;
      case 'voice-error':
        addNote('error', data);
        break;
      case 'voice-progress': {
        const pct = data.total ? Math.round((data.loaded / data.total) * 100) : null;
        const line = `Downloading speech models (one time): ${data.file}${pct === null ? '' : ` ${pct}%`}`;
        $('voice-status').textContent = line;
        if (voiceState === 'hearing') $('hint').textContent = line;
        break;
      }
      case 'idle':
        if (turn?.text) flashDone();
        if (captioning) endCaption();
        workingTool = null;
        setBusy(false);
        if (turn && !turn.text && !turn.steps.children.length) turn.el.remove();
        turn = null;
        maybeFollowUp();
        break;
      case 'focus-input':
        show('chat');
        break;
    }
  });

  // ---------- activity page ----------
  function activityRow(r) {
    const li = document.createElement('li');
    const [cls, label] = DECISION[`${r.decision}:${r.by}`] || ['done', r.decision];
    li.className = `act ${cls}`;
    const time = document.createElement('time');
    time.dateTime = r.ts;
    time.textContent = new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const what = document.createElement('p');
    what.className = 'act-what';
    what.textContent = r.summary;
    const verdict = document.createElement('p');
    verdict.className = 'act-verdict';
    verdict.textContent = label + (r.escalated ? ' (extra care after reading outside content)' : '');
    li.append(time, what, verdict);
    if (r.reasons?.length && r.decision !== 'allow') {
      const why = document.createElement('p');
      why.className = 'act-why';
      why.textContent = r.reasons.join(' ');
      li.append(why);
    }
    if (r.backup) {
      const b = document.createElement('p');
      b.className = 'act-why';
      b.textContent = `Backup of the original: ${r.backup}`;
      li.append(b);
    }
    return li;
  }
  async function loadActivity() {
    const rows = await api.activity();
    const list = $('activity-list');
    list.replaceChildren(...rows.map(activityRow));
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = `Nothing yet. Every action ${name} takes will be listed here.`;
      list.append(li);
    }
  }
  function prependActivity(r) {
    const list = $('activity-list');
    list.querySelector('.empty-row')?.remove();
    list.prepend(activityRow(r));
  }

  // ---------- past chats ----------
  let openChat = null;
  async function loadChats() {
    const rows = await api.chats();
    const list = $('chat-list');
    list.replaceChildren();
    // The chat in progress is already saved; it moves into the list below when you start a new one.
    const now = (await api.history()).filter((i) => i.role === 'user' || i.role === 'assistant');
    if (now.length) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'chat-item current';
      const t = document.createElement('strong');
      t.textContent = (now.find((i) => i.role === 'user')?.text ?? 'Chat').split('\n')[0].slice(0, 60);
      const meta = document.createElement('span');
      meta.textContent = `In progress · ${now.length} messages`;
      b.append(t, meta);
      b.addEventListener('click', () => {
        show('chat');
        setMode('chat');
      });
      li.append(b);
      list.append(li);
    }
    for (const r of rows) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'chat-item';
      const t = document.createElement('strong');
      t.textContent = r.title;
      const meta = document.createElement('span');
      meta.textContent = `${new Date(r.started).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${r.messages} messages`;
      b.append(t, meta);
      b.addEventListener('click', () => viewChat(r.id));
      li.append(b);
      list.append(li);
    }
    if (!rows.length && !now.length) {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = 'No earlier chats yet. When you press New chat, the current one is kept here.';
      list.append(li);
    }
    $('chat-view').hidden = true;
  }

  async function viewChat(id) {
    const rec = await api.getChat(id);
    if (!rec) return;
    openChat = rec;
    showRename(false);
    $('chat-view-title').textContent = rec.title;
    $('chat-continue').hidden = !rec.sessionId;
    const body = $('chat-view-body');
    body.replaceChildren();
    for (const item of rec.items) {
      const el = document.createElement('div');
      if (item.role === 'user') {
        el.className = 'msg user';
        el.textContent = item.text;
      } else if (item.role === 'assistant') {
        el.className = 'msg assistant';
        const reply = document.createElement('div');
        reply.className = 'reply';
        reply.append(window.renderMarkdown(item.text));
        el.append(reply);
      } else {
        el.className = `msg note-${item.role === 'error' ? 'error' : 'reminder'}`;
        const p = document.createElement('p');
        p.textContent = item.text;
        el.append(p);
      }
      body.append(el);
    }
    $('chat-view').hidden = false;
  }

  function showRename(on) {
    $('chat-rename-form').hidden = !on;
    $('chat-view-title').hidden = on;
    $('chat-rename').hidden = on;
    if (on) {
      const box = $('chat-rename-input');
      box.value = openChat?.title ?? '';
      box.focus();
      box.select();
    }
  }
  $('chat-rename').addEventListener('click', () => showRename(true));
  $('chat-rename-cancel').addEventListener('click', () => showRename(false));
  $('chat-rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') showRename(false);
  });
  $('chat-rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!openChat) return;
    const title = await api.renameChat(openChat.id, $('chat-rename-input').value);
    if (title) {
      openChat.title = title;
      $('chat-view-title').textContent = title;
      const id = openChat.id;
      await loadChats();
      await viewChat(id);
    } else {
      showRename(false);
    }
  });

  $('chat-delete').addEventListener('click', async () => {
    if (!openChat || !confirm(`Delete "${openChat.title}"? Its copy in your vault goes to the Recycle Bin.`)) return;
    await api.deleteChat(openChat.id);
    openChat = null;
    await loadChats();
  });

  $('chat-continue').addEventListener('click', async () => {
    if (!openChat) return;
    if (busy) {
      $('hint').textContent = `${name} is busy. Wait for it to finish, then continue the chat.`;
      return;
    }
    if (!(await api.continueChat(openChat.id))) return;
    openChat = null;
    conv.replaceChildren();
    turn = null;
    setMode('chat');
    for (const item of await api.history()) {
      if (item.role === 'user') addUser(item.text);
      else if (item.role === 'assistant') addAssistant(item.text);
      else if (item.role === 'error') addNote('error', item.text);
      else addNote('reminder', item.role === 'reminder' ? `Reminder: ${item.text}` : item.text);
    }
    show('chat');
    scrollDown();
  });

  // ---------- memory page ----------
  const SECTIONS = ['About you', 'Hermes notes'];
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (label, cls, onClick) => {
    const b = mk('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
  let facts = [];

  // ---------- memory waiting for approval ----------
  const OP_LABEL = { add: 'Add', replace: 'Replace', remove: 'Remove' };
  let pendingMem = [];
  function updateMemoryBadge() {
    const b = $('memory-badge');
    b.hidden = pendingMem.length === 0;
    b.textContent = String(pendingMem.length);
  }
  async function refreshPendingMemory() {
    try {
      pendingMem = await api.pendingMemory();
    } catch {
      pendingMem = [];
    }
    updateMemoryBadge();
    if (!$('page-memory').hidden) renderPending();
  }
  function renderPending() {
    const box = $('mem-pending');
    const ul = $('mem-pending-list');
    box.hidden = pendingMem.length === 0 && !$('mem-pending-msg').textContent;
    $('mem-pending-count').textContent = pendingMem.length ? String(pendingMem.length) : '';
    ul.replaceChildren();
    for (const p of pendingMem) {
      const li = mk('li', 'fact pending-fact');
      const body = mk('div', 'f-body');
      for (const op of p.ops) {
        const line = mk('p', 'f-text');
        line.dir = 'auto';
        line.append(mk('b', 'op', `${OP_LABEL[op.action] ?? op.action}: `), document.createTextNode(op.text || (op.action === 'remove' ? '' : '(empty)')));
        body.append(line);
        if (op.replaces && op.action !== 'add') body.append(mk('p', 'f-meta', `${op.action === 'remove' ? 'Deletes' : 'Overwrites'} this whole entry: “${op.replaces}”`));
      }
      body.append(mk('p', 'f-meta', `${p.section} · ${p.origin}${p.created ? ` · ${shortDate(p.created)}` : ''} · ${p.id}`));
      const acts = mk('div', 'f-actions');
      const decide = async (fn, b) => {
        acts.querySelectorAll('button').forEach((x) => (x.disabled = true));
        b.textContent = '…';
        const r = await fn(p.id);
        $('mem-pending-msg').textContent = r.ok ? (r.message || 'Done.') : r.message;
        $('mem-pending-msg').classList.toggle('error-text', !r.ok);
        await refreshPendingMemory();
        await memoryChanged();
      };
      const yes = button('Approve', 'small', () => decide(api.approvePendingMemory, yes));
      const no = button('Reject', 'quiet small', () => decide(api.rejectPendingMemory, no));
      acts.append(yes, no);
      li.append(body, acts);
      ul.append(li);
    }
  }
  refreshPendingMemory();
  setInterval(refreshPendingMemory, 20_000);

  async function loadMemory() {
    $('mem-pending-msg').textContent = '';
    refreshPendingMemory();
    $('memory-text').value = await api.getMemory();
    facts = await api.memoryFacts();
    renderFacts();
    renderHistory(await api.memoryHistory());
  }
  async function memoryChanged() {
    $('memory-text').value = await api.getMemory();
    facts = await api.memoryFacts();
    renderFacts();
    renderHistory(await api.memoryHistory());
  }

  // Inline editing: Enter or clicking away saves, Esc puts the text back.
  function editInPlace(holder, text, save) {
    const box = mk('input', 'inline-edit');
    box.value = text;
    box.maxLength = 500;
    box.dir = 'auto';
    holder.replaceChildren(box);
    box.focus();
    box.select();
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(save(box.value.trim()));
        if (e.key === 'Escape') finish(null);
      });
      box.addEventListener('blur', () => finish(save(box.value.trim())));
    });
  }

  function renderFacts() {
    const q = $('mem-search').value.trim().toLowerCase();
    const wrap = $('mem-facts');
    wrap.replaceChildren();
    let shown = 0;
    for (const s of SECTIONS) {
      const mine = facts.filter((f) => f.section === s && (!q || `${f.text} ${f.quote}`.toLowerCase().includes(q)));
      if (q && !mine.length) continue;
      shown += mine.length;
      const sec = mk('section', 'mem-section');
      const h = mk('h3', '', s);
      h.append(mk('b', '', mine.length ? String(mine.length) : ''));
      const ul = mk('ul', 'fact-list');
      for (const f of mine) {
        const li = mk('li', 'fact');
        const body = mk('div', 'f-body');
        const text = mk('p', 'f-text', f.text);
        text.dir = 'auto';
        body.append(text);
        const acts = mk('div', 'f-actions');
        acts.append(
          button('Edit', 'quiet small', async () => {
            const t = await editInPlace(text, f.text, (v) => v);
            if (t && t !== f.text) await api.updateFact(f.id, t);
            await memoryChanged();
          }),
          button('Delete', 'quiet small', async () => {
            await api.removeFact(f.id);
            await memoryChanged();
          }),
        );
        li.append(body, acts);
        ul.append(li);
      }
      sec.append(h, ul);
      if (!q) {
        const add = mk('form', 'fact-add');
        const box = mk('input');
        box.placeholder = `Add to ${s.toLowerCase()}…`;
        box.maxLength = 500;
        box.setAttribute('aria-label', `Add to ${s}`);
        add.append(box, mk('button', 'quiet small', 'Add'));
        add.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!box.value.trim()) return;
          await api.addFact(s, box.value.trim());
          await memoryChanged();
        });
        sec.append(add);
      }
      wrap.append(sec);
    }
    if (q && !shown) wrap.append(mk('p', 'empty-row', 'Nothing in memory matches that.'));
  }
  $('mem-search').addEventListener('input', renderFacts);

  function renderHistory(days) {
    const sel = $('mem-history');
    sel.replaceChildren(...days.map((d) => {
      const o = mk('option', '', `${new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, start of day · ${d.count} fact${d.count === 1 ? '' : 's'}`);
      o.value = d.day;
      return o;
    }));
    sel.disabled = $('mem-restore').disabled = !days.length;
    if (!days.length) sel.append(mk('option', '', 'None yet: kept from the first change on'));
  }
  $('mem-restore').addEventListener('click', async () => {
    const day = $('mem-history').value;
    if (!day || !confirm('Replace memory with this earlier version? Today’s first version stays in the list, so you can come back.')) return;
    const ok = await api.restoreMemory(day);
    $('mem-restore-msg').textContent = ok ? 'Restored.' : 'Couldn’t restore that version.';
    await memoryChanged();
  });

  $('mem-as-text').addEventListener('click', () => {
    $('mem-text-panel').hidden = false;
    $('mem-facts').hidden = true;
    $('memory-text').focus();
  });
  $('mem-text-close').addEventListener('click', () => {
    $('mem-text-panel').hidden = true;
    $('mem-facts').hidden = false;
  });
  $('memory-save').addEventListener('click', async () => {
    await api.setMemory($('memory-text').value);
    await memoryChanged();
    $('memory-saved').hidden = false;
    setTimeout(() => ($('memory-saved').hidden = true), 1800);
  });

  // ---------- settings page ----------
  const LEVEL_LABEL = { auto: 'Do it', ask: 'Ask me first', never: 'Never' };
  async function loadSettings() {
    const s = await api.getSettings();
    for (const k of ['assistantName', 'userName', 'hotkey', 'vaultFolder', 'voiceHotkey', 'voiceLanguage', 'englishVoice', 'urduVoice', 'backupFolder']) $(`s-${k}`).value = s[k] ?? '';
    $('s-speakReplies').checked = !!s.speakReplies;
    $('s-keepListening').checked = !!s.keepListening;
    $('s-speakApprovals').checked = !!s.speakApprovals;
    $('s-startAtLogin').checked = !!s.startAtLogin;
    $('s-theme').value = s.theme || 'system';
    $('s-autoBackup').checked = !!s.autoBackup;
    renderGoogle(await api.googleStatus());
  }

  function renderGoogle(st, error) {
    $('g-status').textContent = st.signingIn
      ? 'Waiting for you to finish signing in, in your browser…'
      : st.connected
        ? `Connected${st.email ? ` as ${st.email}` : ''}.`
        : st.hasClient
          ? 'Client file added. Now connect your Google account.'
          : 'Not connected. Start by choosing the client file you downloaded from Google Cloud.';
    $('g-connect').disabled = !st.hasClient || st.signingIn;
    $('g-connect').textContent = st.connected ? 'Reconnect' : 'Connect Google';
    $('g-disconnect').hidden = !st.connected;
    if (error !== undefined) {
      $('g-error').hidden = !error;
      $('g-error').textContent = error || '';
    }
  }
  const googleAction = (fn) => async () => {
    const st = await fn();
    renderGoogle(st, st.error ?? '');
  };
  $('g-client').addEventListener('click', googleAction(() => api.googleChooseClient()));
  $('g-connect').addEventListener('click', googleAction(() => api.googleConnect()));
  $('g-disconnect').addEventListener('click', googleAction(() => api.googleDisconnect()));

  const save = (patch) =>
    api.setSettings(patch).then((s) => {
      prefs = s;
      applyName(s.assistantName);
    });
  for (const k of ['assistantName', 'userName', 'hotkey', 'vaultFolder', 'voiceHotkey', 'voiceLanguage', 'englishVoice', 'urduVoice', 'backupFolder']) {
    $(`s-${k}`).addEventListener('change', (e) => save({ [k]: e.target.value }));
  }
  $('s-theme').addEventListener('change', (e) => save({ theme: e.target.value }));
  $('theme-toggle').addEventListener('click', () => save({ theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark' }));
  $('s-speakReplies').addEventListener('change', (e) => save({ speakReplies: e.target.checked }));
  $('s-speakApprovals').addEventListener('change', (e) => save({ speakApprovals: e.target.checked }));
  $('s-keepListening').addEventListener('change', (e) => save({ keepListening: e.target.checked }).then(renderAutoListen));
  $('voice-prepare').addEventListener('click', async () => {
    $('voice-status').textContent = 'Getting the speech models ready… the first time takes a few minutes.';
    const r = await api.prepareVoice();
    $('voice-status').textContent = r?.error ? `Couldn’t get the speech models: ${r.error}` : `Ready. Listening runs on your ${r?.device === 'gpu' ? 'graphics card' : 'processor'}.`;
  });
  $('voice-test').addEventListener('click', () => api.testVoice());
  $('open-vault').addEventListener('click', () => api.openFolder('vault'));
  $('s-autoBackup').addEventListener('change', (e) => save({ autoBackup: e.target.checked }));
  $('bk-open').addEventListener('click', () => api.openFolder('backups'));
  $('bk-now').addEventListener('click', async () => {
    const r = await api.backupNow();
    $('bk-msg').textContent = r?.error ? `Couldn’t back up: ${r.error}` : 'Backed up.';
  });
  $('bk-restore').addEventListener('click', async () => {
    const r = await api.restoreBackup();
    $('bk-msg').textContent = r?.error ? r.error : r?.restarting ? 'Restoring… Jarvis is restarting.' : '';
  });
  $('s-startAtLogin').addEventListener('change', (e) => save({ startAtLogin: e.target.checked }));

  function applyName(n) {
    name = n || 'Jarvis';
    document.title = name;
    renderHead();
    input.placeholder = `Ask ${name} anything, or say what to do`;
  }

  // ---------- home: the orb and the day around it ----------
  const page = $('page-chat');
  const orbs = [$('orb'), $('orb-mini')];
  const SEARCHING = new Set([
    'WebSearch', 'WebFetch', 'Grep', 'Glob', 'Read', 'mcp__jarvis__screenshot',
    'mcp__google__gmail_search', 'mcp__google__gmail_read', 'mcp__google__calendar_events', 'mcp__google__calendar_free_time',
  ]);
  let mode = 'home'; // home | chat
  let busyLabel = 'Thinking';
  let workingTool = null;
  let doneUntil = 0;
  let captioning = false;
  let captionTimer = null;
  // A spoken reply is captioned by its audio, sentence by sentence, not by the text stream (which runs ahead).
  let voiceCaptions = false;
  let captionCues = [];
  let captionHeard = 0;
  let captionFull = '';
  let googleState = {};
  let lastTouch = Date.now();
  let lastDash = null;
  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const hasConversation = () => !!conv.querySelector('.msg');

  function setMode(m) {
    if (m === 'chat' && mode !== 'chat') clearCaption();
    mode = m;
    page.classList.toggle('home-mode', m === 'home');
    $('to-chat').hidden = !(m === 'home' && hasConversation());
    renderHead();
    if (m === 'home') refreshDashboard();
    else scrollDown();
  }
  $('rail-orb').addEventListener('click', () => {
    show('chat');
    setMode('home');
  });
  $('to-chat').addEventListener('click', () => setMode('chat'));
  for (const ev of ['keydown', 'pointerdown']) document.addEventListener(ev, () => (lastTouch = Date.now()), true);

  // After ten quiet minutes, the dashboard comes back by itself.
  function returnHome() {
    if (mode === 'chat' && !busy && voiceState === 'idle' && pendingCount === 0 && Date.now() - lastTouch > 600_000) setMode('home');
  }

  function renderHead() {
    const now = new Date();
    if (mode === 'home') {
      const h = now.getHours();
      const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
      const narrow = matchMedia('(max-width: 599px)').matches;
      $('chat-title').textContent = prefs.userName && !narrow ? `${part}, ${prefs.userName}` : part;
      $('head-sub').textContent = lastDash ? briefingLine(lastDash, now) : '';
      $('clock-time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      $('clock-date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    } else {
      $('chat-title').textContent = name;
      $('head-sub').textContent = '';
    }
  }

  // "Design review until 12:00 PM. 4 unread emails." Built from the cards, no Claude.
  function briefingLine(d, now) {
    const parts = [];
    const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
    if (d.google === 'on' && !d.calendar.error) {
      const evs = d.calendar.events;
      const cur = evs.find((e) => new Date(e.start) <= now && new Date(e.end) > now && !e.allDay);
      const next = evs.find((e) => new Date(e.start) > now && !e.allDay);
      if (cur) parts.push(`${cur.title} until ${hhmm(cur.end)}`);
      else if (next) parts.push(`Next: ${next.title} at ${hhmm(next.start)}`);
      else parts.push('Nothing else on your calendar today');
    }
    if (d.google === 'on' && !d.mail.error) parts.push(d.mail.unread ? plural(d.mail.unread, 'unread email') : 'Inbox zero');
    return parts.length ? `${parts.join('. ')}.` : '';
  }

  function orbState() {
    if (pendingCount > 0) return ['attention', 'Needs your OK'];
    if (voiceState === 'listening') return ['listening', 'Listening'];
    if (voiceState === 'speaking') return ['speaking', 'Speaking'];
    if (voiceState === 'hearing') return ['thinking', 'Understanding you'];
    if (busy) return [SEARCHING.has(workingTool) ? 'searching' : 'thinking', busyLabel];
    if (Date.now() < doneUntil) return ['done', 'Done'];
    return ['idle', 'Ready'];
  }
  function updateOrb() {
    const [state, word] = orbState();
    for (const o of orbs) if (o.getAttribute('state') !== state) o.setAttribute('state', state);
    $('orb-word').textContent = word;
    const talk = (prefs.voiceHotkey || 'Control+Alt+Space').replace('Control', 'Ctrl');
    $('hint').dataset.idle = `Press ${talk} to talk, or type below. ${(prefs.hotkey || 'Control+Space').replace('Control', 'Ctrl')} brings ${name} up from anywhere.`;
    $('rail-orb').title = `${word}. Show the dashboard.`;
    document.documentElement.style.setProperty('--orb-color', `var(--orb-${state})`);
    $('state-dot').title = word;
  }
  function setOrbLevel(level) {
    const v = level.toFixed(2);
    for (const o of orbs) o.setAttribute('level', v);
    $('mic').style.setProperty('--level', v);
  }
  function flashDone() {
    doneUntil = Date.now() + 1600;
    setTimeout(updateOrb, 1650);
  }

  // What Jarvis says, as a caption under the orb, when you talk to it from the dashboard.
  function plain(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(?:[-+•]|\d+\.)\s+/gm, '')
      .replace(/[#*_`>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function showCaption(text) {
    captioning = true;
    clearTimeout(captionTimer);
    const cap = $('caption');
    cap.classList.remove('fade');
    let t = plain(text);
    if (t.length > 190) {
      const tail = t.slice(-190);
      const cut = tail.search(/[.!?۔؟]\s/);
      t = `…${cut >= 0 ? tail.slice(cut + 2) : tail}`;
    }
    cap.textContent = t;
  }
  function endCaption() {
    captioning = false;
    if (!voiceCaptions) captionTimer = setTimeout(() => $('caption').classList.add('fade'), 9000);
  }
  function clearCaption() {
    captioning = false;
    voiceCaptions = false;
    clearCues();
    clearTimeout(captionTimer);
    $('caption').textContent = '';
  }

  // One sentence on screen while its audio plays, its words appearing in step with the voice.
  // Word timing is estimated from word length across the clip; the TTS gives no word timestamps.
  function cueCaption(sentence, startIn, duration) {
    const words = plain(sentence).split(' ').filter(Boolean);
    if (!words.length) return;
    captionHeard++;
    const total = words.reduce((n, w) => n + w.length + 1, 0);
    let done = 0;
    words.forEach((w, i) => {
      const at = Math.max(0, startIn + (duration * done) / total);
      done += w.length + 1;
      captionCues.push(setTimeout(() => {
        const cap = $('caption');
        cap.classList.remove('fade');
        cap.textContent = words.slice(0, i + 1).join(' ');
      }, at * 1000));
    });
  }
  function clearCues() {
    for (const t of captionCues) clearTimeout(t);
    captionCues = [];
  }
  // Every sentence has been handed to the speakers: fade once the last one has played.
  // If none was spoken (the voice failed), show the written reply instead.
  function finishVoiceCaptions() {
    voiceCaptions = false;
    if (!captionHeard && captionFull) showCaption(captionFull);
    captioning = false;
    const left = playCtx ? Math.max(0, playAt - playCtx.currentTime) : 0;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => $('caption').classList.add('fade'), left * 1000 + 9000);
  }

  // ---- the cards ----
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const emptyLine = (text) => el('p', 'card-empty', text);

  function renderDay(d) {
    const body = $('day-body');
    $('day-foot').textContent = '';
    $('day-count').textContent = '';
    if (d.google !== 'on') return body.replaceChildren(emptyLine('Connect Google in Settings to see your day here.'));
    const c = d.calendar;
    if (c.error) return body.replaceChildren(emptyLine('Couldn’t load your calendar just now.'));
    const now = Date.now();
    const events = c.events.filter((e) => new Date(e.end).getTime() > now);
    if (!events.length) body.replaceChildren(emptyLine('Nothing else on your calendar today.'));
    else {
      $('day-count').textContent = String(events.length + c.more);
      body.replaceChildren(
        ...events.map((e) => {
          const start = new Date(e.start).getTime();
          const end = new Date(e.end).getTime();
          const live = !e.allDay && start <= now;
          const row = el('div', `row${live ? ' now' : ''}`);
          const line = el('div', 'row-line');
          const time = el('time', '', e.allDay ? 'All day' : live ? 'Now' : hhmm(e.start));
          time.dateTime = e.start;
          const mins = Math.round((end - start) / 60000);
          line.append(time, el('span', 'row-title', e.title), el('span', 'row-meta', e.allDay ? '' : live ? `until ${hhmm(e.end)}` : `${mins} min`));
          row.append(line);
          if (live) {
            const bar = el('div', 'progress');
            const fill = el('span');
            fill.style.width = `${Math.round(Math.min(1, (now - start) / (end - start)) * 100)}%`;
            bar.append(fill);
            row.append(bar);
          }
          return row;
        }),
      );
    }
    const up = c.upcoming;
    if (up && (up.items.length || up.more)) {
      const dayFmt = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      const section = el('div', 'upcoming');
      section.append(el('p', 'upcoming-head', 'Coming up · next 3 months'));
      for (const e of up.items) {
        const row = el('div', 'row');
        const line = el('div', 'row-line');
        const time = el('time', 'up-date', dayFmt(e.start));
        time.dateTime = e.start;
        // Weeks out, the hour matters less than the title: give the title the room, time on hover.
        const title = el('span', 'row-title', e.title + (e.repeats ? ' ↻' : ''));
        line.title = `${e.title}${e.allDay ? '' : ` · ${hhmm(e.start)}`}${e.repeats ? ' · repeats' : ''}`;
        line.append(time, title);
        row.append(line);
        section.append(row);
      }
      if (up.more) section.append(el('p', 'card-empty upcoming-more', `+${up.more} more`));
      body.append(section);
    } else if (up) body.append(el('p', 'card-empty upcoming-more', 'Nothing else in the next 3 months.'));
    if (c.free) $('day-foot').textContent = `Free from ${hhmm(c.free.start)} to ${hhmm(c.free.end)}`;
    else if (c.tomorrow) $('day-foot').textContent = `Tomorrow: ${c.tomorrow.allDay ? 'all day' : hhmm(c.tomorrow.start)} · ${c.tomorrow.title}`;
  }

  // Initials on a grey disc; colour is kept for state (amber = needs you).
  function avatar(from) {
    const words = from.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
    return el('span', 'avatar', initials);
  }
  function mailWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return hhmm(iso);
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function renderMail(d) {
    const body = $('mail-body');
    $('mail-count').textContent = '';
    if (d.google !== 'on') return body.replaceChildren(emptyLine('Connect Google in Settings to see your email here.'));
    const m = d.mail;
    if (m.error) return body.replaceChildren(emptyLine('Couldn’t reach Gmail just now.'));
    $('mail-count').textContent = String(m.unread);
    if (!m.latest.length) return body.replaceChildren(emptyLine('Nothing unread. Nice.'));
    body.replaceChildren(
      ...m.latest.map((x) => {
        const row = el('div', 'mail-row');
        const text = el('div', 'mail-text');
        const top = el('div', 'mail-top');
        top.append(el('strong', '', x.from), el('span', '', mailWhen(x.at)));
        text.append(top, el('span', 'mail-sub', x.subject));
        row.append(avatar(x.from), text);
        return row;
      }),
    );
  }

  // The clock and progress bars move without asking Google again.
  function tickHome() {
    renderHead();
    if (mode !== 'home' || page.hidden) return;
    if (lastDash) renderDay(lastDash);
  }

  function renderNeeds() {
    const items = [];
    if (pendingCount) items.push([`${pendingCount} approval${pendingCount === 1 ? '' : 's'} waiting`, () => {
      const first = $('home-approvals').querySelector('.approval:not(.settled)');
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      first?.querySelector('.approve').focus({ preventScroll: true });
    }]);
    if (googleState.hasClient && !googleState.connected) items.push(['Reconnect Google', () => show('settings')]);
    $('needs-count').textContent = items.length ? String(items.length) : '';
    if (!items.length) return $('needs-body').replaceChildren(el('p', 'all-clear', '✓ All clear'));
    $('needs-body').replaceChildren(
      ...items.map(([label, go]) => {
        const b = el('button', 'needs-item', label);
        b.type = 'button';
        b.addEventListener('click', go);
        return b;
      }),
    );
  }

  let refreshing = false;
  async function refreshDashboard(fresh = false) {
    if (mode !== 'home' || page.hidden || refreshing) return;
    refreshing = true;
    try {
      const d = await api.dashboard({ fresh });
      lastDash = d;
      renderHead();
      renderDay(d);
      renderMail(d);
      renderNeeds();
    } finally {
      refreshing = false;
    }
  }

  for (const [id, text] of [
    ['card-day', 'Walk me through the rest of my day.'],
    ['card-mail', 'Summarize my unread email.'],
  ]) {
    const card = $(id);
    card.addEventListener('click', () => sendMessage(text));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        sendMessage(text);
      }
    });
  }

  // ---------- start ----------
  (async function start() {
    const st = await api.status();
    prefs = await api.getSettings();
    renderAutoListen();
    googleState = await api.googleStatus();
    applyName(st.name);
    updateOrb();
    for (const item of await api.history()) {
      if (item.role === 'user') addUser(item.text);
      else if (item.role === 'assistant') addAssistant(item.text);
      else if (item.role === 'error') addNote('error', item.text);
      else if (item.role === 'reminder') addNote('reminder', `Reminder: ${item.text}`);
      else if (item.role === 'briefing' || item.role === 'mail') addNote('reminder', item.text);
    }
    for (const card of await api.pendingApprovals()) addApproval(card);
    intro();
    setMode('home');
    updateOrb();
    input.focus();
    setInterval(tickHome, 20_000);
    window.addEventListener('resize', renderHead);
    setInterval(() => refreshDashboard(), 60_000);
    setInterval(returnHome, 60_000);
    window.addEventListener('focus', () => refreshDashboard());
  })();
})();
