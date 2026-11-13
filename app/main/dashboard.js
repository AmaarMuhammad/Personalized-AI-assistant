// The home screen's cards: today's calendar, unread email and reminders. Fetched straight
// from Google by Jarvis itself, never through Claude, so the dashboard uses none of your
// Claude limit and what it shows never reaches the model.
import { freeSlots } from '../tools/google-tools.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// "Ali Khan <ali@x.com>" → "Ali Khan"; a bare address → the part before @.
export function senderName(from) {
  const s = String(from ?? '').trim();
  const named = /^"?([^"<]+?)"?\s*<[^>]+>$/.exec(s);
  if (named) return clip(named[1], 40);
  const addr = /<?([^<>@\s]+)@[^<>\s]+>?/.exec(s);
  return clip(addr ? addr[1] : s, 40) || 'Unknown sender';
}

const startOf = (e) => new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00`);
const endOf = (e) => new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00`);

// What's left of today, the next free half hour, and tomorrow's first event if today is done.
export function calendarCard(items, now) {
  const live = items.filter((e) => e.status !== 'cancelled' && !e.attendees?.some((a) => a.self && a.responseStatus === 'declined'));
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const today = live.filter((e) => endOf(e) > now && startOf(e) < endOfDay);
  const events = today.map((e) => ({
    title: clip(e.summary || '(no title)', 80),
    start: startOf(e).toISOString(),
    end: endOf(e).toISOString(),
    allDay: !e.start?.dateTime,
    now: startOf(e) <= now,
  }));
  const busy = today.filter((e) => e.start?.dateTime && e.transparency !== 'transparent').map((e) => ({ start: startOf(e), end: endOf(e) }));
  const free = freeSlots(busy, now, endOfDay, 30, '09:00', '18:00')[0];
  const later = live.filter((e) => startOf(e) >= endOfDay).sort((a, b) => startOf(a) - startOf(b))[0];
  return {
    events: events.slice(0, 4),
    more: Math.max(0, events.length - 4),
    free: free ? { start: free.start.toISOString(), end: free.end.toISOString() } : null,
    tomorrow: !events.length && later ? { title: clip(later.summary || '(no title)', 80), start: startOf(later).toISOString(), allDay: !later.start?.dateTime } : null,
  };
}

const header = (m, name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export async function mailCard(call) {
  const [inbox, list] = await Promise.all([
    call('GET', `${GMAIL}/labels/INBOX`),
    call('GET', `${GMAIL}/messages`, { query: { q: 'in:inbox is:unread', maxResults: 3 } }),
  ]);
  const msgs = await Promise.all((list.messages ?? []).map((m) => call('GET', `${GMAIL}/messages/${m.id}`, { query: { format: 'metadata' } })));
  return {
    unread: Number(inbox.messagesUnread ?? 0),
    latest: msgs.map((m) => ({
      from: senderName(header(m, 'From')),
      subject: clip(header(m, 'Subject') || '(no subject)', 90),
      at: Number.isFinite(Number(m.internalDate)) ? new Date(Number(m.internalDate)).toISOString() : null,
    })),
  };
}

// The coming months, after tomorrow: the soonest few, with a recurring series shown once
// (its next occurrence) so a weekly class doesn't fill the list.
export const UPCOMING_DAYS = 90;
export function upcomingCard(items, now, { limit = 3, days = UPCOMING_DAYS } = {}) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 + days);
  const seen = new Set();
  const list = [];
  for (const e of [...items].sort((a, b) => startOf(a) - startOf(b))) {
    if (e.status === 'cancelled' || e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
    if (startOf(e) < from || startOf(e) >= to) continue;
    const key = e.recurringEventId ?? e.id ?? `${e.summary}|${startOf(e).toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      title: clip(e.summary || '(no title)', 80),
      start: startOf(e).toISOString(),
      allDay: !e.start?.dateTime,
      repeats: !!e.recurringEventId,
    });
  }
  return { days, items: list.slice(0, limit), more: Math.max(0, list.length - limit) };
}

export async function upcomingFetch(call, now) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 + UPCOMING_DAYS);
  const data = await call('GET', `${CAL}/events`, {
    query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 250 },
  });
  return upcomingCard(data.items ?? [], now);
}

export async function calendarFetch(call, now) {
  const from = new Date(Math.min(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), now.getTime() - 4 * 3_600_000));
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const data = await call('GET', `${CAL}/events`, {
    query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 50 },
  });
  const card = calendarCard(data.items ?? [], now);
  // The months ahead are extra: if that call fails, today still shows.
  try {
    card.upcoming = await upcomingFetch(call, now);
  } catch {
    card.upcoming = null;
  }
  return card;
}

// Google answers are kept for two minutes, so opening the window often doesn't hammer the APIs.
export class Dashboard {
  constructor({ connected, call, now = () => new Date(), ttlMs = 120_000 }) {
    Object.assign(this, { connected, call, now, ttlMs });
    this.cache = null;
  }

  async get({ fresh = false } = {}) {
    const now = this.now();
    if (!this.connected()) return { at: now.toISOString(), google: 'off' };
    if (fresh || !this.cache || now - this.cache.at > this.ttlMs) {
      const [calendar, mail] = await Promise.allSettled([calendarFetch(this.call, now), mailCard(this.call)]);
      this.cache = {
        at: now,
        calendar: calendar.status === 'fulfilled' ? calendar.value : { error: calendar.reason?.message ?? 'Couldn’t reach Google Calendar.' },
        mail: mail.status === 'fulfilled' ? mail.value : { error: mail.reason?.message ?? 'Couldn’t reach Gmail.' },
      };
    }
    return { at: now.toISOString(), google: 'on', calendar: this.cache.calendar, mail: this.cache.mail };
  }
}
