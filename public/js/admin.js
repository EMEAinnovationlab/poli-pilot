import { enforceRole } from './auth_guard.js';
await enforceRole({ requiredRole: 'admin' });

const listEl = document.getElementById('prompt-list');
const listStatus = document.getElementById('list-status');
const addBtn = document.getElementById('add-new');
const saveAllBtn = document.getElementById('save-all');
const dirtyStatus = document.getElementById('dirty-status');

let items = [];
let tempCounter = 0;
const pendingCreates = new Map(); // tmpId -> payload
const pendingUpdates = new Map(); // id -> partial payload
const pendingDeletes = new Set(); // id

const tmpId = () => `new-${++tempCounter}`;
const setDirty = (d) => dirtyStatus.textContent = d ? 'Unsaved changes' : 'All changes saved';

function markCreate(id, payload){ pendingCreates.set(id, payload); setDirty(true); }
function markUpdate(id, patch){
  if (String(id).startsWith('new-')) {
    const cur = pendingCreates.get(id) || {};
    pendingCreates.set(id, { ...cur, ...patch });
  } else {
    const cur = pendingUpdates.get(id) || {};
    pendingUpdates.set(id, { ...cur, ...patch });
  }
  setDirty(true);
}
function toggleDelete(id, cardEl){
  if (pendingDeletes.has(id)) { pendingDeletes.delete(id); cardEl.classList.remove('removed'); }
  else { pendingDeletes.add(id); cardEl.classList.add('removed'); }
  setDirty(true);
}

function cardTemplate(row){
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = row.id;

  const head = document.createElement('div');
  head.className = 'card-head';

  const titlePill = document.createElement('div');
  titlePill.className = 'card-title-pill';
  titlePill.textContent = (row.prompt_title_en || 'Untitled');

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btnEdit = document.createElement('button');
  btnEdit.className = 'icon-btn'; btnEdit.title = 'Edit';
  btnEdit.innerHTML = '<span class="icon">edit</span>';

  const btnDelete = document.createElement('button');
  btnDelete.className = 'icon-btn ghost'; btnDelete.title = 'Mark delete';
  btnDelete.innerHTML = '<span class="icon">delete</span>';

  actions.append(btnEdit, btnDelete);
  head.append(titlePill, actions);

  // Preview (EN only)
  const preview = document.createElement('div');
  preview.className = 'preview-body';
  preview.textContent = (row.prompt_full_en || '').trim() || '—';

  // Edit area (stacked EN then NL)
  const edit = document.createElement('div');
  edit.className = 'edit-area';
  edit.innerHTML = `
    <div class="form-block">
      <label>Title (EN)</label>
      <input class="i-title-en" value="${escapeHtml(row.prompt_title_en || '')}">
    </div>
    <div class="form-block">
      <label>Question (EN)</label>
      <textarea class="i-full-en">${escapeHtml(row.prompt_full_en || '')}</textarea>
    </div>
    <div class="form-block">
      <label>Titel (NL)</label>
      <input class="i-title-nl" value="${escapeHtml(row.prompt_title_nl || '')}">
    </div>
    <div class="form-block">
      <label>Vraag (NL)</label>
      <textarea class="i-full-nl">${escapeHtml(row.prompt_full_nl || '')}</textarea>
    </div>
    <div class="muted">Edits are queued. Use “save edits” (top-right) to persist.</div>
  `;

  // Wire events
  btnEdit.addEventListener('click', () => {
    const editing = card.classList.toggle('editing');
    if (editing) { // focus first field
      const input = card.querySelector('.i-title-en'); input && input.focus();
    }
  });

  btnDelete.addEventListener('click', () => toggleDelete(row.id, card));

  // Buffer changes on input
  edit.addEventListener('input', () => {
    const next = {
      prompt_title_en: card.querySelector('.i-title-en').value,
      prompt_full_en : card.querySelector('.i-full-en').value,
      prompt_title_nl: card.querySelector('.i-title-nl').value,
      prompt_full_nl : card.querySelector('.i-full-nl').value,
    };
    // mirror into visible bits
    preview.textContent = next.prompt_full_en || '—';
    titlePill.textContent = next.prompt_title_en || 'Untitled';

    markUpdate(row.id, next);
  });

  if (pendingDeletes.has(row.id)) card.classList.add('removed');

  card.append(head, preview, edit);
  return card;
}

function renderList(){
  listEl.innerHTML = '';
  if (!items.length){ listStatus.textContent = 'No questions yet.'; return; }
  listStatus.textContent = '';
  items.forEach(row => listEl.append(cardTemplate(row)));
}

async function load(){
  listStatus.textContent = 'Loading…';
  try{
    const r = await fetch('/admin/example-prompts', { credentials:'same-origin' });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || 'Failed to load');
    items = j.items || [];
    renderList();
    setDirty(false);
  }catch(e){
    listStatus.textContent = String(e.message || e);
  }
}

addBtn.addEventListener('click', () => {
  const id = tmpId();
  const row = { id, prompt_title_en:'', prompt_full_en:'', prompt_title_nl:'', prompt_full_nl:'' };
  items.unshift(row);
  markCreate(id, { ...row });
  renderList();
  // open the fresh card in edit mode
  const card = listEl.querySelector(`.card[data-id="${id}"]`);
  card?.classList.add('editing');
  card?.querySelector('.i-title-en')?.focus();
});

saveAllBtn.addEventListener('click', async () => {
  saveAllBtn.disabled = true;
  try{
    // 1) Deletes
    for (const id of pendingDeletes){
      if (String(id).startsWith('new-')) continue;
      const r = await fetch(`/admin/example-prompts/${encodeURIComponent(id)}`, { method:'DELETE', credentials:'same-origin' });
      const j = await r.json(); if (!r.ok || !j?.ok) throw new Error(j?.error || 'Delete failed');
      items = items.filter(x => x.id !== id);
    }
    pendingDeletes.clear();

    // 2) Creates
    for (const [tmp, payload] of pendingCreates.entries()){
      const r = await fetch('/admin/example-prompts', {
        method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'same-origin', body:JSON.stringify(payload)
      });
      const j = await r.json(); if (!r.ok || !j?.ok) throw new Error(j?.error || 'Create failed');
      const i = items.findIndex(x => x.id === tmp);
      if (i >= 0) items[i] = j.item;

      // move any pending updates keyed by tmp id
      if (pendingUpdates.has(tmp)){
        const patch = pendingUpdates.get(tmp);
        pendingUpdates.delete(tmp);
        pendingUpdates.set(j.item.id, patch);
      }
    }
    pendingCreates.clear();

    // 3) Updates
    for (const [id, patch] of pendingUpdates.entries()){
      const r = await fetch(`/admin/example-prompts/${encodeURIComponent(id)}`, {
        method:'PATCH', headers:{ 'Content-Type':'application/json' }, credentials:'same-origin', body:JSON.stringify(patch)
      });
      const j = await r.json(); if (!r.ok || !j?.ok) throw new Error(j?.error || 'Update failed');
      const i = items.findIndex(x => x.id === id);
      if (i >= 0) items[i] = j.item;
    }
    pendingUpdates.clear();

    renderList();
    setDirty(false);
  }catch(e){
    alert(`Save failed: ${String(e.message || e)}`);
  }finally{
    saveAllBtn.disabled = false;
  }
});

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;');
}

load();
