// Turning Jarvis's written replies into something worth hearing, one sentence
// at a time, so it starts speaking before the whole answer has arrived.

import { scriptLanguage } from '../voice/engine.js';

// The note added to a message you spoke, so the reply is written for the ear.
export const SPOKEN_HINT =
  '[Voice: the user said this out loud and will hear your reply spoken. Reply for listening: short, natural sentences; no markdown, lists, tables, code or links; say numbers and times as they are spoken. Reply in the language they used: Urdu in Urdu script, English in English. Anything they must see, such as a long list, put on screen and say so in one sentence.]';

// What a reply sounds like once the things you only read are taken out.
export function speakable(text) {
  let t = String(text ?? '');
  t = t.replace(/^\s*sources?:?\s*$[\s\S]*/im, ''); // a sources list is for reading
  t = t.replace(/```[\s\S]*?```/g, ' (the code is on screen) ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, '');
  t = t.replace(/^\s*\|.*\|\s*$/gm, ''); // tables
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  t = t.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// Cuts streaming text into whole sentences (English and Urdu punctuation).
export class SentenceSplitter {
  constructor() {
    this.buffer = '';
  }

  push(delta) {
    this.buffer += delta;
    const out = [];
    const re = /[\s\S]*?(?:[.!?۔؟]+(?=\s)|\n+)/y;
    let m;
    let last = 0;
    re.lastIndex = 0;
    while ((m = re.exec(this.buffer)) && m[0].length) {
      last = re.lastIndex;
      const s = m[0].trim();
      if (s) out.push(s);
    }
    this.buffer = this.buffer.slice(last);
    return out;
  }

  flush() {
    const s = this.buffer.trim();
    this.buffer = '';
    return s ? [s] : [];
  }
}

// What Whisper writes when it hears noise or near-silence rather than you: filler sounds, and
// caption phrases it learned from videos. Sending these to Claude only spends your limit.
// "Yes", "no" and "okay" stay: they are real answers to a question Jarvis asked.
const FILLER = /^(?:u+h+|u+m+|h*m+|a+h+|o+h+|e+r+|e+h+)$/;
const NOISE_PHRASES = new Set([
  'you', 'bye', 'thank you', 'thanks', 'thank you so much', 'thank you very much', 'thanks for watching',
  'thank you for watching', 'thanks for watching and see you next time', 'see you next time',
  'please subscribe', 'subscribe', 'like and subscribe', 'subtitles by the amara org community',
  'شکریہ', 'بہت شکریہ', 'شکریہ ادا کرتا ہوں',
  // What Whisper writes for sound that isn't speech (seen in real recordings, Oct-Nov 2026).
  'music', 'foreign', 'applause', 'laughter', 'silence', 'موسیقی',
]);

export function isNoiseTranscript(text) {
  const t = String(text ?? '')
    .toLowerCase()
    // Sound descriptions, never words you said: *sad music*, [Music], (applause).
    .replace(/\*[^*]*\*|\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  if (NOISE_PHRASES.has(t)) return true;
  const words = t.split(' ');
  return words.every((w) => FILLER.test(w));
}

// One piece to say: its text and which voice speaks it.
export function utterance(sentence) {
  const text = speakable(sentence);
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return { text, language: scriptLanguage(text) };
}
