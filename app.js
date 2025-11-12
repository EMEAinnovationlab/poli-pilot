// app.js — Poli Pilot (CSV/XLSX ingest + RAG streaming) — Vercel-ready (no app.listen)
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

// ── Deps for spreadsheet ingest + embeddings ──────────────
const Busboy = require('busboy');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');
// ❌ Removed: const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Load env ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000; // used only for local runner
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const DRY_RUN_EMBEDDINGS = String(process.env.DRY_RUN_EMBEDDINGS || '') === '1';

const SUPABASE_FUNCTIONS_URL = (process.env.SUPABASE_FUNCTIONS_URL || '').replace(/\/$/, '');
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY || ''; // anon key → sent as "apikey"
const SUPABASE_BEARER = process.env.SUPABASE_BEARER || '';   // service_role key → "Authorization: Bearer ..."
let   SUPABASE_REST_URL = process.env.SUPABASE_REST_URL || '';
if (!SUPABASE_REST_URL && SUPABASE_FUNCTIONS_URL) {
  try {
    const u = new URL(SUPABASE_FUNCTIONS_URL);
    u.hostname = u.hostname.replace('.functions.', '.supabase.');
    u.pathname = '/rest/v1';
    u.search = '';
    SUPABASE_REST_URL = u.toString().replace(/\/$/, '');
  } catch {}
}

const APP_JWT_SECRET = process.env.APP_JWT_SECRET || 'dev_secret_change_me';

const RAG_DEFAULTS = {
  match_count: Number(process.env.RAG_MATCH_COUNT || 6),
  match_threshold: Number(process.env.RAG_MATCH_THRESHOLD || 0),
  search_mode: process.env.RAG_SEARCH_MODE || 'both',
  uploaded_by: process.env.RAG_UPLOADED_BY || null,
};

console.log('🔧 REST :', SUPABASE_REST_URL);
console.log('🔧 FXN  :', SUPABASE_FUNCTIONS_URL);

// ─── Load system prompt from Supabase (no file fallback) ─────────────────────
let SYSTEM_PROMPT = `You are Poli Pilot, a concise assistant. Cite sources inline like [#n].`;

// Supabase REST helper (adds profile headers + logging)
async function supabaseRest(path, { method='GET', body, headers={} } = {}) {
  if (!SUPABASE_REST_URL) throw new Error('Missing SUPABASE_REST_URL');

  const url = `${SUPABASE_REST_URL}${path}`;
  const allHeaders = {
    'Content-Type': 'application/json',
    ...(SUPABASE_API_KEY ? { apikey: SUPABASE_API_KEY } : {}),
    ...(SUPABASE_BEARER ? { Authorization: `Bearer ${SUPABASE_BEARER}` } : {}),
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
    ...headers,
  };

  const r = await fetch(url, {
    method,
    headers: allHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }

  if (!r.ok) {
    console.error(`[Supabase REST ${method}] ${url} -> ${r.status}`, json);
    throw new Error(`${r.status} ${JSON.stringify(json)}`);
  }
  if (method !== 'GET') {
    console.log(`[Supabase REST ${method}] ${url} -> ${r.status} OK`);
  }
  return Object.assign(json ?? {}, { _headers: Object.fromEntries(r.headers.entries()) });
}

// Pull system prompt from DB: public.project_settings(setting_name='system_prompt')
async function fetchSystemPromptFromDB() {
  try {
    const rows = await supabaseRest(
      `/project_settings?select=setting_content&setting_name=eq.system_prompt&limit=1`
    );
    const content = Array.isArray(rows) && rows[0]?.setting_content
      ? String(rows[0].setting_content).trim()
      : '';
    if (content) {
      SYSTEM_PROMPT = content;
      console.log(`🧠 Loaded system prompt from DB (${SYSTEM_PROMPT.length} chars)`);
      return true;
    } else {
      console.warn('⚠️ DB system prompt empty; keeping current in-memory default.');
      return false;
    }
  } catch (e) {
    console.warn('⚠️ Could not fetch system prompt from DB:', e.message || e);
    return false;
  }
}

async function initSystemPrompt() {
  await fetchSystemPromptFromDB();
  const intervalMs = Number(process.env.SETTINGS_REFRESH_MS || 60000);
  setInterval(fetchSystemPromptFromDB, intervalMs);
}
initSystemPrompt();

// ─── Helpers ───────────────────────────────────────────────
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function signJwt(payload, secret, expiresSec = 60 * 60 * 24 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now()/1000);
  const body = { iat: now, exp: now + expiresSec, ...payload };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${data}.${sig}`;
}
function verifyJwt(token, secret) {
  try {
    const [h,p,sig] = token.split('.');
    const data = `${h}.${p}`;
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64')
      .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if (expected !== sig) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    if (payload.exp && Math.floor(Date.now()/1000) > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function setCookie(res, name, value, opts = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const {
    httpOnly = true,
    secure = isProd,
    sameSite = 'Strict',
    path = '/',
    maxAge = 60*60*24*7 // 7d
  } = opts;

  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
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

// ── OpenAI REST helper for embeddings (avoids ESM SDK) ─────
async function createEmbeddingsBatch({ model, inputs, apiKey }) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input: inputs })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`OpenAI embeddings failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  return (json?.data || []).map(d => d.embedding || null);
}

// ─── Health ───────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ─── Auth: Manual-code (single use) ───────────────────────
app.post('/auth/manual/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const code  = (req.body?.code  || '').trim();
    if (!email || !code) return res.status(400).json({ ok: false, error: 'Missing email or code' });

    const users = await supabaseRest(`/users?select=email,role&email=ilike.${encodeURIComponent(email)}`);
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email not enabled' });
    }

    const codes = await supabaseRest(
      `/login_codes?select=id,email&email=ilike.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used_at=is.null&limit=1`
    );
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired code' });
    }

    const { id } = codes[0];
    await supabaseRest(`/login_codes?id=eq.${id}`, {
      method: 'PATCH',
      body: { used_at: new Date().toISOString() },
      headers: { Prefer: 'return=representation' },
    });

    const token = signJwt({ sub: users[0].email, role: users[0].role || 'member' }, APP_JWT_SECRET, 60*60*24*7);
    setCookie(res, 'pp_session', token, { maxAge: 60*60*24*7 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ─── Auth: Admin-code (permanent) ─────────────────────────
app.post('/auth/admin/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const code  = (req.body?.code  || '').trim();
    if (!email || !code) return res.status(400).json({ ok: false, error: 'Missing email or code' });

    const users = await supabaseRest(`/users?select=email,role&email=ilike.${encodeURIComponent(email)}`);
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email not enabled' });
    }

    const codes = await supabaseRest(
      `/admin_login_codes?select=id,email,used_at&email=ilike.${encodeURIComponent(email)}&code=ilike.${encodeURIComponent(code)}&limit=1`
    );
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid admin code' });
    }

    const row = codes[0];
    await supabaseRest(`/admin_login_codes?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      body: { used_at: 'infinity' },
      headers: { Prefer: 'return=representation' },
    });

    const token = signJwt({ sub: users[0].email, role: 'admin' }, APP_JWT_SECRET, 60*60*24*7);
    setCookie(res, 'pp_session', token, { maxAge: 60*60*24*7 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ─── Session helpers / guard ───────────────────────────────
app.get('/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.pp_session;
  const payload = token ? verifyJwt(token, APP_JWT_SECRET) : null;
  if (!payload) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: { email: payload.sub, role: payload.role } });
});
app.post('/auth/logout', (req, res) => { clearCookie(res, 'pp_session'); res.json({ ok: true }); });

function requireAdmin(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.pp_session;
    const payload = token ? verifyJwt(token, APP_JWT_SECRET) : null;
    if (!payload || payload.role !== 'admin') {
      return res.status(401).json({ ok: false, error: 'Admin only' });
    }
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Admin only' });
  }
}

// ─── Chat endpoint (streaming) ─────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const userMessage = (req.body?.message || '').toString().slice(0, 8000);
    if (!userMessage) return res.status(400).json({ error: 'No message' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const ragBody = {
      query: userMessage,
      match_count: Number(req.body?.match_count ?? RAG_DEFAULTS.match_count),
      match_threshold: Number(req.body?.match_threshold ?? RAG_DEFAULTS.match_threshold),
      search_mode: req.body?.search_mode ?? RAG_DEFAULTS.search_mode,
      ...(RAG_DEFAULTS.uploaded_by ? { uploaded_by: RAG_DEFAULTS.uploaded_by } : {}),
    };

    const ragResp = await fetch(`${SUPABASE_FUNCTIONS_URL}/query-docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SUPABASE_API_KEY ? { 'apikey': SUPABASE_API_KEY } : {}),
        ...(SUPABASE_BEARER ? { 'Authorization': `Bearer ${SUPABASE_BEARER}` } : {}),
      },
      body: JSON.stringify(ragBody),
    });

    if (!ragResp.ok) {
      const txt = await ragResp.text().catch(() => '');
      sse(res, { type: 'error', message: `RAG query failed: ${ragResp.status} ${txt}` });
      sse(res, { type: 'done' });
      return res.end();
    }

    const ragData = await ragResp.json();
    const matches = Array.isArray(ragData?.matches) ? ragData.matches : [];

    const maxChars = 6000;
    let used = 0;
    const snippets = [];
    const sources = [];

    matches.forEach((m, i) => {
      const title = m.doc_name || m.bron || `Bron #${i + 1}`;
      const url = m.link || null;
      const snippet = (m.invloed_text || m.content || '').toString().trim().replace(/\s+/g, ' ');
      const block = `[#${i + 1}] ${title}${url ? ` (${url})` : ''}\n${snippet}\n---\n`;
      if (used + block.length <= maxChars) {
        snippets.push(block);
        used += block.length;
        sources.push({ n: i + 1, title, url });
      }
    });

    const contextText = snippets.join('');
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
      { role: 'system', content: `CONTEXT:\n${contextText || '(no relevant matches found)'}` },
    ];

    const body = { model: OPENAI_MODEL, stream: true, temperature: 0.2, messages };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      sse(res, { type: 'error', message: `OpenAI error: ${r.status} ${text}` });
      sse(res, { type: 'done' });
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();

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

    sse(res, { type: 'sources', items: sources });
    sse(res, { type: 'done' });
    res.end();
  } catch (err) {
    sse(res, { type: 'error', message: err.message || String(err) });
    sse(res, { type: 'done' });
    res.end();
  }
});

// ─── Site content (public pages) ───────────────────────────
app.get('/site-content', async (req, res) => {
  try {
    const page = (req.query.page || '').toLowerCase();
    const lang = (req.query.lang || 'en').toLowerCase().startsWith('nl') ? 'nl' : 'en';
    if (!page) return res.status(400).json({ ok: false, error: 'Missing ?page=' });

    const rows = await supabaseRest(
      `/site_content?select=page,page_text_en,page_text_nl&limit=1&page=eq.${encodeURIComponent(page)}`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ ok: false, error: `No content for page "${page}"` });
    }

    const row = rows[0];
    const content = lang === 'nl' ? (row.page_text_nl || row.page_text_en || '') : (row.page_text_en || row.page_text_nl || '');
    res.json({ ok: true, page: row.page, lang, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ─── Project settings public read ──────────────────────────
app.get('/project-settings', async (req, res) => {
  try {
    const rows = await supabaseRest(`/project_settings?select=setting_name,setting_content`);
    if (!Array.isArray(rows)) return res.status(500).json({ ok: false, error: 'No project_settings found' });
    const settings = {};
    for (const row of rows) settings[row.setting_name] = row.setting_content;
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ─── Documents: unique list for "Included data" ───────────
app.get('/documents/list', async (req, res) => {
  try {
    const rows = await supabaseRest(
      `/documents?select=doc_name,uploaded_by&order=uploaded_by.asc,doc_name.asc`
    );
    if (!Array.isArray(rows)) return res.json({ ok: true, items: [] });

    const seen = new Set();
    const unique = [];
    for (const row of rows) {
      const name = (row.doc_name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      unique.push({ doc_name: name, uploaded_by: row.uploaded_by || '' });
    }

    res.json({ ok: true, items: unique });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err), items: [] });
  }
});

// ─── Documents: raw rows for admin (kept to avoid 404) ─────
app.get('/documents/list-raw', requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseRest(
      `/documents?select=document_id,doc_name,uploaded_by,date_uploaded,chunk_index,naam,content,invloed_text,bron,link&order=doc_name.asc,uploaded_by.asc,chunk_index.asc`
    );
    if (!Array.isArray(rows)) return res.json({ ok: true, items: [] });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err), items: [] });
  }
});

// ─── Documents: delete by doc_name (single & bulk) ─────────
app.delete('/documents', requireAdmin, async (req, res) => {
  try {
    const docNames = Array.isArray(req.body?.doc_names) ? req.body.doc_names : [];
    if (!docNames.length) return res.json({ ok: true, deleted: 0 });

    let totalDeleted = 0;
    for (const raw of docNames) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const out = await supabaseRest(
        `/documents?doc_name=eq.${encodeURIComponent(name)}`,
        { method: 'DELETE', headers: { Prefer: 'return=representation' } }
      );
      if (Array.isArray(out)) totalDeleted += out.length;
    }
    res.json({ ok: true, deleted: totalDeleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Single: path param
app.delete('/documents/:doc_name', requireAdmin, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.doc_name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Missing doc_name' });

    const out = await supabaseRest(
      `/documents?doc_name=eq.${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: { Prefer: 'return=representation' } }
    );
    const deleted = Array.isArray(out) ? out.length : 0;
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ─── Example prompts CRUD (public read, admin write) ───────
app.get('/api/example-prompts', async (req, res) => {
  try {
    const rows = await supabaseRest(
      `/example_prompts?select=id,created_at,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`,
      { headers: { 'Accept-Profile': 'public' } }
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/admin/example-prompts', requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseRest(
      `/example_prompts?select=id,created_at,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`,
      { headers: { 'Accept-Profile': 'public' } }
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/admin/example-prompts', requireAdmin, async (req, res) => {
  try {
    const body = {
      prompt_title_nl: req.body?.prompt_title_nl ?? null,
      prompt_title_en: req.body?.prompt_title_en ?? null,
      prompt_full_nl : req.body?.prompt_full_nl  ?? null,
      prompt_full_en : req.body?.prompt_full_en  ?? null,
    };
    const out = await supabaseRest(`/example_prompts`, {
      method: 'POST',
      headers: { 'Prefer': 'return=representation', 'Accept-Profile': 'public' },
      body
    });
    res.json({ ok: true, item: Array.isArray(out) ? out[0] : out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.patch('/admin/example-prompts/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const body = {};
    ['prompt_title_nl','prompt_title_en','prompt_full_nl','prompt_full_en'].forEach(k => {
      if (k in req.body) body[k] = req.body[k];
    });
    const out = await supabaseRest(`/example_prompts?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation', 'Accept-Profile': 'public' },
      body
    });
    res.json({ ok: true, item: Array.isArray(out) ? out[0] : out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.delete('/admin/example-prompts/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await supabaseRest(`/example_prompts?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Accept-Profile': 'public' }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ─── Admin: Project settings read/write ────────────────────
app.get('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseRest(`/project_settings?select=setting_name,setting_content`);
    const settings = {};
    if (Array.isArray(rows)) {
      for (const r of rows) settings[r.setting_name] = r.setting_content ?? '';
    }
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.patch('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const results = {};
    for (const [name, content] of Object.entries(updates)) {
      let didUpdate = false;
      try {
        const patched = await supabaseRest(
          `/project_settings?setting_name=eq.${encodeURIComponent(name)}`,
          { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { setting_content: String(content ?? '') } }
        );
        if (Array.isArray(patched) && patched.length) { results[name] = 'updated'; didUpdate = true; }
      } catch (_) {}
      if (!didUpdate) {
        await supabaseRest(`/project_settings`, {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: { setting_name: name, setting_content: String(content ?? '') }
        });
        results[name] = 'inserted';
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.post('/admin/reload-system-prompt', requireAdmin, async (req, res) => {
  try {
    const ok = await fetchSystemPromptFromDB();
    return res.status(ok ? 200 : 500).json({ ok, size: SYSTEM_PROMPT.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ───────────────────────────────────────────────────────────
// Spreadsheet ingest helpers
// ───────────────────────────────────────────────────────────
function readMultipart(req){
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    let fileInfo = null;

    busboy.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => { fileInfo = { filename, mimeType, buffer: Buffer.concat(chunks) }; });
    });

    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, file: fileInfo }));

    req.pipe(busboy);
  });
}

function detectDelimiter(sample) {
  const firstLine = String(sample).split(/\r?\n/)[0] || '';
  const sc = (firstLine.match(/;/g) || []).length;
  const cc = (firstLine.match(/,/g) || []).length;
  return sc > cc ? ';' : ',';
}
function readCsv(buffer) {
  const text = buffer.toString('utf8');
  const delimiter = detectDelimiter(text);
  const records = csvParse(text, {
    columns: true,
    skip_empty_lines: true,
    delimiter,
    bom: true,
    trim: true
  });
  return records;
}
function readXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}
function readSpreadsheetFile(filename, buffer) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'csv') return readCsv(buffer);
  if (ext === 'xlsx') return readXlsx(buffer);
  throw new Error(`Unsupported file type: .${ext} (use .csv or .xlsx)`);
}

function normalizeRowFromSheet(row) {
  const get = (k) => row[k] ?? row[k?.toLowerCase?.()] ?? row[k?.toUpperCase?.()];
  const datum = (get('datum') || '').toString();
  const naam = (get('naam') || '').toString();
  const bron = (get('bron') || '').toString();
  const link = (get('link') || '').toString();
  const invloed_text = (get('invloed_text') || '').toString();
  const content = (get('content') || '').toString();
  const chunk_index_raw = get('chunk_index');
  const n = Number(chunk_index_raw);
  const chunk_index = Number.isFinite(n) ? n : null;
  return { datum, naam, bron, link, invloed_text, content, chunk_index };
}

function finalizeChunkIndexes(rows, docName) {
  let next = 0;
  for (const r of rows) {
    if (r.doc_name !== docName) continue;
    if (r.chunk_index == null || Number.isNaN(r.chunk_index)) {
      r.chunk_index = next++;
    } else {
      next = Math.max(next, r.chunk_index + 1);
    }
  }
  return rows;
}

async function getExistingDocumentIdForDocName(doc_name) {
  const rows = await supabaseRest(
    `/documents?select=document_id&doc_name=eq.${encodeURIComponent(doc_name)}&limit=1`
  );
  if (Array.isArray(rows) && rows.length && rows[0].document_id) return rows[0].document_id;
  return null;
}
async function upsertDocumentRows(rows) {
  return await supabaseRest(
    `/documents?on_conflict=doc_name,chunk_index`,
    {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: rows,
    }
  );
}
function rowsToCsv(rows){
  const headers = [
    'document_id','doc_name','uploaded_by','chunk_index','datum',
    'naam','bron','link','invloed_text','content'
  ];
  const esc = (s) => {
    const t = String(s ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g,'""')}"` : t;
  };
  const body = rows.map(r => headers.map(h => esc(r[h])).join(',')).join('\n');
  return headers.join(',') + '\n' + body;
}

// ─── Admin: Ingest spreadsheet (CSV/XLSX) ──────────────────
app.post('/admin/ingest', requireAdmin, async (req, res) => {
  try {
    const { fields, file } = await readMultipart(req);
    const action = String(fields.action || '').toLowerCase();     // 'preview' | 'upload'
    const input_doc_name = (fields.doc_name || '').trim();        // REQUIRED
    const input_uploaded_by = (fields.uploaded_by || '').trim();  // REQUIRED

    if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: 'Missing file' });
    if (!input_doc_name) return res.status(400).json({ ok: false, error: 'Missing form field: doc_name' });
    if (!input_uploaded_by) return res.status(400).json({ ok: false, error: 'Missing form field: uploaded_by' });

    // 1) Read rows from CSV/XLSX
    const rawRows = readSpreadsheetFile(file.filename || 'upload', file.buffer);
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return res.status(400).json({ ok: false, error: 'No rows found in spreadsheet' });
    }

    // 2) Normalize rows (NO doc_name / uploaded_by from sheet)
    let normalized = rawRows.map(r => {
      const core = normalizeRowFromSheet(r);
      return { ...core, doc_name: input_doc_name, uploaded_by: input_uploaded_by };
    });

    // 3) Resolve document_id once (single doc per upload)
    const reuseId = await getExistingDocumentIdForDocName(input_doc_name);
    const document_id = reuseId || (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));

    // 4) Assign chunk_index where absent and build preview rows
    normalized = finalizeChunkIndexes(normalized, input_doc_name);

    const previewRows = normalized.map((r) => ({
      document_id,
      doc_name: input_doc_name,
      uploaded_by: r.uploaded_by,
      chunk_index: r.chunk_index,
      datum: r.datum,
      naam: r.naam,
      bron: r.bron,
      link: r.link,
      invloed_text: r.invloed_text,
      content: r.content
    }));

    if (action === 'preview') {
      const csv = rowsToCsv(previewRows);
      return res.json({ ok: true, document_id, rows: previewRows, csv });
    }

    if (action === 'upload') {
      if (!OPENAI_API_KEY && !DRY_RUN_EMBEDDINGS) {
        console.error('UPLOAD ABORT: Missing OPENAI_API_KEY');
        return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY missing' });
      }

      // 5) Create embeddings (or skip if DRY_RUN_EMBEDDINGS=1)
      let contentEmbVectors = null, invloedEmbVectors = null;
      try {
        if (!DRY_RUN_EMBEDDINGS) {
          const contentInputs = previewRows.map(r => r.content || '');
          const invloedInputs = previewRows.map(r => r.invloed_text || '');
          console.log(`Creating embeddings: content=${contentInputs.length}, invloed=${invloedInputs.length}, model=${EMBED_MODEL}`);
          contentEmbVectors = await createEmbeddingsBatch({ model: EMBED_MODEL, inputs: contentInputs, apiKey: OPENAI_API_KEY });
          invloedEmbVectors = await createEmbeddingsBatch({ model: EMBED_MODEL, inputs: invloedInputs, apiKey: OPENAI_API_KEY });
          console.log('Embeddings created OK');
        } else {
          console.warn('DRY_RUN_EMBEDDINGS=1 → skipping OpenAI calls, writing null vectors.');
        }
      } catch (e) {
        console.error('OpenAI embeddings error:', e?.message || e);
        return res.status(500).json({ ok: false, error: `OpenAI embeddings failed: ${e?.message || e}` });
      }

      // Your schema: date_uploaded is DATE (YYYY-MM-DD)
      const today = new Date().toISOString().slice(0,10);

      const upsertRows = previewRows.map((r, i) => ({
        ...r,
        embedding: DRY_RUN_EMBEDDINGS ? null : (contentEmbVectors?.[i] || null),
        invloed_embedding: DRY_RUN_EMBEDDINGS
          ? null
          : ((r.invloed_text || '').trim() ? (invloedEmbVectors?.[i] || null) : null),
        metadata: { source: 'admin_ingest_spreadsheet' },
        date_uploaded: today
      }));

      try {
        const out = await upsertDocumentRows(upsertRows);
        console.log(`Upsert OK: returned ${Array.isArray(out) ? out.length : 0} rows`);
        return res.json({ ok: true, document_id, count: upsertRows.length });
      } catch (e) {
        console.error('Supabase upsert error:', e?.message || e);
        return res.status(500).json({ ok: false, error: `Supabase upsert failed: ${e?.message || e}` });
      }
    }

    return res.status(400).json({ ok: false, error: 'Invalid action (use preview|upload)' });
  } catch (e) {
    console.error('Ingest spreadsheet error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ─── Admin: Users & Login Codes overview ──────────────────
app.get('/api/admin/users_overview', requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseRest(`/user_login_overview?select=*&order=email.asc`);
    const data = Array.isArray(rows) ? rows : [];
    res.json({ ok: true, count: data.length, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ─── Admin: Create/Update user, Delete user ────────────────
app.post('/admin/users', requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role  = String(req.body?.role  || '').trim().toLowerCase();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Valid email required' });
    }
    if (!['member','admin'].includes(role)) {
      return res.status(400).json({ ok: false, error: "Role must be 'member' or 'admin'" });
    }

    const existing = await supabaseRest(`/users?select=email,role&email=eq.${encodeURIComponent(email)}&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      const out = await supabaseRest(`/users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: { role }
      });
      return res.json({ ok: true, mode: 'updated', user: Array.isArray(out) ? out[0] : out });
    } else {
      const out = await supabaseRest(`/users`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: { email, role }
      });
      return res.json({ ok: true, mode: 'inserted', user: Array.isArray(out) ? out[0] : out });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.delete('/admin/users/:email', requireAdmin, async (req, res) => {
  try {
    const email = String(decodeURIComponent(req.params.email || '')).trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

    await supabaseRest(`/login_codes?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' }
    }).catch(() => {});

    await supabaseRest(`/admin_login_codes?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' }
    }).catch(() => {});

    const del = await supabaseRest(`/users?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' }
    });

    const deleted = Array.isArray(del) ? del.length : 0;
    return res.json({ ok: true, deleted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ─── Diagnostics (admin-only) ──────────────────────────────
app.get('/admin/debug/env', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    SUPABASE_REST_URL,
    SUPABASE_FUNCTIONS_URL,
    has_SUPABASE_API_KEY: !!SUPABASE_API_KEY,
    has_SUPABASE_BEARER: !!SUPABASE_BEARER,
    has_OPENAI_API_KEY: !!OPENAI_API_KEY,
    EMBED_MODEL,
    DRY_RUN_EMBEDDINGS
  });
});

// ─── Export for Vercel / serverless wrapper ────────────────
// (No app.listen here; local dev should use server.local.js)
module.exports = app;
