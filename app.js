// app.js — Poli Pilot (CSV/XLSX ingest + RAG streaming) — Vercel-ready (no app.listen)
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

const app = express();
app.use(cors());
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
// Supabase helpers + prompt loader
// ──────────────────────────────────────────────────────────
let SYSTEM_PROMPT = `You are Poli Pilot, a concise assistant. Cite sources inline like [#n].`;

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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!r.ok) {
    console.error(`[Supabase REST ${method}] ${url} -> ${r.status}`, json);
    throw new Error(`${r.status} ${JSON.stringify(json)}`);
  }
  return json;
}

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
// JWT helpers
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
  } catch {
    return null;
  }
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
    sameSite = 'Strict',
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
// Helper for OpenAI embeddings (REST call instead of SDK)
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

// Auth
api.post('/auth/manual/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const code = (req.body?.code || '').trim();
    if (!email || !code)
      return res.status(400).json({ ok: false, error: 'Missing email or code' });

    const users = await supabaseRest(
      `/users?select=email,role&email=ilike.${encodeURIComponent(email)}`
    );
    if (!Array.isArray(users) || !users.length)
      return res.status(401).json({ ok: false, error: 'Email not enabled' });

    const codes = await supabaseRest(
      `/login_codes?select=id,email&email=ilike.${encodeURIComponent(
        email
      )}&code=eq.${encodeURIComponent(code)}&used_at=is.null&limit=1`
    );
    if (!Array.isArray(codes) || !codes.length)
      return res
        .status(401)
        .json({ ok: false, error: 'Invalid or expired code' });

    const { id } = codes[0];
    await supabaseRest(`/login_codes?id=eq.${id}`, {
      method: 'PATCH',
      body: { used_at: new Date().toISOString() },
      headers: { Prefer: 'return=representation' }
    });

    const token = signJwt(
      { sub: users[0].email, role: users[0].role || 'member' },
      APP_JWT_SECRET
    );
    setCookie(res, 'pp_session', token);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Session check
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
// Site + settings endpoints
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
    const lang = (req.query.lang || 'en').toLowerCase().startsWith('nl')
      ? 'nl'
      : 'en';
    if (!page)
      return res.status(400).json({ ok: false, error: 'Missing ?page=' });
    const rows = await supabaseRest(
      `/site_content?select=page,page_text_en,page_text_nl&limit=1&page=eq.${encodeURIComponent(
        page
      )}`
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: 'No page found' });
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

    // RAG query
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
      {
        role: 'system',
        content: `CONTEXT:\n${contextText || '(no relevant matches found)'}`
      }
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
