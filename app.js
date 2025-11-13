// app.js — Poli Pilot (CSV/XLSX ingest + RAG streaming) — Vercel-ready (no app.listen)
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

// Node 18+ has global fetch; if you’re on older Node, uncomment:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static('public'));

// ──────────────────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const DRY_RUN_EMBEDDINGS = String(process.env.DRY_RUN_EMBEDDINGS || '') === '1';

const SUPABASE_FUNCTIONS_URL = (process.env.SUPABASE_FUNCTIONS_URL || '').replace(/\/$/, '');
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY || '';
const SUPABASE_BEARER = process.env.SUPABASE_BEARER || '';
let SUPABASE_REST_URL = process.env.SUPABASE_REST_URL || '';
if (!SUPABASE_REST_URL && SUPABASE_FUNCTIONS_URL) {
  try {
    const u = new URL(SUPABASE_FUNCTIONS_URL);
    u.hostname = u.hostname.replace('.functions.', '.supabase.');
    u.pathname = '/rest/v1';
    SUPABASE_REST_URL = u.toString().replace(/\/$/, '');
  } catch {}
}

const APP_JWT_SECRET = process.env.APP_JWT_SECRET || 'dev_secret_change_me';

const RAG_DEFAULTS = {
  match_count: Number(process.env.RAG_MATCH_COUNT || 6),
  match_threshold: Number(process.env.RAG_MATCH_THRESHOLD || 0),
  search_mode: process.env.RAG_SEARCH_MODE || 'both',
  uploaded_by: process.env.RAG_UPLOADED_BY || null
};

console.log('🔧 REST :', SUPABASE_REST_URL);
console.log('🔧 FXN  :', SUPABASE_FUNCTIONS_URL);

// ──────────────────────────────────────────────────────────
let SYSTEM_PROMPT = `You are Poli Pilot, a concise assistant. Cite sources inline like [#n].`;

// Basic SSE helper used by /chat
function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Supabase REST helper
async function supabaseRest(path, { method = 'GET', body, headers = {} } = {}) {
  if (!SUPABASE_REST_URL) throw new Error('Missing SUPABASE_REST_URL');

  const url = `${SUPABASE_REST_URL}${path}`;
  const allHeaders = {
    'Content-Type': 'application/json',
    ...(SUPABASE_API_KEY ? { apikey: SUPABASE_API_KEY } : {}),
    ...(SUPABASE_BEARER ? { Authorization: `Bearer ${SUPABASE_BEARER}` } : {}),
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
    ...headers
  };

  const r = await fetch(url, {
    method,
    headers: allHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }

  if (!r.ok) {
    console.error(`[Supabase REST ${method}] ${url} -> ${r.status}`, json);
    throw new Error(`${r.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// System prompt refresher
async function fetchSystemPromptFromDB() {
  try {
    const rows = await supabaseRest(
      `/project_settings?select=setting_content&setting_name=eq.system_prompt&limit=1`
    );
    const content =
      Array.isArray(rows) && rows[0]?.setting_content
        ? String(rows[0].setting_content).trim()
        : '';
    if (content) SYSTEM_PROMPT = content;
  } catch (e) {
    console.warn('⚠️ Could not fetch system prompt:', e.message || e);
  }
}
fetchSystemPromptFromDB();
setInterval(fetchSystemPromptFromDB, 60000);

// ──────────────────────────────────────────────────────────
// JWT + Cookies
// ──────────────────────────────────────────────────────────
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function signJwt(payload, secret, expiresSec = 60 * 60 * 24 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expiresSec, ...payload };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${sig}`;
}
function verifyJwt(token, secret) {
  try {
    const [h, p, sig] = token.split('.');
    const data = `${h}.${p}`;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    if (expected !== sig) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  return h.split(';').reduce((acc, kv) => {
    const [k, ...v] = kv.trim().split('=');
    if (!k) return acc;
    acc[k] = decodeURIComponent(v.join('='));
    return acc;
  }, {});
}
function setCookie(res, name, value, opts = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const {
    httpOnly = true,
    secure = isProd,
    sameSite = 'Lax',
    path = '/',
    maxAge = 60 * 60 * 24 * 7
  } = opts;
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader(
    'Set-Cookie',
    `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
  );
}

// ──────────────────────────────────────────────────────────
// OpenAI embeddings (not used in admin auth, kept for ingest)
// ──────────────────────────────────────────────────────────
async function createEmbeddingsBatch({ model, inputs, apiKey }) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input: inputs })
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`OpenAI embeddings failed: ${r.status}`);
  return (json?.data || []).map((d) => d.embedding || null);
}

// ──────────────────────────────────────────────────────────
// Router (mounted both at "/" and "/api")
// ──────────────────────────────────────────────────────────
const api = express.Router();
app.use('/api', api);
app.use('/', api);

// Health check
api.get('/health', (_, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────
// Auth: manual verify (one-time codes)
// ──────────────────────────────────────────────────────────
// ─── Admin login (no 'enabled' column in admin_login_codes) ───────────────
api.post('/auth/admin/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const raw   = (req.body?.code  || '').trim();
    if (!email || !raw) {
      return res.status(400).json({ ok: false, error: 'Missing email or code' });
    }

    // user must exist
    const users = await supabaseRest(
      `/users?select=email,role&email=ilike.${encodeURIComponent(email)}&limit=1`
    );
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email not enabled' });
    }

    // accept both exact text and numeric variant (handles leading zeros)
    const candidates = [raw];
    if (/^\d+$/.test(raw)) candidates.push(String(Number(raw)));
    const orParts = candidates.map(v => `code.eq.${encodeURIComponent(v)}`).join(',');

    // your table has (at least) code, maybe email; do NOT select/check 'enabled'
    const rows = await supabaseRest(
      `/admin_login_codes?select=code,email&or=(${orParts})&limit=1`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid admin code' });
    }

    const row = rows[0];
    // if the table binds codes to an email, enforce it
    if (row.email && String(row.email).toLowerCase() !== email.toLowerCase()) {
      return res.status(401).json({ ok: false, error: 'Admin code not valid for this email' });
    }

    const token = signJwt({ sub: users[0].email, role: 'admin' }, APP_JWT_SECRET);
    setCookie(res, 'pp_session', token, { sameSite: 'Lax' });
    return res.json({ ok: true, user: { email: users[0].email, role: 'admin' } });
  } catch (e) {
    console.error('[auth/admin/verify] error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server error' });
  }
});


// ──────────────────────────────────────────────────────────
// Auth: admin verify (non-expiring codes in admin_login_codes)
// ──────────────────────────────────────────────────────────
api.post('/auth/admin/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const code  = (req.body?.code  || '').trim();
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: 'Missing email or code' });
    }

    // Ensure user exists
    const users = await supabaseRest(
      `/users?select=email,role&email=ilike.${encodeURIComponent(email)}&limit=1`
    );
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email not enabled' });
    }

    // Read admin code; schema assumptions:
    // admin_login_codes(code text PK, enabled bool, email text nullable)
    const adminRows = await supabaseRest(
      `/admin_login_codes?select=code,enabled,email&code=eq.${encodeURIComponent(code)}&limit=1`
    );
    if (!Array.isArray(adminRows) || adminRows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid admin code' });
    }

    const row = adminRows[0];
    // enabled === false blocks; if null/true treat as enabled
    if (row.enabled === false) {
      return res.status(401).json({ ok: false, error: 'Admin code disabled' });
    }
    // Optional: bind code to a specific email if table provides email
    if (row.email && String(row.email).toLowerCase() !== email.toLowerCase()) {
      return res.status(401).json({ ok: false, error: 'Admin code not valid for this email' });
    }

    // Admin codes do NOT expire and are NOT one-time → no mutation here
    const token = signJwt(
      { sub: users[0].email, role: 'admin' },
      APP_JWT_SECRET
    );
    setCookie(res, 'pp_session', token, { sameSite: 'Lax' });

    return res.json({ ok: true, user: { email: users[0].email, role: 'admin' } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Server error' });
  }
});

// Session check / logout
api.get('/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.pp_session;
  const payload = token ? verifyJwt(token, APP_JWT_SECRET) : null;
  if (!payload) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: { email: payload.sub, role: payload.role } });
});
api.post('/auth/logout', (req, res) => {
  clearCookie(res, 'pp_session');
  res.json({ ok: true });
});




// ──────────────────────────────────────────────────────────
// Auth/manual/verify
// ──────────────────────────────────────────────────────────

api.post('/auth/manual/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const raw   = (req.body?.code  || '').trim();
    if (!email || !raw) {
      return res.status(400).json({ ok: false, error: 'Missing email or code' });
    }

    // Ensure the user exists (member or admin)
    const users = await supabaseRest(
      `/users?select=email,role&email=ilike.${encodeURIComponent(email)}&limit=1`
    );
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email not enabled' });
    }

    // Accept either exact text or numeric string variant (handles leading zeros)
    const candidates = [];
    candidates.push(raw);
    if (/^\d+$/.test(raw)) candidates.push(String(Number(raw)));

    const orParts = candidates.map(v => `code.eq.${encodeURIComponent(v)}`).join(',');

    // No expiry check. Only ensure correct email AND code unused.
    const query =
    `/login_codes` +
    `?select=code,email,used_at` +
    `&or=(${orParts})` +
    `&email=ilike.${encodeURIComponent(email)}` +
    `&used_at=is.null` +       // <-- key change (remove ",used_at.eq.")
    `&limit=1`;



    const rows = await supabaseRest(query);
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired code' });
    }

    // Mark the code as used (best-effort; ignore if your schema differs)
    try {
      await supabaseRest(
        `/login_codes?code=eq.${encodeURIComponent(rows[0].code)}&email=ilike.${encodeURIComponent(email)}`,
        { method: 'PATCH', body: { used_at: new Date().toISOString() } }
      );
    } catch {}

    // Issue session (role from users table)
    const role = users[0].role || 'member';
    const token = signJwt({ sub: users[0].email, role }, APP_JWT_SECRET);
    setCookie(res, 'pp_session', token, { sameSite: 'Lax' });

    return res.json({ ok: true, user: { email: users[0].email, role } });
  } catch (e) {
    console.error('[auth/manual/verify] error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server error' });
  }
});




// ──────────────────────────────────────────────────────────
// Site + settings
// ──────────────────────────────────────────────────────────
api.get('/project-settings', async (_, res) => {
  try {
    const rows = await supabaseRest(
      `/project_settings?select=setting_name,setting_content`
    );
    const settings = {};
    for (const r of rows) settings[r.setting_name] = r.setting_content;
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

api.get('/site-content', async (req, res) => {
  try {
    const page = (req.query.page || '').toLowerCase();
    const lang = (req.query.lang || 'en').toLowerCase().startsWith('nl') ? 'nl' : 'en';
    if (!page) return res.status(400).json({ ok: false, error: 'Missing ?page=' });
    const rows = await supabaseRest(
      `/site_content?select=page,page_text_en,page_text_nl&limit=1&page=eq.${encodeURIComponent(page)}`
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No page found' });
    const row = rows[0];
    const content =
      lang === 'nl'
        ? row.page_text_nl || row.page_text_en || ''
        : row.page_text_en || row.page_text_nl || '';
    res.json({ ok: true, page: row.page, lang, content });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

api.get('/documents/list', async (_, res) => {
  try {
    const rows = await supabaseRest(
      `/documents?select=doc_name,uploaded_by&order=uploaded_by.asc,doc_name.asc`
    );
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      const n = (r.doc_name || '').trim();
      if (n && !seen.has(n)) {
        seen.add(n);
        items.push({ doc_name: n, uploaded_by: r.uploaded_by || '' });
      }
    }
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, items: [] });
  }
});

// ──────────────────────────────────────────────────────────
// Chat endpoint (SSE stream)
// ──────────────────────────────────────────────────────────
api.post('/chat', async (req, res) => {
  try {
    const userMessage = (req.body?.message || '').toString().slice(0, 8000);
    if (!userMessage)
      return res.status(400).json({ ok: false, error: 'Empty message' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // RAG query → Supabase Function `query-docs`
    const ragBody = {
      query: userMessage,
      match_count: RAG_DEFAULTS.match_count,
      match_threshold: RAG_DEFAULTS.match_threshold,
      search_mode: RAG_DEFAULTS.search_mode
    };
    const ragResp = await fetch(`${SUPABASE_FUNCTIONS_URL}/query-docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_API_KEY,
        Authorization: `Bearer ${SUPABASE_BEARER}`
      },
      body: JSON.stringify(ragBody)
    });
    const ragJson = await ragResp.json();
    const matches = ragJson?.matches || [];

    const snippets = [];
    const sources = [];
    let used = 0;
    const maxChars = 6000;
    for (const [i, m] of matches.entries()) {
      const title = m.doc_name || m.bron || `Bron #${i + 1}`;
      const snippet = (m.invloed_text || m.content || '').toString().trim();
      const block = `[#${i + 1}] ${title}\n${snippet}\n---\n`;
      if (used + block.length <= maxChars) {
        snippets.push(block);
        used += block.length;
        sources.push({ n: i + 1, title });
      }
    }

    const contextText = snippets.join('');
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
      { role: 'system', content: `CONTEXT:\n${contextText || '(no relevant matches found)'}` }
    ];

    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.2,
        messages
      })
    });

    if (!openaiResp.ok || !openaiResp.body) {
      const txt = await openaiResp.text().catch(() => '');
      sse(res, { type: 'error', message: `OpenAI error: ${txt}` });
      sse(res, { type: 'done' });
      return res.end();
    }

    const reader = openaiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') {
          sse(res, { type: 'sources', items: sources });
          sse(res, { type: 'done' });
          return res.end();
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) sse(res, { type: 'token', text: delta });
        } catch {}
      }
    }
  } catch (e) {
    sse(res, { type: 'error', message: e.message });
    sse(res, { type: 'done' });
    res.end();
  }
});


// ──────────────────────────────────────────────────────────
// Admin aliases (match what admin_*.js calls)
// ──────────────────────────────────────────────────────────

// return settings (same shape as /project-settings)
api.get('/admin/settings', async (_req, res) => {
  try {
    const rows = await supabaseRest(`/project_settings?select=setting_name,setting_content`);
    const settings = {};
    for (const r of rows) settings[r.setting_name] = r.setting_content;
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// upsert settings (admin_settings.js does PATCH /admin/settings)
api.patch('/admin/settings', async (req, res) => {
  try {
    const payload = req.body || {};
    const keys = Object.keys(payload);
    if (!keys.length) return res.status(400).json({ ok: false, error: 'Empty payload' });

    // Upsert by setting_name; return representation
    const body = keys.map(k => ({ setting_name: k, setting_content: payload[k] }));
    const up = await supabaseRest(`/project_settings`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body
    });

    // Keep in-memory prompt fresh if changed
    const updated = {};
    for (const r of up || []) {
      updated[r.setting_name] = r.setting_content;
      if (r.setting_name === 'system_prompt') {
        SYSTEM_PROMPT = String(r.setting_content ?? '').trim();
      }
    }
    res.json({ ok: true, settings: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// optional: manual refresh button in UI (safe no-op if you don't use it)
api.post('/admin/reload-system-prompt', async (_req, res) => {
  try { await fetchSystemPromptFromDB(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// example-prompts list (alias of /example-prompts)
api.get('/admin/example-prompts', async (_req, res) => {
  try {
    const rows = await supabaseRest(
      `/example_prompts?select=id,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// If your admin UI also creates/updates/deletes prompts, include these:
api.post('/admin/example-prompts', async (req, res) => {
  try {
    const b = req.body || {};
    const ins = await supabaseRest(`/example_prompts`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{
        prompt_title_en: b.prompt_title_en || '',
        prompt_full_en : b.prompt_full_en  || '',
        prompt_title_nl: b.prompt_title_nl || '',
        prompt_full_nl : b.prompt_full_nl  || ''
      }]
    });
    res.json({ ok: true, item: ins?.[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

api.patch('/admin/example-prompts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const upd = await supabaseRest(`/example_prompts?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: req.body || {}
    });
    res.json({ ok: true, item: upd?.[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

api.delete('/admin/example-prompts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    await supabaseRest(`/example_prompts?id=eq.${id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ──────────────────────────────────────────────────────────
// Admin: DATA (upload/list/delete)
// ──────────────────────────────────────────────────────────

// GET /admin/data/list  → alias of /documents/list but under /admin
api.get('/admin/data/list', async (_req, res) => {
  try {
    const rows = await supabaseRest(
      `/documents?select=doc_name,uploaded_by,created_at&order=created_at.desc`
    );
    res.json({ ok: true, items: rows.map(r => ({
      doc_name: r.doc_name, uploaded_by: r.uploaded_by || '', created_at: r.created_at
    })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /admin/data/:doc_name  → remove all rows with this doc_name
api.delete('/admin/data/:doc_name', async (req, res) => {
  try {
    const name = String(req.params.doc_name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Missing doc_name' });
    await supabaseRest(`/documents?doc_name=eq.${encodeURIComponent(name)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /admin/data/upload  (multipart: file)
// Accepts .csv or .xlsx, creates rows in `documents`:
//   { doc_name, content, uploaded_by }
// NOTE: adjust column names if your schema differs.
api.post('/admin/data/upload', (req, res) => {
  try {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 25 * 1024 * 1024 } });
    let fileBuf = Buffer.alloc(0), filename = '';
    bb.on('file', (_name, file, info) => {
      filename = info.filename || 'upload';
      file.on('data', d => { fileBuf = Buffer.concat([fileBuf, d]); });
    });
    bb.on('finish', async () => {
      try {
        const ext = filename.toLowerCase().endsWith('.xlsx') ? 'xlsx'
                 : filename.toLowerCase().endsWith('.csv')  ? 'csv'  : 'csv';
        const records = [];

        if (ext === 'xlsx') {
          const wb = XLSX.read(fileBuf, { type: 'buffer' });
          const sheet = wb.SheetNames[0];
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { raw: false });
          for (const r of rows) records.push(r);
        } else {
          const text = fileBuf.toString('utf8');
          const rows = csvParse(text, { columns: true, skip_empty_lines: true });
          for (const r of rows) records.push(r);
        }

        const docName = filename;
        const payload = records.map(r => ({
          doc_name: docName,
          content: JSON.stringify(r),
          uploaded_by: 'admin'
        }));

        if (payload.length === 0) return res.json({ ok: true, inserted: 0 });

        await supabaseRest(`/documents`, {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: payload
        });

        res.json({ ok: true, inserted: payload.length, doc_name: docName });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// Admin: USERS (overview/add/delete/create code)
// ──────────────────────────────────────────────────────────

// GET /admin/users-overview → [{email, role, code, code_created}]
api.get('/admin/users-overview', async (_req, res) => {
  try {
    const users = await supabaseRest(`/users?select=email,role&order=email.asc`);
    const codes = await supabaseRest(
      `/login_codes?select=email,code,created_at&order=created_at.desc`
    );
    const latestByEmail = new Map();
    for (const c of codes) {
      const key = (c.email || '').toLowerCase();
      if (!key || latestByEmail.has(key)) continue;
      latestByEmail.set(key, { code: c.code, created_at: c.created_at });
    }
    const rows = users.map(u => {
      const k = (u.email || '').toLowerCase();
      const last = latestByEmail.get(k) || {};
      return { email: u.email, role: u.role || 'member', code: last.code || '', code_created: last.created_at || null };
    });
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /admin/users  { email, role }
// Upsert user
api.post('/admin/users', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const role  = String(req.body?.role  || 'member').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

    const up = await supabaseRest(`/users`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{ email, role }]
    });
    res.json({ ok: true, user: up?.[0] || { email, role } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /admin/users/:email
api.delete('/admin/users/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });
    await supabaseRest(`/users?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /admin/users/:email/codes  { code? }
// Create a new one-time code for a user (never-expiring by your rules)
api.post('/admin/users/:email/codes', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

    const code = (req.body?.code && String(req.body.code).trim())
      || Math.floor(100000 + Math.random() * 900000).toString();

    const ins = await supabaseRest(`/login_codes`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{ email, code, created_at: new Date().toISOString() }]
    });

    res.json({ ok: true, item: ins?.[0] || { email, code } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});




// ──────────────────────────────────────────────────────────
// Example prompts
// ──────────────────────────────────────────────────────────
api.get('/example-prompts', async (_, res) => {
  try {
    const rows = await supabaseRest(
      `/example_prompts?select=id,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// Export (no app.listen for Vercel)
// ──────────────────────────────────────────────────────────
module.exports = app;
