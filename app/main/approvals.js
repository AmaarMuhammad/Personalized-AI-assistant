// Pending "Jarvis wants to…" requests waiting for your Approve / Deny.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

export class Approvals extends EventEmitter {
  constructor({ timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  // Resolves to 'once' | 'always' | 'deny'. Never resolves to an allow on its
  // own: a timeout, a cancelled turn or a closed app all mean "deny".
  request(card, signal) {
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (choice) => {
        const slot = this.pending.get(id);
        if (!slot) return;
        clearTimeout(slot.timer);
        this.pending.delete(id);
        this.emit('settled', { id, choice });
        resolve(choice);
      };
      const timer = setTimeout(() => finish('deny'), this.timeoutMs);
      this.pending.set(id, { card: { id, ...card }, finish, timer });
      signal?.addEventListener?.('abort', () => finish('deny'), { once: true });
      this.emit('request', { id, ...card });
    });
  }

  // Called from the UI. Unknown ids and unexpected values are ignored, and
  // "always" is only honoured where the card offered it.
  answer(id, choice) {
    const slot = this.pending.get(id);
    if (!slot) return false;
    if (!['once', 'always', 'deny'].includes(choice)) return false;
    if (choice === 'always' && !slot.card.canAlways) choice = 'once';
    slot.finish(choice);
    return true;
  }

  list() {
    return [...this.pending.values()].map((s) => s.card);
  }

  denyAll() {
    for (const slot of [...this.pending.values()]) slot.finish('deny');
  }
}
