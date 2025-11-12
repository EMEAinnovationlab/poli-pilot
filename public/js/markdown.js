// markdown.js
// expects global 'marked' already loaded (as in your current setup)

export function injectMarkdownStyles() {
  if (document.getElementById('assistant-styles-markdown')) return;
  const style = document.createElement('style');
  style.id = 'assistant-styles-markdown';
  style.textContent = `
    .msg.assistant .content span.w { opacity: 0; animation: wordFadeIn 220ms ease forwards; will-change: opacity; }
    @keyframes wordFadeIn { to { opacity: 1; } }
    .msg.assistant.initializing { opacity: 0.85; transition: opacity 160ms ease; }
    .msg.assistant.initializing.ready { opacity: 1; }
  `;
  document.head.appendChild(style);
}

function isInsideTag(el, tagNames) {
  let n = el;
  const set = new Set(tagNames.map(t => t.toUpperCase()));
  while (n && n !== document.body) {
    if (n.nodeType === 1 && set.has(n.tagName)) return true;
    n = n.parentNode;
  }
  return false;
}

function collectTextNodes(root, out = []) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_ACCEPT;
      if (isInsideTag(node.parentNode, ['PRE', 'CODE', 'SCRIPT', 'STYLE'])) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let cur;
  while ((cur = walker.nextNode())) out.push(cur);
  return out;
}

function wrapNewPortionWithFades(root, prevCharCount, delayStartMs = 0, stepMs = 22) {
  const nodes = collectTextNodes(root);
  let seen = 0;
  let applied = 0;
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const len = text.length;
    if (seen + len <= prevCharCount) { seen += len; continue; }
    const startInNode = Math.max(0, prevCharCount - seen);
    const before = text.slice(0, startInNode);
    const after = text.slice(startInNode);
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const parts = after.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        span.className = 'w';
        span.style.animationDelay = `${delayStartMs + applied * stepMs}ms`;
        span.textContent = part;
        frag.appendChild(span);
        applied++;
      }
    }
    node.replaceWith(frag);
    seen += len;
  }
  return applied;
}

export function renderMarkdownAndFadeNew(contentEl, rawText) {
  const prevCharCount = contentEl._charCount || 0;
  const html = marked.parse(rawText || '');
  contentEl.innerHTML = html;
  const totalChars = (contentEl.textContent || '').length;
  const added = Math.max(0, totalChars - prevCharCount);
  if (added > 0) wrapNewPortionWithFades(contentEl, prevCharCount, 0, 22);
  contentEl._charCount = totalChars;
}
