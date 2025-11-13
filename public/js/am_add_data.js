// /js/admin_add_data.js
import { enforceRole } from '/js/auth_guard.js';
import { applyProjectSettings } from '/js/project_settings.js';

await enforceRole({ requiredRole: 'admin' });
applyProjectSettings().catch(() => {});

const els = {
  form: document.getElementById('ingest-form'),
  file: document.getElementById('file'),
  doc_name: document.getElementById('doc_name'),        // REQUIRED: used as the document name
  uploaded_by: document.getElementById('uploaded_by'),  // REQUIRED: used for every row
  previewWrap: document.getElementById('preview'),
  previewMeta: document.getElementById('preview-meta'),
  previewTable: document.getElementById('preview-table'),
  status: document.getElementById('status'),
  btnPreview: document.getElementById('btn-preview'),
  btnUpload: document.getElementById('btn-upload'),
  btnDownloadPreview: document.getElementById('btn-download-preview'),
  confirm: document.getElementById('confirm'),
};

let lastPreview = null; // { rows, document_id, csv }
let uploading = false;

function setBusy(b) {
  els.status.textContent = b ? 'Working…' : '';
  els.btnPreview.disabled = b;
  els.btnUpload.disabled = b || !lastPreview || !els.confirm.checked;
}

function escapeHtml(s){
  return String(s ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;');
}

function buildFormData(action) {
  const fd = new FormData();
  const file = els.file.files?.[0];
  if (file) fd.append('file', file);
  fd.append('doc_name', (els.doc_name?.value || '').trim());       // ← from form
  fd.append('uploaded_by', (els.uploaded_by?.value || '').trim()); // ← from form
  fd.append('action', action); // 'preview' | 'upload'
  return fd;
}

function renderPreview(rows, document_id) {
  if (!rows?.length) {
    els.previewWrap.style.display = 'none';
    return;
  }
  els.previewWrap.style.display = '';

  const docName = rows[0]?.doc_name || '(unknown)';
  els.previewMeta.innerHTML =
    `Parsed <strong>${rows.length}</strong> row(s) for <code>${escapeHtml(docName)}</code> · document_id: <code>${escapeHtml(document_id || '')}</code>`;

  const head = `
    <thead>
      <tr>
        <th>document_id</th>
        <th>doc_name</th>
        <th>uploaded_by</th>
        <th>chunk_index</th>
        <th>datum</th>
        <th>naam</th>
        <th>bron</th>
        <th>link</th>
        <th>invloed_text</th>
        <th>content</th>
      </tr>
    </thead>`;

  const body = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.document_id || '')}</td>
      <td>${escapeHtml(r.doc_name || '')}</td>
      <td>${escapeHtml(r.uploaded_by || '')}</td>
      <td>${(r.chunk_index ?? '')}</td>
      <td>${escapeHtml(r.datum || '')}</td>
      <td>${escapeHtml(r.naam || '')}</td>
      <td>${escapeHtml(r.bron || '')}</td>
      <td>${escapeHtml(r.link || '')}</td>
      <td>${escapeHtml(r.invloed_text || '')}</td>
      <td>${escapeHtml(r.content || '')}</td>
    </tr>
  `).join('');

  els.previewTable.innerHTML = `<table class="pp-table">${head}<tbody>${body}</tbody></table>`;
}

// ──────────────────────────────────────────────────────────
// Events
// ──────────────────────────────────────────────────────────
els.btnPreview.addEventListener('click', async () => {
  if (!els.file.files?.length) return alert('Please choose a .csv or .xlsx file');
  if (!els.doc_name.value.trim()) return alert('Please enter a document name');
  if (!els.uploaded_by.value.trim()) return alert('Please choose "Uploaded by"');

  setBusy(true);
  try {
    const r = await fetch('/admin/ingest', {
      method: 'POST',
      body: buildFormData('preview'),
      credentials: 'same-origin'
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || 'Failed to parse file');

    lastPreview = { rows: j.rows || [], document_id: j.document_id || null, csv: j.csv || '' };
    renderPreview(lastPreview.rows, lastPreview.document_id);
    els.btnUpload.disabled = !els.confirm.checked;
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
});

els.confirm.addEventListener('change', () => {
  els.btnUpload.disabled = uploading || !lastPreview || !els.confirm.checked;
});

els.btnDownloadPreview.addEventListener('click', () => {
  if (!lastPreview?.csv) return;
  const blob = new Blob([lastPreview.csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const docName = (lastPreview.rows?.[0]?.doc_name || 'preview');
  const safe = String(docName).replace(/[^\w.-]+/g, '_').slice(0, 80);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}_preview.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

els.btnUpload.addEventListener('click', async () => {
  if (!lastPreview) return alert('Please build a preview first.');
  if (!els.confirm.checked) return alert('Please confirm the preview is correct.');
  uploading = true;
  setBusy(true);
  try {
    const r = await fetch('/admin/ingest', {
      method: 'POST',
      body: buildFormData('upload'),
      credentials: 'same-origin'
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || 'Upload failed');

    alert(`Uploaded ${j.count} row(s) for document ${lastPreview.rows?.[0]?.doc_name || ''}.`);
    lastPreview = null;
    els.previewWrap.style.display = 'none';
    els.form.reset();
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    uploading = false;
    setBusy(false);
  }
});
