// /js/admin_settings.js

// ===== utilities =====
async function fetchJSON(url, opts) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `${r.status} ${r.statusText}`);
  return j;
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function escapeHTML(s) { return String(s ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

// ===== settings rows (view → edit like example prompts) =====
const MOUNT_ID = 'admin-settings';
const FIELDS = [
  { key: 'introduction_prompt', label: 'Introduction prompt' },
  { key: 'system_prompt', label: 'System prompt' },
];

// Template for each setting row
function rowTemplate({ key, label, value }) {
  const id = `setting-${key}`;
  return el(`
    <div class="setting-row" data-key="${key}">
      <div class="setting-head">
        <div class="setting-title">${label}</div>
        <div class="setting-actions">
          <button class="btn-xs btn-plain js-edit">Edit</button>
          <button class="btn-xs btn-primary-xs js-save" style="display:none">Save</button>
          <button class="btn-xs btn-plain js-cancel" style="display:none">Cancel</button>
        </div>
      </div>

      <div class="setting-view" id="${id}-view">${escapeHTML(value)}</div>

      <div class="setting-edit" id="${id}-edit">
        <textarea>${escapeHTML(value)}</textarea>
      </div>
    </div>
  `);
}

// Handles edit / save / cancel for each row
function wireRowInteractions(rowEl) {
  const key = rowEl.dataset.key;
  const view = rowEl.querySelector('.setting-view');
  const editWrap = rowEl.querySelector('.setting-edit');
  const textarea = editWrap.querySelector('textarea');

  const btnEdit = rowEl.querySelector('.js-edit');
  const btnSave = rowEl.querySelector('.js-save');
  const btnCancel = rowEl.querySelector('.js-cancel');
  const status = document.getElementById('settings-status'); // ✅ ensures it exists

  // Switch to edit mode
  const enterEdit = () => {
    rowEl.classList.add('is-editing');
    btnEdit.style.display = 'none';
    btnSave.style.display = '';
    btnCancel.style.display = '';
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  };

  // Exit edit mode
  const exitEdit = (restore) => {
    if (restore) textarea.value = view.textContent;
    rowEl.classList.remove('is-editing');
    btnEdit.style.display = '';
    btnSave.style.display = 'none';
    btnCancel.style.display = 'none';
  };

  btnEdit.addEventListener('click', enterEdit);
  btnCancel.addEventListener('click', () => exitEdit(true));

  // Save the prompt to Supabase
  btnSave.addEventListener('click', async () => {
    try {
      if (status) status.textContent = 'Saving…';
      const payload = { [key]: textarea.value };
      await fetchJSON('/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // Update visible text
      view.textContent = textarea.value;
      exitEdit(false);

      // Refresh system prompt in memory if needed
      if (key === 'system_prompt') {
        try {
          await fetch('/admin/reload-system-prompt', {
            method: 'POST',
            credentials: 'same-origin',
          });
        } catch {}
      }

      if (status) {
        status.textContent = 'Saved ✓';
        setTimeout(() => (status.textContent = ''), 1500);
      }
    } catch (e) {
      console.error('Save failed:', e);
      alert('Save failed. Check console for details.');
      if (status) status.textContent = 'Save failed ❌';
    }
  });
}

// Renders all setting rows
async function renderSettingsPanel() {
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;

  const { settings } = await fetchJSON('/admin/settings');
  mount.innerHTML = '';
  FIELDS.forEach(({ key, label }) => {
    const value = settings?.[key] ?? '';
    const row = rowTemplate({ key, label, value });
    mount.appendChild(row);
    wireRowInteractions(row);
  });
}

// ===== inline brand-subtitle editor =====
async function setupBrandSubtitleInlineEditor() {
  const mount = document.getElementById('brand-subtitle-editor');
  if (!mount) return;

  const { settings } = await fetchJSON('/admin/settings');
  const current = (settings?.tool_secondary_name || '').trim();

  mount.innerHTML = `
    <span class="brand-subtitle">${escapeHTML(current || '—')}</span>
    <input class="brand-subtitle-input" type="text" value="${escapeHTML(current)}" />
    <div class="inline-actions">
      <button class="btn-xs btn-primary-xs js-save">Save</button>
      <button class="btn-xs btn-plain js-cancel">Cancel</button>
    </div>
    <button class="btn-xs btn-plain js-edit">Edit</button>
  `;

  const span = mount.querySelector('.brand-subtitle');
  const input = mount.querySelector('.brand-subtitle-input');
  const edit = mount.querySelector('.js-edit');
  const save = mount.querySelector('.js-save');
  const cancel = mount.querySelector('.js-cancel');

  const enterEdit = () => {
    mount.classList.add('is-editing');
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  const exitEdit = (restore) => {
    if (restore) input.value = span.textContent.trim() === '—' ? '' : span.textContent.trim();
    mount.classList.remove('is-editing');
  };

  edit.addEventListener('click', enterEdit);
  cancel.addEventListener('click', () => exitEdit(true));

  save.addEventListener('click', async () => {
    const value = input.value.trim();
    try {
      await fetchJSON('/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_secondary_name: value }),
      });
      document
        .querySelectorAll('.brand-subtitle')
        .forEach((el) => (el.textContent = value || '—'));
      exitEdit(false);
    } catch (e) {
      console.error('Save failed:', e);
      alert('Could not save subtitle. Check console for details.');
    }
  });
}

// ===== boot =====
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await renderSettingsPanel();
    await setupBrandSubtitleInlineEditor();
  } catch (e) {
    console.error('Failed to initialize admin settings:', e);
    const mount = document.getElementById(MOUNT_ID);
    if (mount)
      mount.innerHTML = `<div class="muted">Couldn’t load settings.</div>`;
  }
});
