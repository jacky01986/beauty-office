// salesmartly.js ÃÂ¢ÃÂÃÂ SaleSmartly API client + customer insight extractor
// env: SALESMARTLY_TOKEN, SALESMARTLY_PROJECT_ID, SALESMARTLY_BASE_URL (optional)
// V2 endpoints based on apifox doc category structure

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.SALESMARTLY_TOKEN || '';
const PROJECT_ID = process.env.SALESMARTLY_PROJECT_ID || '';
const BASE_URL = process.env.SALESMARTLY_BASE_URL || 'https://developer.salesmartly.com';
const CACHE_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'salesmartly_conversations.json');

function signParams(params = {}) {
  // SaleSmartly signature: Token + '&' + sorted "key=value" pairs joined with '&', then MD5 (32 lowercase hex)
  // project_id MUST be included in signing params
  const allParams = Object.assign({}, params, { project_id: PROJECT_ID });
  const keys = Object.keys(allParams).sort();
  const pairs = keys.map(k => {
    const v = allParams[k];
    if (v === null || v === undefined) return k + '=';
    if (typeof v === 'object') return k + '=' + JSON.stringify(v);
    return k + '=' + String(v);
  });
  const concat = TOKEN + '&' + pairs.join('&');
  return crypto.createHash('md5').update(concat, 'utf8').digest('hex');
}

async function apiCall(endpoint, params = {}, method = 'POST') {
  if (!TOKEN || !PROJECT_ID) throw new Error('SALESMARTLY env not set');
  const sign = signParams(params);
  const headers = { 'Token': TOKEN, 'project_id': PROJECT_ID, 'external-sign': sign, 'Content-Type': 'application/json' };
  let url = BASE_URL + endpoint, body = null;
  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  } else { body = JSON.stringify(params); }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('SS ' + endpoint + ' ' + res.status + ' ' + text.slice(0,200));
  if (json && json.code !== undefined && json.code !== 0) {
    throw new Error('SS ' + endpoint + ' code=' + json.code + ' ' + (json.msg || json.message || ''));
  }
  return json;
}

const CONV_ENDPOINTS = ['/api/v2/get-session-list'];
const MSG_ENDPOINTS = ['/api/v2/get-message-list'];

async function tryEndpoints(endpoints, params, methods = ['GET', 'POST']) {
  const attempts = [];
  for (const ep of endpoints) {
    for (const method of methods) {
      try {
        const r = await apiCall(ep, params, method);
        r._endpoint_used = ep; r._method_used = method;
        return { ok: true, result: r, attempts };
      } catch (e) {
        attempts.push({ endpoint: ep, method, error: e.message.slice(0, 200) });
      }
    }
  }
  return { ok: false, attempts };
}

async function listRecentConversations({ days = 7, page = 1, page_size = 50 } = {}) {
  // SaleSmartly /api/v2/get-session-list: project_id required as query param
  // start_time/end_time are optional JSON-format strings
  const params = { page, page_size, project_id: PROJECT_ID };
  const out = await tryEndpoints(CONV_ENDPOINTS, params);
  if (!out.ok) {
    const err = new Error('All conversation endpoints failed');
    err.attempts = out.attempts; throw err;
  }
  return out.result;
}

async function listMessages(chat_user_id, { page = 1, page_size = 50 } = {}) {
  const params = { chat_user_id, page, page_size, project_id: PROJECT_ID };
  const out = await tryEndpoints(MSG_ENDPOINTS, params);
  if (!out.ok) {
    const err = new Error('All message endpoints failed');
    err.attempts = out.attempts; throw err;
  }
  return out.result;
}

const BUCKETS = {
  'price': { rx: /ÃÂ¥ÃÂÃÂ¹ÃÂ©ÃÂÃÂ¢|ÃÂ¥ÃÂ­ÃÂ¸ÃÂ¨ÃÂ²ÃÂ»|ÃÂ¥ÃÂ¤ÃÂÃÂ¥ÃÂ°ÃÂÃÂ©ÃÂÃÂ¢|ÃÂ¨ÃÂ²ÃÂ»ÃÂ§ÃÂÃÂ¨|ÃÂ¥ÃÂ ÃÂ±ÃÂ¥ÃÂÃÂ¹|ÃÂ¥ÃÂÃÂ¹ÃÂ¦ÃÂ ÃÂ¼/, label: 'ÃÂ¥ÃÂÃÂ¹ÃÂ¦ÃÂ ÃÂ¼ / ÃÂ¥ÃÂ­ÃÂ¸ÃÂ¨ÃÂ²ÃÂ»' },
  'content': { rx: /ÃÂ¨ÃÂªÃÂ²ÃÂ§ÃÂ¨ÃÂ|ÃÂ¦ÃÂÃÂÃÂ¤ÃÂ»ÃÂÃÂ©ÃÂºÃÂ¼|ÃÂ¥ÃÂÃÂ§ÃÂ¥ÃÂ®ÃÂ¹|ÃÂ¥ÃÂ¤ÃÂ§ÃÂ§ÃÂ¶ÃÂ±|ÃÂ¥ÃÂ­ÃÂ¸ÃÂ¤ÃÂ»ÃÂÃÂ©ÃÂºÃÂ¼/, label: 'ÃÂ¨ÃÂªÃÂ²ÃÂ§ÃÂ¨ÃÂÃÂ¥ÃÂÃÂ§ÃÂ¥ÃÂ®ÃÂ¹' },
  'time': { rx: /ÃÂ¦ÃÂÃÂÃÂ©ÃÂÃÂ|ÃÂ¤ÃÂ»ÃÂÃÂ©ÃÂºÃÂ¼ÃÂ¦ÃÂÃÂÃÂ¥ÃÂÃÂ|ÃÂ©ÃÂÃÂÃÂ¨ÃÂªÃÂ²|ÃÂ¤ÃÂ½ÃÂÃÂ¦ÃÂÃÂ/, label: 'ÃÂ¤ÃÂ¸ÃÂÃÂ¨ÃÂªÃÂ²ÃÂ¦ÃÂÃÂÃÂ©ÃÂÃÂ' },
  'pay': { rx: /ÃÂ¦ÃÂÃÂÃÂ©ÃÂºÃÂ¼ÃÂ¥ÃÂ ÃÂ±ÃÂ¥ÃÂÃÂ|ÃÂ¤ÃÂ»ÃÂÃÂ¦ÃÂ¬ÃÂ¾|ÃÂ¥ÃÂÃÂ¯ÃÂ¦ÃÂ¬ÃÂ¾|ÃÂ¥ÃÂÃÂ·ÃÂ¥ÃÂÃÂ¡|ÃÂ¥ÃÂÃÂÃÂ¦ÃÂÃÂ/, label: 'ÃÂ¥ÃÂ ÃÂ±ÃÂ¥ÃÂÃÂ / ÃÂ¤ÃÂ»ÃÂÃÂ¦ÃÂ¬ÃÂ¾' },
  'cert': { rx: /ÃÂ¨ÃÂ­ÃÂÃÂ§ÃÂÃÂ§|ÃÂ¨ÃÂ­ÃÂÃÂ¦ÃÂÃÂ¸|ÃÂ¥ÃÂÃÂ·ÃÂ§ÃÂÃÂ§|ÃÂ§ÃÂµÃÂÃÂ¦ÃÂ¥ÃÂ­/, label: 'ÃÂ¨ÃÂ­ÃÂÃÂ§ÃÂÃÂ§ / ÃÂ§ÃÂµÃÂÃÂ¦ÃÂ¥ÃÂ­' },
  'refund': { rx: /ÃÂ©ÃÂÃÂÃÂ¨ÃÂ²ÃÂ»|ÃÂ¥ÃÂÃÂÃÂ¦ÃÂ¶ÃÂ|ÃÂ©ÃÂÃÂÃÂ¦ÃÂ¬ÃÂ¾/, label: 'ÃÂ©ÃÂÃÂÃÂ¨ÃÂ²ÃÂ» / ÃÂ¥ÃÂÃÂÃÂ¦ÃÂ¶ÃÂ' },
  'teacher': { rx: /ÃÂ¨ÃÂÃÂÃÂ¥ÃÂ¸ÃÂ«|ÃÂ¥ÃÂ¸ÃÂ«ÃÂ¨ÃÂ³ÃÂ|ÃÂ¨ÃÂªÃÂ°ÃÂ¦ÃÂÃÂ/, label: 'ÃÂ¥ÃÂ¸ÃÂ«ÃÂ¨ÃÂ³ÃÂ / ÃÂ¨ÃÂÃÂÃÂ¥ÃÂ¸ÃÂ«' },
  'place': { rx: /ÃÂ¥ÃÂÃÂ°ÃÂ©ÃÂ»ÃÂ|ÃÂ¦ÃÂÃÂÃÂ¥ÃÂ®ÃÂ¤|ÃÂ¥ÃÂÃÂ°ÃÂ¥ÃÂÃÂ|ÃÂ¥ÃÂÃÂªÃÂ¨ÃÂ£ÃÂ¡/, label: 'ÃÂ¥ÃÂÃÂ°ÃÂ©ÃÂ»ÃÂ / ÃÂ¦ÃÂÃÂÃÂ¥ÃÂ®ÃÂ¤' },
};

function extractTopQuestions(messages) {
  const counts = {}, examples = {};
  for (const m of messages) {
    const text = (m.content || m.text || m.message || '').toString();
    if (!text) continue;
    for (const [k, b] of Object.entries(BUCKETS)) {
      if (b.rx.test(text)) {
        counts[k] = (counts[k] || 0) + 1;
        examples[k] = examples[k] || [];
        if (examples[k].length < 3) examples[k].push(text.slice(0, 80));
        break;
      }
    }
  }
  return Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([k,c]) => ({
    topic: BUCKETS[k].label, count: c, samples: examples[k] || []
  }));
}

async function getCustomerInsights({ days = 7 } = {}) {
  if (!TOKEN || !PROJECT_ID) return { ok: false, reason: 'env not set', summary: null };
  try {
    const cl = await listRecentConversations({ days, page_size: 100 });
    const convs = cl.data || cl.list || cl.items || (cl.result && cl.result.list) || [];
    const allMsgs = [];
    for (const conv of convs.slice(0, 20)) {
      const uid = conv.chat_user_id || conv.user_id || conv.contact_id || conv.id;
      if (!uid) continue;
      try {
        const mr = await listMessages(uid, { page_size: 30 });
        const ms = mr.data || mr.list || mr.items || (mr.result && mr.result.list) || [];
        const inb = ms.filter(m => {
          const d = m.direction || m.from_type || m.sender_type || m.message_direction;
          return d === 'in' || d === 'visitor' || d === 'customer' || d === 1 || d === '1';
        });
        allMsgs.push(...inb);
      } catch {}
    }
    const topics = extractTopQuestions(allMsgs);
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ updated_at: new Date().toISOString(), conversation_count: convs.length, message_count: allMsgs.length, topics, endpoint_used: cl._endpoint_used }, null, 2));
    } catch {}
    return { ok: true, conversation_count: convs.length, message_count: allMsgs.length, topics, summary: formatBriefingSection(topics, convs.length, allMsgs.length, days), endpoint_used: cl._endpoint_used };
  } catch (err) {
    return { ok: false, reason: err.message, attempts: err.attempts || null, summary: null };
  }
}

function formatBriefingSection(topics, convCount, msgCount, days) {
  if (!topics || topics.length === 0) return 'ÃÂ¥ÃÂ®ÃÂ¢ÃÂ¦ÃÂÃÂÃÂ¯ÃÂ¼ÃÂÃÂ©ÃÂÃÂÃÂ¥ÃÂÃÂ» ' + days + ' ÃÂ¥ÃÂ¤ÃÂ©ÃÂ¯ÃÂ¼ÃÂÃÂ¯ÃÂ¼ÃÂÃÂ§ÃÂÃÂ¡ÃÂ¥ÃÂ°ÃÂÃÂ¨ÃÂ©ÃÂ±ÃÂ¨ÃÂ³ÃÂÃÂ¦ÃÂÃÂ';
  const lines = ['ÃÂ°ÃÂÃÂÃÂ ÃÂ¦ÃÂÃÂ¬ÃÂ©ÃÂÃÂ±ÃÂ¥ÃÂ®ÃÂ¢ÃÂ¦ÃÂÃÂÃÂ¦ÃÂ´ÃÂÃÂ¥ÃÂ¯ÃÂÃÂ¯ÃÂ¼ÃÂÃÂ©ÃÂÃÂÃÂ¥ÃÂÃÂ» ' + days + ' ÃÂ¥ÃÂ¤ÃÂ©ÃÂ¯ÃÂ¼ÃÂ' + convCount + ' ÃÂ¥ÃÂ ÃÂ´ÃÂ¥ÃÂ°ÃÂÃÂ¨ÃÂ©ÃÂ± / ' + msgCount + ' ÃÂ¥ÃÂÃÂÃÂ¥ÃÂ®ÃÂ¢ÃÂ¤ÃÂºÃÂºÃÂ¨ÃÂ¨ÃÂÃÂ¦ÃÂÃÂ¯ÃÂ¯ÃÂ¼ÃÂ'];
  topics.slice(0, 5).forEach((t, i) => { lines.push((i+1) + '. ' + t.topic + 'ÃÂ¯ÃÂ¼ÃÂ' + t.count + ' ÃÂ¦ÃÂ¬ÃÂ¡'); });
  if (topics[0] && topics[0].count >= 5) {
    lines.push('');
    lines.push('ÃÂ°ÃÂÃÂÃÂ¡ ÃÂ¥ÃÂ»ÃÂºÃÂ¨ÃÂ­ÃÂ°ÃÂ¯ÃÂ¼ÃÂÃÂ£ÃÂÃÂ' + topics[0].topic + 'ÃÂ£ÃÂÃÂÃÂ©ÃÂÃÂÃÂ©ÃÂÃÂ±ÃÂ¨ÃÂ¢ÃÂ«ÃÂ¥ÃÂÃÂ ' + topics[0].count + ' ÃÂ¦ÃÂ¬ÃÂ¡ ÃÂ¢ÃÂÃÂ CAMILLE ÃÂ¥ÃÂ¯ÃÂ«ÃÂ¤ÃÂ¸ÃÂÃÂ§ÃÂ¯ÃÂ FAQ');
  }
  return lines.join('\n');
}

// Debug: probe all endpoint variants
async function probeAll() {
  const probe_params = { page: 1, page_size: 5, project_id: PROJECT_ID };
  const conv = await tryEndpoints(CONV_ENDPOINTS, probe_params);
  return {
    token_set: !!TOKEN, project_id: PROJECT_ID, base_url: BASE_URL,
    conv_probe: conv,
  };
}

module.exports = { signParams, apiCall, listRecentConversations, listMessages, extractTopQuestions, getCustomerInsights, formatBriefingSection, probeAll };
