// /js/admin_data.js
import { enforceRole } from '/js/auth_guard.js';
import { applyProjectSettings } from '/js/project_settings.js';

await enforceRole({ requiredRole: 'admin' });
applyProjectSettings().catch(() => {});

const els = {
  table: document.getElementById('table'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  summary: document.getElementById('summary'),
};

let items = [];   // raw rows from backend (multiple rows per doc_name)
let grouped = []; // one row per doc_name for the table

// ──────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────
function escapeHtml(s){
  return String(s ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;');
}
function parseDate(value) {
  if (value == null || value === '') return '';
  try {
    const d = typeof value === 'number'
      ? new Date(value)
      : /^\d+$/.test(String(value)) ? new Date(Number(value))
      : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return String(value); }
}
function normalizeForCsv(r){
  return {
    doc_name: r.doc_name ?? r.name ?? r.title ?? '',
    name: r.name ?? r.uploaded_by ?? r.uploader_name ?? '',
    content: r.content ?? '',
    invloed_text: r.invloed_text ?? r.influence_text ?? '',
    datum: r.date_uploaded ? parseDate(r.date_uploaded) : '',
    bron: r.bron ?? r.source ?? '',
    link: r.link ?? r.url ?? ''
  };
}
function toCSV(rows){
  const headers = ['doc_name','name','content','invloed_text','datum','bron','link'];
  const esc = (s) => {
    const str = String(s ?? '');
    return /[",\n]/.test(str) ? `"${str.replaceAll('"','""')}"` : str;
  };
  const body = rows
    .map(normalizeForCsv)
    .map(row => headers.map(h => esc(row[h])).join(','))
    .join('\n');
  return headers.join(',') + '\n' + body;
}
function downloadCsvFor(rows, filenameBase='included_data'){
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = filenameBase.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document';
  a.href = url;
  a.download = `${safe}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function deleteDocuments(docNames = []) {
  if (!Array.isArray(docNames) || !docNames.length) return { ok: true, deleted: 0 };
  const resp = await fetch('/documents', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ doc_names: docNames })
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j?.ok) throw new Error(j?.error || 'Delete failed');
  return j; // { ok:true, deleted:number }
}

function removeDocsFromLocalState(docNames = []) {
  const set = new Set(docNames);
  items = items.filter(r => !set.has(String(r.doc_name || '').trim()));
  grouped = groupByDocName(items);
  renderTable(grouped);
  renderSummary(grouped);
}

// ──────────────────────────────────────────────────────────
function groupByDocName(rows){
  const map = new Map();
  for (const r of rows) {
    const doc = (r.doc_name ?? r.name ?? r.title ?? '').trim();
    if (!doc) continue;

    let g = map.get(doc);
    if (!g) {
      g = { doc_name: doc, uploaded_by: r.uploaded_by ?? r.name ?? r.uploader_name ?? '', date_values: new Set() };
      map.set(doc, g);
    }
    if (!g.uploaded_by && (r.uploaded_by || r.name || r.uploader_name)) {
      g.uploaded_by = r.uploaded_by || r.name || r.uploader_name || '';
    }
    if (r.date_uploaded != null && r.date_uploaded !== '') g.date_values.add(String(r.date_uploaded));
  }

  const result = [];
  for (const g of map.values()) {
    let displayDate = '';
    if (g.date_values.size === 1) displayDate = parseDate([...g.date_values][0]);
    else if (g.date_values.size > 1) displayDate = 'mixed';
    result.push({ doc_name: g.doc_name, uploaded_by: g.uploaded_by, date_uploaded_display: displayDate });
  }
  return result.sort((a,b) => a.doc_name.localeCompare(b.doc_name));
}

// ──────────────────────────────────────────────────────────
// Rendering (single-row delete only)
// ──────────────────────────────────────────────────────────
function renderTable(rows){
  if (!rows?.length) {
    els.table.innerHTML = '<p class="muted">No documents found.</p>';
    return;
  }

  const body = rows.map(r => {
    const doc = escapeHtml(r.doc_name);
    return `
      <tr>
        <td>${doc}</td>
        <td>${escapeHtml(r.uploaded_by || '')}</td>
        <td>${escapeHtml(r.date_uploaded_display || '')}</td>
        <td class="grid gap-2">
          <button class="nav-cta js-download-row" type="button" data-doc="${doc}">
            Download CSV
          </button>
          <button class="nav-cta js-delete-row" type="button" data-doc="${doc}">
            Delete
          </button>
        </td>
      </tr>
    `;
  }).join('');

  els.table.innerHTML = `
    <div class="table-actions" style="display:flex;gap:8px;margin:8px 0">
    </div>
    <table class="pp-table">
      <thead>
        <tr>
          <th>Document</th>
          <th>Uploaded by</th>
          <th>Date uploaded</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;

  // Rebind refresh (since we replaced its container)
  document.getElementById('refresh')?.addEventListener('click', load);

  const tbody = els.table.querySelector('tbody');

  // Download
  tbody?.addEventListener('click', (e) => {
    const btn = e.target.closest('.js-download-row');
    if (!btn) return;
    const doc = btn.getAttribute('data-doc') || '';
    const rowsForDoc = items.filter(r => String(r.doc_name || '').trim() === doc);
    if (!rowsForDoc.length) return;
    downloadCsvFor(rowsForDoc, `included_data_${doc}`);
  });

  // Per-row delete
  tbody?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.js-delete-row');
    if (!btn) return;
    const doc = btn.getAttribute('data-doc');
    if (!doc) return;

    if (!confirm(`Delete all data for “${doc}”? This cannot be undone.`)) return;

    els.status.textContent = 'Deleting…';
    try {
      await deleteDocuments([doc]);
      removeDocsFromLocalState([doc]);
      els.status.textContent = 'Deleted ✓';
      setTimeout(() => (els.status.textContent = ''), 1200);
    } catch (err) {
      els.status.textContent = String(err.message || err);
    }
  });
}

function renderSummary(rows){
  els.summary.innerHTML = rows?.length ? `Total documents: <strong>${rows.length}</strong>` : '';
}

// ──────────────────────────────────────────────────────────
// Data load
// ──────────────────────────────────────────────────────────
async function load(){
  els.status.textContent = 'Loading…';
  els.table.innerHTML = '';
  els.summary.textContent = '';

  try {
    const r = await fetch('/documents/list-raw', { credentials: 'same-origin' });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || 'Failed to load documents');

    items = Array.isArray(j.items) ? j.items : [];
    grouped = groupByDocName(items);

    els.status.textContent = '';
    renderTable(grouped);
    renderSummary(grouped);
  } catch (e) {
    els.status.textContent = String(e.message || e);
  }
}

// ──────────────────────────────────────────────────────────
// Wire + boot
// ──────────────────────────────────────────────────────────
els.refresh?.addEventListener('click', load);
load();
