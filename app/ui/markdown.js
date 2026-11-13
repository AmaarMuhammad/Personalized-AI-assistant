// A small Markdown renderer that builds DOM nodes directly (never innerHTML),
// so nothing in a reply can inject markup or script into the window.
(function () {
  'use strict';

  const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

  function link(text, url) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = text;
    a.title = url;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.jarvis.openLink(url);
    });
    return a;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const t = m[0];
      if (m[1]) {
        const c = document.createElement('code');
        c.textContent = t.slice(1, -1);
        parent.append(c);
      } else if (m[2]) {
        const b = document.createElement('strong');
        inline(b, t.slice(2, -2));
        parent.append(b);
      } else if (m[3]) {
        const i = document.createElement('em');
        inline(i, t.slice(1, -1));
        parent.append(i);
      } else if (m[4]) {
        const label = t.slice(1, t.indexOf(']('));
        parent.append(link(label, m[5]));
      } else {
        parent.append(link(t, t));
      }
      last = m.index + t.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(md) {
    const root = document.createDocumentFragment();
    const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
        i++;
        code.textContent = body.join('\n');
        pre.append(code);
        root.append(pre);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const el = document.createElement(h[1].length <= 2 ? 'h3' : 'h4');
        inline(el, h[2]);
        root.append(el);
        i++;
        continue;
      }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          const li = document.createElement('li');
          inline(li, lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
          list.append(li);
          i++;
        }
        root.append(list);
        continue;
      }
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        root.append(document.createElement('hr'));
        i++;
        continue;
      }
      const p = document.createElement('p');
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
      para.forEach((l, n) => {
        if (n) p.append(document.createElement('br'));
        inline(p, l);
      });
      root.append(p);
    }
    return root;
  }

  window.renderMarkdown = render;
})();
