// /js/main.js — ES module with top-level await

// ===== Imports (absolute paths avoid nesting issues) =====
import { enforceRole } from '/js/auth_guard.js';
import { injectStraplineStyles } from '/js/strapline.js';
import { openExamples, closeExamples, attachExampleFillHandlers } from '/js/examples.js';
import { injectMarkdownStyles } from '/js/markdown.js';
import { createChatController } from '/js/chatFlow.js';

// ===== Ensure `marked` exists (use /js/markdown.js or ESM fallback) =====
let markedRef = (typeof window !== 'undefined' && window.marked) ? window.marked : null;
if (!markedRef) {
  try {
    const { marked } = await import('https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js');
    markedRef = marked;
    if (typeof window !== 'undefined') window.marked = markedRef;
  } catch (e) {
    console.error('Failed to load marked parser:', e);
  }
}
const parseMarkdown = (md) => (markedRef ? markedRef.parse(md || '') : (md || ''));

// ===== Gate: require a session (null = any logged-in user) =====
await enforceRole({ requiredRole: null });

// ───────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────
const STRAPLINE = {
  enabled: true,
  iconUrl: '/images/brand/chat_icon.png',
  defaultText: 'POLI PILOT',
  autoStartText: 'INTRODUCTIE',
  uppercase: true,
  letterSpacing: '0.25em',
  fontSize: '12px',
  color: '#8B6A2B'
};

let DEFAULT_WELCOME_PROMPT = `
You are the assistant in a chat UI. Greet the user briefly and offer 2–3 concrete things you can do here.
Keep it concise and friendly; no emojis. Avoid generic fluff.
`;

// Load introduction prompt from backend (Supabase → /project-settings)
async function loadIntroPromptFromServer() {
  try {
    const res = await fetch('/project-settings', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to fetch settings');
    const intro = data.settings?.introduction_prompt;
    if (intro && intro.trim()) DEFAULT_WELCOME_PROMPT = intro.trim();
  } catch (err) {
    console.warn('Intro prompt fallback used:', err?.message || err);
  }
}
await loadIntroPromptFromServer();

// ───────────────────────────────────────────────────────────
// DOM
// ───────────────────────────────────────────────────────────
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const clearBtn = document.getElementById('clear');

const examplesContainer = document.getElementById('example-prompts');
const closeExamplesBtn = document.getElementById('close-examples');
const exampleCards = document.querySelectorAll('.example');
const examplesToggle = document.getElementById('toggle-examples');

if (chat) {
  chat.setAttribute('role', 'log');
  chat.setAttribute('aria-live', 'polite');
  chat.setAttribute('aria-relevant', 'additions');
}

// ───────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────
injectMarkdownStyles();
injectStraplineStyles({
  uppercase: STRAPLINE.uppercase,
  letterSpacing: STRAPLINE.letterSpacing,
  fontSize: STRAPLINE.fontSize,
  color: STRAPLINE.color
});

// ───────────────────────────────────────────────────────────
// Examples helpers
// ───────────────────────────────────────────────────────────
const examples = {
  openExamples: () => openExamples(examplesContainer, examplesToggle),
  closeExamples: (opts) => closeExamples(examplesContainer, examplesToggle, opts)
};

// ───────────────────────────────────────────────────────────
// Chat controller
// ───────────────────────────────────────────────────────────
const controller = createChatController({
  dom: { chat, input, sendBtn, stopBtn, clearBtn },
  examples,
  config: { STRAPLINE, DEFAULT_WELCOME_PROMPT }
});

// Attach example fill handlers present at load
attachExampleFillHandlers({
  exampleCards,
  input,
  autoGrowTextarea: controller.autoGrowTextarea,
  closeExamplesFn: examples.closeExamples
});

// Buttons / inputs
if (sendBtn) sendBtn.addEventListener('click', controller.sendMessage);
if (stopBtn) stopBtn.addEventListener('click', () => { /* abort handled inside chatFlow */ });
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    if (chat) chat.innerHTML = '';
    controller.resetTextareaHeight();
    examples.openExamples();
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  });
}
if (input) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      controller.sendMessage();
    }
  });
  ['input','change','paste','cut','drop'].forEach(ev =>
    input.addEventListener(ev, controller.autoGrowTextarea)
  );
  controller.autoGrowTextarea();
}

// Keep examples visible on load if chat is empty
(function maybeShowExamples() {
  if (!examplesContainer || !chat) return;
  if (chat.children.length === 0) examples.openExamples();
})();

if (examplesToggle && examplesContainer) {
  const isOpen = !examplesContainer.classList.contains('hide');
  examplesToggle.classList.toggle('hide', isOpen);
}

if (closeExamplesBtn) {
  closeExamplesBtn.addEventListener('click', () =>
    examples.closeExamples({ animate: true, scroll: true })
  );
}
if (examplesToggle) {
  examplesToggle.addEventListener('click', () => {
    examples.openExamples();
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  });
}

// Auto-start assistant greeting
controller.setButtonsStreaming(false);
if (chat && chat.children.length === 0) {
  controller.streamAssistantFromPrompt(DEFAULT_WELCOME_PROMPT, {
    echoUser: false,
    closeExamplesOnStart: false,
    straplineText: STRAPLINE.autoStartText
  });
}

// ───────────────────────────────────────────────────────────
// Context Pages (About / How it works / Included Data)
// ───────────────────────────────────────────────────────────
const modal = document.getElementById('content-modal');
const modalTitle = document.getElementById('pp-modal-title');
const modalContent = document.getElementById('pp-modal-content');

const titles = { about: 'Over Poli Pilot', how: 'Hoe het werkt', data: 'Data' };
const pagesOrder = ['Over Poli Pilot', 'Hoe het werkt', 'Data'];

function setModalOpen(open) {
  if (!modal) return;
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
  modal.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}
function closeModal() {
  setModalOpen(false);
  history.replaceState(null, '', location.pathname);
}
modal?.addEventListener('click', (e) => {
  if (e.target.matches('[data-close], .pp-modal__backdrop')) closeModal();
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Modal nav (tabs)
const navContainer = document.querySelector('.pp-modal__nav');
const navButtons   = Array.from(document.querySelectorAll('.pp-modal__nav .pp-navbtn'));

function setActiveNav(page) {
  navButtons.forEach(btn => {
    const isActive = btn.dataset.page === page;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  });
}

navContainer?.addEventListener('click', (e) => {
  const btn = e.target.closest('.pp-navbtn');
  if (!btn) return;
  const page = btn.dataset.page;
  if (!page) return;
  history.pushState(null, '', `#${page}`);
  loadSitePage(page);
});

window.addEventListener('keydown', (e) => {
  if (modal?.getAttribute('aria-hidden') === 'true') return;
  if (!['ArrowLeft','ArrowRight'].includes(e.key)) return;
  const current = navButtons.find(b => b.classList.contains('is-active'))?.dataset.page || pagesOrder[0];
  let idx = pagesOrder.indexOf(current);
  idx = e.key === 'ArrowRight' ? (idx + 1) % pagesOrder.length : (idx - 1 + pagesOrder.length) % pagesOrder.length;
  const page = pagesOrder[idx];
  history.pushState(null, '', `#${page}`);
  loadSitePage(page);
});

// Included Data table renderer
function renderIncludedDataTable(rows) {
  if (!rows || rows.length === 0) return '<p class="muted">No documents found.</p>';
  const body = rows.map(r => `
    <tr>
      <td>${(r.doc_name ?? '').toString().replace(/</g,'&lt;')}</td>
      <td>${(r.uploaded_by ?? '').toString().replace(/</g,'&lt;')}</td>
    </tr>
  `).join('');
  return `
    <table class="pp-table">
      <thead><tr><th>Bron</th><th>Data van</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

// Load About / How / Data from your backend
async function loadSitePage(page) {
  const lang = (navigator.language || 'en').toLowerCase();

  setActiveNav(page);
  setModalOpen(true);
  if (modalTitle) modalTitle.textContent = titles[page] || page;
  if (modalContent) modalContent.innerHTML = '<p class="muted">Loading…</p>';

  try {
    if (page === 'data') {
      const [contentRes, listRes] = await Promise.all([
        fetch(`/site-content?page=data&lang=${encodeURIComponent(lang)}`),
        fetch('/documents/list', { credentials: 'same-origin' })
      ]);
      const contentJson = await contentRes.json();
      const listJson = await listRes.json();
      if (!contentRes.ok || !contentJson?.ok) throw new Error(contentJson?.error || 'Failed to load page content');
      if (!listRes.ok || !listJson?.ok) throw new Error(listJson?.error || 'Failed to load document list');

      const introHTML = parseMarkdown(contentJson.content || '');
      const tableHTML = renderIncludedDataTable(listJson.items || []);
      modalContent.innerHTML = `<div class="pp-context-intro">${introHTML}</div>${tableHTML}`;
    } else {
      const r = await fetch(`/site-content?page=${encodeURIComponent(page)}&lang=${encodeURIComponent(lang)}`);
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || `Failed to load ${page}`);
      modalContent.innerHTML = parseMarkdown(j.content || '');
    }
    document.querySelector('.pp-modal__nav .pp-navbtn.is-active')?.focus();
  } catch (err) {
    modalContent.innerHTML = `<p style="color:#b10000">${String(err.message || err)}</p>`;
  }
}

// Link hooks + deep linking
const linkAbout = document.querySelector('a[href="#about"]');
const linkHow   = document.querySelector('a[href="#how"]');
const linkData  = document.querySelector('a[href="#data"]');

linkAbout?.addEventListener('click', (e) => { e.preventDefault(); history.pushState(null,'','#about'); loadSitePage('about'); });
linkHow  ?.addEventListener('click',  (e) => { e.preventDefault(); history.pushState(null,'','#how');   loadSitePage('how');   });
linkData ?.addEventListener('click',  (e) => { e.preventDefault(); history.pushState(null,'','#data');  loadSitePage('data');  });

function routeFromHash() {
  const h = (location.hash || '').toLowerCase().replace('#','');
  if (['about','how','data'].includes(h)) loadSitePage(h);
}
window.addEventListener('popstate', routeFromHash);
routeFromHash();

// ───────────────────────────────────────────────────────────
// Load example prompts (public read via backend → Supabase)
// ───────────────────────────────────────────────────────────
async function loadAndRenderExamplePrompts() {
  const grid = document.getElementById('examples-grid');
  if (!grid) return;

  const preferNl = (navigator.language || '').toLowerCase().startsWith('nl');

  try {
    const res = await fetch('/api/example-prompts');
    const data = await res.json();
    if (!res.ok || !data?.ok || !Array.isArray(data.items)) throw new Error(data?.error || 'Invalid response');

    grid.innerHTML = data.items.map(row => {
      const title = preferNl
        ? row.prompt_title_nl || row.prompt_title_en || ''
        : row.prompt_title_en || row.prompt_title_nl || '';
      const full = preferNl
        ? row.prompt_full_nl || row.prompt_full_en || ''
        : row.prompt_full_en || row.prompt_full_nl || '';

      if (!full?.trim()) return '';
      return `
        <div class="example" data-prompt="${full.replace(/"/g, '&quot;')}">
          <div class="example-title">${title || 'Example'}</div>
          <div class="example-text">${full}</div>
        </div>
      `;
    }).join('');

    const exampleCards = grid.querySelectorAll('.example');
    attachExampleFillHandlers({
      exampleCards,
      input,
      autoGrowTextarea: controller.autoGrowTextarea,
      closeExamplesFn: examples.closeExamples
    });
  } catch (err) {
    console.error('Could not load example prompts:', err);
    grid.innerHTML = `<div class="muted">Couldn’t load example prompts.</div>`;
  }
}
await loadAndRenderExamplePrompts();

// ───────────────────────────────────────────────────────────
// Mobile drawer
// ───────────────────────────────────────────────────────────
(function setupMobileDrawer() {
  const drawer = document.getElementById('nav-drawer');
  const toggle = document.querySelector('.nav-toggle');
  if (!drawer || !toggle) return;

  const openDrawer = () => {
    drawer.classList.remove('hide');
    drawer.setAttribute('aria-modal', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('no-scroll');
  };
  const closeDrawer = () => {
    drawer.classList.add('hide');
    drawer.setAttribute('aria-modal', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('no-scroll');
  };
  const isOpen = () => !drawer.classList.contains('hide');
  const toggleDrawer = () => (isOpen() ? closeDrawer() : openDrawer());

  toggle.addEventListener('click', (e) => { e.preventDefault(); toggleDrawer(); });

  drawer.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) closeDrawer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeDrawer();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820 && isOpen()) closeDrawer();
  });

  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    const clickedInside = e.target.closest('#nav-drawer') || e.target.closest('.nav-toggle');
    if (!clickedInside) closeDrawer();
  });
})();
