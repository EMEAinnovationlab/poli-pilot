// app.js — Poli Pilot (CSV/XLSX ingest + RAG streaming) — Vercel-ready (no app.listen)
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

// Node 18+ has global fetch

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
  search_mode: process.env.RAG_SEARCH_MODE || 'both'
};

console.log('🔧 REST :', SUPABASE_REST_URL);
console.log('🔧 FXN  :', SUPABASE_FUNCTIONS_URL);

// ──────────────────────────────────────────────────────────
let SYSTEM_PROMPT = `You are Poli Pilot, a concise assistant. Cite sources inline like [#n].`;

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

async function supabaseRest(path, { method = 'GET', body, headers = {} } = {}) {
  const url = `${SUPABASE_REST_URL}${path}`;
  const allHeaders = {
    'Content-Type': 'application/json',
    ...(SUPABASE_API_KEY ? { apikey: SUPABASE_API_KEY } : {}),
    ...(SUPABASE_BEARER ? { Authorization: `Bearer ${SUPABASE_BEARER}` } : {}),
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
    ...headers
  };
  const r = await fetch(url, { method, headers: allHeaders, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function fetchSystemPromptFromDB() {
  try {
    const rows = await supabaseRest(`/project_settings?select=setting_content&setting_name=eq.system_prompt&limit=1`);
    const content = Array.isArray(rows) && rows[0]?.setting_content ? String(rows[0].setting_content).trim() : '';
    if (content) SYSTEM_PROMPT = content;
  } catch (e) { console.warn('⚠️ Could not fetch system prompt:', e.message); }
}
fetchSystemPromptFromDB();
setInterval(fetchSystemPromptFromDB, 60000);

// JWT + Cookies
function base64url(input) { return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function signJwt(payload, secret, expSec = 60 * 60 * 24 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expSec, ...payload };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64').replace(/=|\+|\//g, m => ({'=':'','+':'-','/':'_'}[m]));
  return `${data}.${sig}`;
}
function verifyJwt(token, secret) {
  try {
    const [h, p, sig] = token.split('.');
    const data = `${h}.${p}`;
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64').replace(/=|\+|\//g, m => ({'=':'','+':'-','/':'_'}[m]));
    if (expected !== sig) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    if (payload.exp && Date.now()/1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((a,v)=>{
    const[k,...r]=v.trim().split('='); if(!k)return a; a[k]=decodeURIComponent(r.join('=')); return a;
  },{});
}
function setCookie(res,n,v,opt={}) {
  const isProd = process.env.NODE_ENV === 'production';
  const {httpOnly=true,secure=isProd,sameSite='Lax',path='/',maxAge=60*60*24*7}=opt;
  const parts=[`${n}=${v}`,`Path=${path}`,`Max-Age=${maxAge}`,`SameSite=${sameSite}`];
  if(httpOnly)parts.push('HttpOnly'); if(secure)parts.push('Secure');
  res.setHeader('Set-Cookie',parts.join('; '));
}
function clearCookie(res,n){res.setHeader('Set-Cookie',`${n}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);}

// ──────────────────────────────────────────────────────────
// Router (mounted both at "/" and "/api")
// ──────────────────────────────────────────────────────────
const api = express.Router();
app.use('/api', api);
app.use('/', api);

// Health check
api.get('/health', (_, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────
api.post('/auth/admin/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    const code = (req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ ok: false, error: 'Missing email or code' });
    const users = await supabaseRest(`/users?select=email,role&email=ilike.${encodeURIComponent(email)}&limit=1`);
    if (!users.length) return res.status(401).json({ ok: false, error: 'Email not enabled' });
    const rows = await supabaseRest(`/admin_login_codes?select=code,email&code=eq.${encodeURIComponent(code)}&limit=1`);
    if (!rows.length) return res.status(401).json({ ok: false, error: 'Invalid admin code' });
    const r = rows[0];
    if (r.email && r.email.toLowerCase() !== email.toLowerCase())
      return res.status(401).json({ ok: false, error: 'Code not valid for this email' });
    const token = signJwt({ sub: email, role: 'admin' }, APP_JWT_SECRET);
    setCookie(res, 'pp_session', token, { sameSite: 'Lax' });
    res.json({ ok: true, user: { email, role: 'admin' } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

api.get('/auth/me', (req, res) => {
  const t = parseCookies(req).pp_session;
  const p = t ? verifyJwt(t, APP_JWT_SECRET) : null;
  if (!p) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: { email: p.sub, role: p.role } });
});
api.post('/auth/logout', (_req,res)=>{clearCookie(res,'pp_session');res.json({ok:true});});

// ──────────────────────────────────────────────────────────
// Project settings + site content
// ──────────────────────────────────────────────────────────
api.get('/project-settings', async (_req, res) => {
  try {
    const rows = await supabaseRest(`/project_settings?select=setting_name,setting_content`);
    const settings = {}; for (const r of rows) settings[r.setting_name] = r.setting_content;
    res.json({ ok: true, settings });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

api.get('/site-content', async (req,res)=>{
  try{
    const page=(req.query.page||'').toLowerCase();
    const lang=(req.query.lang||'en').toLowerCase().startsWith('nl')?'nl':'en';
    if(!page)return res.status(400).json({ok:false,error:'Missing ?page='});
    const rows=await supabaseRest(`/site_content?select=page,page_text_en,page_text_nl&limit=1&page=eq.${encodeURIComponent(page)}`);
    if(!rows.length)return res.status(404).json({ok:false,error:'No page found'});
    const r=rows[0];
    const content=lang==='nl'?(r.page_text_nl||r.page_text_en||''):(r.page_text_en||r.page_text_nl||'');
    res.json({ok:true,page:r.page,lang,content});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ──────────────────────────────────────────────────────────
// Documents
// ──────────────────────────────────────────────────────────
api.get('/documents/list', async (_req,res)=>{
  try{
    const rows=await supabaseRest(`/documents?select=doc_name,uploaded_by&order=uploaded_by.asc,doc_name.asc`);
    const seen=new Set();const items=[];
    for(const r of rows){const n=(r.doc_name||'').trim();if(n&&!seen.has(n)){seen.add(n);items.push({doc_name:n,uploaded_by:r.uploaded_by||''});}}
    res.json({ok:true,items});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

api.get('/documents/list-raw', async (_req,res)=>{
  try{
    const rows=await supabaseRest(`/documents?select=doc_name,uploaded_by,date_uploaded,content&order=date_uploaded.desc`);
    res.json({ok:true,items:rows});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ──────────────────────────────────────────────────────────
// Admin: settings, prompts, data, users overview
// ──────────────────────────────────────────────────────────
api.get('/admin/settings', async (_req,res)=>{
  try{
    const rows=await supabaseRest(`/project_settings?select=setting_name,setting_content`);
    const settings={};for(const r of rows)settings[r.setting_name]=r.setting_content;
    res.json({ok:true,settings});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

api.patch('/admin/settings', async (req,res)=>{
  try{
    const payload=req.body||{};const keys=Object.keys(payload);
    if(!keys.length)return res.status(400).json({ok:false,error:'Empty payload'});
    const body=keys.map(k=>({setting_name:k,setting_content:payload[k]}));
    const up=await supabaseRest(`/project_settings`,{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body});
    const updated={};for(const r of up||[]){updated[r.setting_name]=r.setting_content;if(r.setting_name==='system_prompt')SYSTEM_PROMPT=String(r.setting_content??'').trim();}
    res.json({ok:true,settings:updated});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

api.get('/admin/example-prompts', async (_req,res)=>{
  try{
    const rows=await supabaseRest(`/example_prompts?select=id,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`);
    res.json({ok:true,items:rows});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// Admin Data
api.get('/admin/data/list', async (_req,res)=>{
  try{
    const rows=await supabaseRest(`/documents?select=doc_name,uploaded_by,created_at:date_uploaded&order=date_uploaded.desc`);
    res.json({ok:true,items:rows.map(r=>({doc_name:r.doc_name,uploaded_by:r.uploaded_by||'',created_at:r.created_at||null}))});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ──────────────────────────────────────────────────────────
// Admin: USERS overview (supports hyphen + underscore)
// ──────────────────────────────────────────────────────────
async function usersOverviewHandler(_req,res){
  try{
    const users=await supabaseRest(`/users?select=email,role&order=email.asc`);
    const codes=await supabaseRest(`/login_codes?select=email,code,created_at&order=created_at.desc`);
    const latest=new Map();
    for(const c of codes){const k=(c.email||'').toLowerCase();if(k&&!latest.has(k))latest.set(k,{code:c.code,created_at:c.created_at});}
    const items=users.map(u=>{
      const k=(u.email||'').toLowerCase();
      const last=latest.get(k)||{};
      return{email:u.email,role:u.role||'member',code:last.code||'',code_created:last.created_at||null};
    });
    res.json({ok:true,items});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
}
api.get('/admin/users-overview', usersOverviewHandler);
api.get('/admin/users_overview', usersOverviewHandler);

// ──────────────────────────────────────────────────────────
// Example Prompts (public)
// ──────────────────────────────────────────────────────────
api.get('/example-prompts', async (_req,res)=>{
  try{
    const rows=await supabaseRest(`/example_prompts?select=id,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`);
    res.json({ok:true,items:rows});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ──────────────────────────────────────────────────────────
// Export for Vercel (no app.listen)
// ──────────────────────────────────────────────────────────
module.exports = app;
