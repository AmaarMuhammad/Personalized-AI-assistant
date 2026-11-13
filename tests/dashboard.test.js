// The dashboard: the right slice of today, readable senders, and Google kept off the
// Claude path, cached, and isolated so one failing API doesn't blank the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderName, calendarCard, upcomingCard, Dashboard } from '../app/main/dashboard.js';

const at = (h, m = 0, d = 0) => new Date(2026, 9, 9 + d, h, m).toISOString();
const ev = (summary, h1, h2, extra = {}) => ({ summary, status: 'confirmed', start: { dateTime: at(h1) }, end: { dateTime: at(h2) }, ...extra });

test('senders read as names', () => {
  assert.equal(senderName('Ali Khan <ali@example.com>'), 'Ali Khan');
  assert.equal(senderName('"HBL Alerts" <alerts@hbl.example>'), 'HBL Alerts');
  assert.equal(senderName('sara@example.com'), 'sara');
  assert.equal(senderName(''), 'Unknown sender');
});

test('Today shows what is left of the day, the current meeting, and the next free half hour', () => {
  const now = new Date(2026, 9, 9, 11, 15);
  const card = calendarCard(
    [
      ev('Standup', 9, 10),
      ev('Design review', 11, 12),
      ev('Lunch I declined', 13, 14, { attendees: [{ self: true, responseStatus: 'declined' }] }),
      ev('Cancelled', 15, 16, { status: 'cancelled' }),
      ev('Call with Ali', 12, 13),
      ev('Tomorrow thing', 9, 10, { start: { dateTime: at(9, 0, 1) }, end: { dateTime: at(10, 0, 1) } }),
    ].sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime)),
    now,
  );
  assert.deepEqual(card.events.map((e) => e.title), ['Design review', 'Call with Ali']);
  assert.equal(card.events[0].now, true);
  assert.equal(new Date(card.free.start).getHours(), 13, 'free after the call, since the declined lunch doesn’t count');
  assert.equal(card.tomorrow, null);
});

test('when today is done, Today points at tomorrow', () => {
  const card = calendarCard([ev('Standup', 9, 10, { start: { dateTime: at(9, 0, 1) }, end: { dateTime: at(10, 0, 1) } })], new Date(2026, 9, 9, 19, 0));
  assert.equal(card.events.length, 0);
  assert.equal(card.free, null, 'no working hours left');
  assert.equal(card.tomorrow.title, 'Standup');
});

test('Google is asked at most every two minutes, and one failing API leaves the other card working', async () => {
  let now = new Date(2026, 9, 9, 8);
  const calls = [];
  const call = async (_m, url) => {
    calls.push(url);
    if (url.includes('/events')) throw new Error('Calendar is down');
    if (url.endsWith('/labels/INBOX')) return { messagesUnread: 2 };
    if (url.includes('/messages') && !url.includes('/messages/')) return { messages: [{ id: 'a' }] };
    return { payload: { headers: [{ name: 'From', value: 'Ali <a@x.com>' }, { name: 'Subject', value: 'Hi' }] } };
  };
  const d = new Dashboard({ connected: () => true, call, now: () => now });
  const first = await d.get();
  assert.match(first.calendar.error, /Calendar is down/);
  assert.deepEqual(first.mail, { unread: 2, latest: [{ from: 'Ali', subject: 'Hi', at: null }] });
  const n = calls.length;
  await d.get();
  assert.equal(calls.length, n, 'served from the cache');
  now = new Date(now.getTime() + 121_000);
  await d.get();
  assert.ok(calls.length > n, 'asked again after two minutes');
  await d.get({ fresh: true });
  assert.ok(calls.length > n + 3, 'a fresh request skips the cache');
});

test('without Google, the dashboard asks nothing', async () => {
  const d = new Dashboard({ connected: () => false, call: async () => assert.fail('no Google calls') });
  const r = await d.get();
  assert.equal(r.google, 'off');
});

test('Coming up: the next 3 months after tomorrow, soonest first, a repeating event once', () => {
  const now = new Date(2026, 9, 9, 11, 0);
  const day = (d, h = 10) => new Date(2026, 9, 9 + d, h).toISOString();
  const e = (summary, d, extra = {}) => ({ summary, status: 'confirmed', start: { dateTime: day(d) }, end: { dateTime: day(d, 11) }, ...extra });
  const card = upcomingCard([
    e('Tomorrow, already on the card', 1),
    e('Exam', 20),
    e('Class', 3, { recurringEventId: 'wk' }),
    e('Class', 10, { recurringEventId: 'wk' }),
    e('Declined trip', 5, { attendees: [{ self: true, responseStatus: 'declined' }] }),
    e('Cancelled', 6, { status: 'cancelled' }),
    { summary: 'Eid', status: 'confirmed', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } },
    e('Too far out', 95),
  ], now);
  assert.deepEqual(card.items.map((x) => x.title), ['Class', 'Exam', 'Eid']);
  assert.equal(card.items[0].repeats, true);
  assert.equal(card.items[2].allDay, true);
  assert.equal(card.more, 0);
  assert.equal(card.days, 90);
});

test('Coming up shows three and counts the rest', () => {
  const now = new Date(2026, 9, 9, 11, 0);
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, summary: `E${i}`, status: 'confirmed', start: { dateTime: new Date(2026, 9, 12 + i, 9).toISOString() }, end: { dateTime: new Date(2026, 9, 12 + i, 10).toISOString() } }));
  const card = upcomingCard(items, now);
  assert.equal(card.items.length, 3);
  assert.equal(card.more, 5);
});
