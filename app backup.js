// app.js — Poli Pilot (CSV/XLSX ingest + RAG streaming) — Vercel-ready (no app.listen)
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

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
  const txt = await r.text();
  let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(json)}`);
  return json;
}

// Refresh system prompt every minute
async function fetchSystemPromptFromDB() {
  try {
    const rows = await supabaseRest(
      `/project_settings?select=setting_content&setting_name=eq.system_prompt&limit=1`
    );
    const c = rows?.[0]?.setting_content;
    if (c) SYSTEM_PROMPT = String(c).trim();
  } catch (e) { console.warn('⚠️ Could not fetch system prompt:', e.message); }
}
fetchSystemPromptFromDB();
setInterval(fetchSystemPromptFromDB, 60000);

// ──────────────────────────────────────────────────────────
// JWT + Cookies helpers
// ──────────────────────────────────────────────────────────
function base64url(i){return Buffer.from(i).toString('base64').replace(/=|\/|\+/g,m=>({'=':'','/':'_','+':'-'}[m]));}
function signJwt(payload, secret, expSec=60*60*24*7){
  const now=Math.floor(Date.now()/1000);
  const body={iat:now,exp:now+expSec,...payload};
  const head=base64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const pay=base64url(JSON.stringify(body));
  const sig=crypto.createHmac('sha256',secret).update(`${head}.${pay}`).digest('base64')
      .replace(/=|\+|\//g,m=>({'=':'','+':'-','/':'_'}[m]));
  return `${head}.${pay}.${sig}`;
}
function verifyJwt(t,s){
  try{
    const[a,b,c]=t.split('.');const check=crypto.createHmac('sha256',s).update(`${a}.${b}`).digest('base64').replace(/=|\+|\//g,m=>({'=':'','+':'-','/':'_'}[m]));
    if(check!==c)return null;const p=JSON.parse(Buffer.from(b,'base64').toString('utf8'));
    if(p.exp && Date.now()/1000>p.exp)return null;return p;
  }catch{return null;}
}
function parseCookies(req){return (req.headers.cookie||'').split(';').reduce((a,v)=>{const[k,...r]=v.trim().split('=');if(!k)return a;a[k]=decodeURIComponent(r.join('='));return a;},{});}
function setCookie(res,n,v,opt={}){
  const isProd=process.env.NODE_ENV==='production';
  const {httpOnly=true,secure=isProd,sameSite='Lax',path='/',maxAge=60*60*24*7}=opt;
  const parts=[`${n}=${v}`,`Path=${path}`,`Max-Age=${maxAge}`,`SameSite=${sameSite}`];
  if(httpOnly)parts.push('HttpOnly');if(secure)parts.push('Secure');
  res.setHeader('Set-Cookie',parts.join('; '));
}
function clearCookie(res,n){res.setHeader('Set-Cookie',`${n}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);}

// ──────────────────────────────────────────────────────────
// Express routes
// ──────────────────────────────────────────────────────────
const api = express.Router();
app.use('/api', api);
app.use('/', api);

api.get('/health',(_,r)=>r.json({ok:true}));

// ─── Admin login ──────────────────────────────────────────
api.post('/auth/admin/verify', async (req,res)=>{
  try{
    const email=(req.body?.email||'').trim();
    const code=(req.body?.code||'').trim();
    if(!email||!code) return res.status(400).json({ok:false,error:'Missing email or code'});
    const users=await supabaseRest(`/users?select=email,role&email=ilike.${encodeURIComponent(email)}&limit=1`);
    if(!Array.isArray(users)||!users.length) return res.status(401).json({ok:false,error:'Email not enabled'});
    const rows=await supabaseRest(`/admin_login_codes?select=code,enabled,email&code=eq.${encodeURIComponent(code)}&limit=1`);
    if(!rows.length) return res.status(401).json({ok:false,error:'Invalid admin code'});
    const r=rows[0];
    if(r.enabled===false) return res.status(401).json({ok:false,error:'Admin code disabled'});
    if(r.email && r.email.toLowerCase()!==email.toLowerCase()) return res.status(401).json({ok:false,error:'Code not valid for this email'});
    const token=signJwt({sub:users[0].email,role:'admin'},APP_JWT_SECRET);
    setCookie(res,'pp_session',token,{sameSite:'Lax'});
    res.json({ok:true,user:{email:users[0].email,role:'admin'}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

api.get('/auth/me',(req,res)=>{
  const t=parseCookies(req).pp_session;
  const p=t?verifyJwt(t,APP_JWT_SECRET):null;
  if(!p) return res.status(401).json({ok:false});
  res.json({ok:true,user:{email:p.sub,role:p.role}});
});
api.post('/auth/logout',(req,res)=>{clearCookie(res,'pp_session');res.json({ok:true});});

// ─── Manual login (no expiry) ─────────────────────────────
api.post('/auth/manual/verify', async (req,res)=>{
  try{
    const email=(req.body?.email||'').trim();
    const raw=(req.body?.code||'').trim();
    if(!email||!raw) return res.status(400).json({ok:false,error:'Missing email or code'});
    const users=await supabaseRest(`/users?select=email,role&email=ilike.${encodeURIComponent(email)}&limit=1`);
    if(!Array.isArray(users)||!users.length) return res.status(401).json({ok:false,error:'Email not enabled'});
    const candidates=[raw]; if(/^\d+$/.test(raw)) candidates.push(String(Number(raw)));
    const ors=candidates.map(v=>`code.eq.${encodeURIComponent(v)}`).join(',');
    const q=`/login_codes?select=code,email,used_at&or=(${ors})&email=ilike.${encodeURIComponent(email)}&used_at=is.null&limit=1`;
    const rows=await supabaseRest(q);
    if(!rows.length) return res.status(401).json({ok:false,error:'Invalid code'});
    try{
      await supabaseRest(`/login_codes?code=eq.${encodeURIComponent(rows[0].code)}&email=ilike.${encodeURIComponent(email)}`,
        {method:'PATCH',body:{used_at:new Date().toISOString()}});
    }catch{}
    const role=users[0].role||'member';
    const token=signJwt({sub:users[0].email,role},APP_JWT_SECRET);
    setCookie(res,'pp_session',token,{sameSite:'Lax'});
    res.json({ok:true,user:{email:users[0].email,role}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ─── Project settings / content / docs ────────────────────
api.get('/project-settings', async (_,res)=>{
  try{
    const rows=await supabaseRest(`/project_settings?select=setting_name,setting_content`);
    const s={}; for(const r of rows)s[r.setting_name]=r.setting_content;
    res.json({ok:true,settings:s});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

api.get('/site-content', async (req,res)=>{
  try{
    const page=(req.query.page||'').toLowerCase();
    const lang=(req.query.lang||'en').toLowerCase().startsWith('nl')?'nl':'en';
    if(!page) return res.status(400).json({ok:false,error:'Missing ?page='});
    const rows=await supabaseRest(`/site_content?select=page,page_text_en,page_text_nl&limit=1&page=eq.${encodeURIComponent(page)}`);
    if(!rows.length) return res.status(404).json({ok:false,error:'No page found'});
    const r=rows[0]; const content=lang==='nl'?(r.page_text_nl||r.page_text_en||''):(r.page_text_en||r.page_text_nl||'');
    res.json({ok:true,page:r.page,lang,content});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

api.get('/documents/list', async (_,res)=>{
  try{
    const rows=await supabaseRest(`/documents?select=doc_name,uploaded_by&order=uploaded_by.asc,doc_name.asc`);
    const seen=new Set(),items=[];
    for(const r of rows){const n=(r.doc_name||'').trim(); if(n&&!seen.has(n)){seen.add(n);items.push({doc_name:n,uploaded_by:r.uploaded_by||''});}}
    res.json({ok:true,items});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ─── Example prompts ──────────────────────────────────────
api.get('/example-prompts', async (_,res)=>{
  try{
    const rows=await supabaseRest(`/example_prompts?select=id,prompt_title_nl,prompt_title_en,prompt_full_nl,prompt_full_en&order=id.asc`);
    res.json({ok:true,items:rows});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ─── Chat endpoint (SSE stream) ───────────────────────────
function sse(res,obj){res.write(`data: ${JSON.stringify(obj)}\n\n`);}
api.post('/chat', async (req,res)=>{
  try{
    const msg=(req.body?.message||'').toString().slice(0,8000);
    if(!msg) return res.status(400).json({ok:false,error:'Empty message'});
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');

    const ragBody={query:msg,match_count:RAG_DEFAULTS.match_count,match_threshold:RAG_DEFAULTS.match_threshold,search_mode:RAG_DEFAULTS.search_mode};
    const ragResp=await fetch(`${SUPABASE_FUNCTIONS_URL}/query-docs`,{
      method:'POST',headers:{'Content-Type':'application/json',apikey:SUPABASE_API_KEY,Authorization:`Bearer ${SUPABASE_BEARER}`},
      body:JSON.stringify(ragBody)
    });
    const ragJson=await ragResp.json();
    const matches=ragJson?.matches||[];
    const snippets=[],sources=[],maxChars=6000;let used=0;
    for(const[i,m]of matches.entries()){
      const title=m.doc_name||m.bron||`Bron #${i+1}`;
      const snip=(m.invloed_text||m.content||'').trim();
      const block=`[#${i+1}] ${title}\n${snip}\n---\n`;
      if(used+block.length<=maxChars){snippets.push(block);used+=block.length;sources.push({n:i+1,title});}
    }
    const context=snippets.join('');
    const messages=[
      {role:'system',content:SYSTEM_PROMPT},
      {role:'user',content:msg},
      {role:'system',content:`CONTEXT:\n${context||'(no relevant matches found)'}`}
    ];
    const openaiResp=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:OPENAI_MODEL,stream:true,temperature:0.2,messages})
    });
    if(!openaiResp.ok||!openaiResp.body){
      const txt=await openaiResp.text().catch(()=>'' );
      sse(res,{type:'error',message:`OpenAI error: ${txt}`}); sse(res,{type:'done'}); return res.end();
    }
    const reader=openaiResp.body.getReader();const decoder=new TextDecoder();let buffer='';
    while(true){
      const {done,value}=await reader.read(); if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split('\n'); buffer=lines.pop()||'';
      for(const line of lines){
        const t=line.trim(); if(!t.startsWith('data:'))continue;
        const p=t.slice(5).trim(); if(p==='[DONE]'){sse(res,{type:'sources',items:sources}); sse(res,{type:'done'}); return res.end();}
        try{const j=JSON.parse(p);const d=j.choices?.[0]?.delta?.content; if(d)sse(res,{type:'token',text:d});}catch{}
      }
    }
  }catch(e){sse(res,{type:'error',message:e.message}); sse(res,{type:'done'}); res.end();}
});

// ──────────────────────────────────────────────────────────
module.exports = app;
