// /public/js/admin_users_overview.js
document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('refresh');
  const hideEmpty  = document.getElementById('hide-empty');
  const statusEl   = document.getElementById('status');
  const tableEl    = document.getElementById('table');
  const summaryEl  = document.getElementById('summary');

  const addForm    = document.getElementById('add-user-form');
  const addEmail   = document.getElementById('add-email');
  const addRole    = document.getElementById('add-role');

  const fmt = {
    dt: (v) => {
      if (!v) return '';
      if (String(v).toLowerCase().includes('infinity')) return '∞';
      const d = new Date(v);
      return isNaN(d) ? String(v) : d.toLocaleString();
    },
    text: (v) => (v ?? '').toString(),
  };

  async function fetchData() {
    statusEl.textContent = 'Loading…';
    tableEl.innerHTML = '';
    summaryEl.textContent = 'Loading…';

    try {
      const r = await fetch('/api/admin/users_overview', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Unknown error');

      let rows = j.data || [];
      if (hideEmpty?.checked) rows = rows.filter(row => row.code && row.code.length > 0);

      renderSummary(j.data || [], rows);
      renderTable(rows);
      statusEl.textContent = rows.length ? '' : 'No results.';
    } catch (e) {
      statusEl.textContent = `Failed to load: ${e.message}`;
    }
  }

  function renderSummary(allRows, visibleRows) {
    const total = allRows.length;
    const admins = allRows.filter(r => r.role === 'admin').length;
    const withCodes = allRows.filter(r => r.code).length;

    summaryEl.innerHTML = `
      <strong>${visibleRows.length}</strong> shown of <strong>${total}</strong> users ·
      Admins: <strong>${admins}</strong> ·
      With codes: <strong>${withCodes}</strong>
    `;
  }

  function renderTable(rows) {
    if (!rows.length) { tableEl.innerHTML = ''; return; }

    const headers = [
      { key: 'email',           label: 'Email' },
      { key: 'role',            label: 'Role' },
      { key: 'code',            label: 'Code' },
      { key: 'code_created_at', label: 'Code Created' },
      { key: '__actions',       label: 'Actions' },
    ];

    const table = document.createElement('table');
    table.className = 'data-table';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';

    // THEAD
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    headers.forEach(h => {
      const th = document.createElement('th');
      th.textContent = h.label;
      th.style.textAlign = 'left';
      th.style.padding = '8px 10px';
      th.style.borderBottom = '1px solid var(--border, #ddd)';
      if (h.key !== '__actions') {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => sortBy(h.key));
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);

    // TBODY
    const tbody = document.createElement('tbody');
    rows.forEach(r => {
      const tr = document.createElement('tr');

      const tdEmail = cell(fmt.text(r.email));
      const tdRole  = cell(fmt.text(r.role));
      const tdCode  = cell(fmt.text(r.code || ''), true);
      const tdDate  = cell(fmt.dt(r.code_created_at));
      const tdAct   = document.createElement('td');
      tdAct.style.padding = '8px 10px';
      tdAct.style.borderBottom = '1px solid var(--border, #eee)';

      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.type = 'button';
      delBtn.style.padding = '6px 10px';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete user ${r.email}? This also removes their codes.`)) return;
        tdAct.textContent = 'Deleting…';
        try {
          const rr = await fetch(`/admin/users/${encodeURIComponent(r.email)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }
          });
          if (!rr.ok) throw new Error(`HTTP ${rr.status}`);
          const jj = await rr.json();
          if (!jj.ok) throw new Error(jj.error || 'Delete failed');
          await fetchData();
        } catch (e) {
          tdAct.textContent = `Error: ${e.message}`;
        }
      });

      tdAct.appendChild(delBtn);

      tr.appendChild(tdEmail);
      tr.appendChild(tdRole);
      tr.appendChild(tdCode);
      tr.appendChild(tdDate);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    tableEl.innerHTML = '';
    tableEl.appendChild(table);

    function cell(text, mono = false) {
      const td = document.createElement('td');
      td.style.padding = '8px 10px';
      td.style.borderBottom = '1px solid var(--border, #eee)';
      td.textContent = text;
      if (mono) td.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
      return td;
    }

    function sortBy(key) {
      const dirKey = '__sortDir';
      tableEl[dirKey] = tableEl[dirKey] || {};
      const dir = tableEl[dirKey][key] = tableEl[dirKey][key] === 'asc' ? 'desc' : 'asc';

      const sorted = [...rows].sort((a, b) => {
        const va = (a[key] ?? '').toString().toLowerCase();
        const vb = (b[key] ?? '').toString().toLowerCase();
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
      });
      renderTable(sorted);
    }
  }

  // Add / Update user form
  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (addEmail?.value || '').trim();
    const role  = (addRole?.value || 'member').trim();

    if (!email) return;
    addForm.querySelector('button[type="submit"]').disabled = true;

    try {
      const r = await fetch('/admin/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Save failed');

      // Clear form and refresh
      addEmail.value = '';
      addRole.value = role;
      await fetchData();
    } catch (e2) {
      alert(`Failed: ${e2.message}`);
    } finally {
      addForm.querySelector('button[type="submit"]').disabled = false;
    }
  });

  refreshBtn?.addEventListener('click', fetchData);
  hideEmpty?.addEventListener('change', fetchData);
  fetchData();
});
