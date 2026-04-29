// auto-publish.js — 每天 10:00 自動產 IG + FB 草稿，推到 admin LINE
//
// env: ANTHROPIC_API_KEY, META_ACCESS_TOKEN, META_FB_PAGE_ID, META_IG_USER_ID
//
// 流程：
//   1. cron 每天 10:00 觸發 generateAndQueueDrafts
//   2. Claude (Sonnet 4.6) 寫 1 篇 IG + 1 篇 FB 草稿
//   3. 草稿存到 data/auto-drafts.json
//   4. 推 LINE 通知 admin（含預覽）
//   5. admin 想發就呼叫 publishDraft(draftId) 或用既有 /api/social/publish

const fs = require('fs');
const path = require('path');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const DATA_DIR = path.join(__dirname, 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'auto-drafts.json');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const salesmartly = (() => { try { return require('./salesmartly'); } catch { return null; } })();
const customers = (() => { try { return require('./customers'); } catch { return null; } })();
const alertsModule = (() => { try { return require('./alerts'); } catch { return null; } })();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadDrafts() {
  ensureDir();
  if (!fs.existsSync(DRAFTS_FILE)) return { drafts: [] };
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')); } catch { return { drafts: [] }; }
}
function saveDrafts(state) {
  ensureDir();
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(state, null, 2));
}
function genId() { return 'draft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  catch { client = null; }
  return client;
}

async function generateCaption({ platform, context }) {
  const c = getClient();
  if (!c) return null;
  const sys = platform === 'IG'
    ? '你是 CAMILLE — Macaron de Luxe 的 IG 文案企劃。寫 IG 貼文，主題環繞美甲/美容課程。' +
      '風格：溫暖、療癒、誠懇。長度 80-120 字。最後加 5-8 個相關 hashtag。用繁體中文。'
    : '你是 CAMILLE — Macaron de Luxe 的 FB 文案企劃。寫 FB 貼文，主題環繞美甲/美容課程或品牌故事。' +
      '風格：親切、有條理、引導行動。長度 100-180 字，結尾加 1 個 CTA。用繁體中文。';
  const user = '請寫今天的 ' + platform + ' 貼文。\n\n參考資料：\n' + JSON.stringify(context || {}).slice(0, 1500);
  try {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: sys,
      messages: [{ role: 'user', content: user }],
    });
    const block = res.content && res.content[0];
    if (block && block.type === 'text') return block.text.trim();
  } catch (err) {
    console.error('[auto-publish] Claude failed:', err.message);
  }
  return null;
}

async function pushToAdmin(text) {
  if (alertsModule && typeof alertsModule.pushToAdmin === 'function') {
    try { await alertsModule.pushToAdmin(text); return true; }
    catch (e) { console.error('[auto-publish] pushToAdmin failed:', e.message); }
  }
  return false;
}

async function generateAndQueueDrafts() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[auto-publish] ANTHROPIC_API_KEY not set, skip');
    return { ok: false, reason: 'no api key' };
  }

  // Gather context
  const context = {};
  try { if (customers && customers.getSegmentSnapshot) context.customers = await customers.getSegmentSnapshot(); } catch {}
  try {
    if (salesmartly && salesmartly.getCustomerInsights) {
      const r = await salesmartly.getCustomerInsights({ days: 7 });
      if (r && r.ok) context.customer_topics = r.topics;
    }
  } catch {}

  const generated = [];
  for (const platform of ['IG', 'FB']) {
    const caption = await generateCaption({ platform, context });
    if (!caption) continue;
    const draft = {
      id: genId(),
      platform,
      caption,
      status: 'pending',
      created_at: new Date().toISOString(),
      published_at: null,
    };
    generated.push(draft);
  }

  // Save
  const state = loadDrafts();
  state.drafts.push(...generated);
  if (state.drafts.length > 50) state.drafts = state.drafts.slice(-50);
  saveDrafts(state);
  console.log('[auto-publish] generated ' + generated.length + ' drafts');

  // Notify admin
  if (generated.length > 0) {
    const lines = ['📱 今日草稿（' + generated.length + ' 篇）已產出'];
    generated.forEach((d, i) => {
      lines.push('');
      lines.push('【' + d.platform + '】 ' + d.caption.slice(0, 80) + (d.caption.length > 80 ? '...' : ''));
    });
    lines.push('');
    lines.push('看完整內容：' + (process.env.PUBLIC_URL || 'https://beauty-office.onrender.com') + '/api/social/drafts');
    lines.push('要發佈：POST /api/social/publish 帶 draft_id');
    await pushToAdmin(lines.join('\n'));
  }

  return { ok: true, generated_count: generated.length, drafts: generated };
}

// Publish helpers via Meta Graph API
async function metaGraphPost(endpoint, params = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN not set');
  const url = 'https://graph.facebook.com/v19.0' + endpoint;
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => body.append(k, v));
  body.append('access_token', token);
  const res = await fetch(url, { method: 'POST', body });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error('Graph: ' + (j.error?.message || res.status));
  return j;
}

async function publishFB(caption) {
  const pageId = process.env.META_FB_PAGE_ID;
  if (!pageId) throw new Error('META_FB_PAGE_ID not set');
  return metaGraphPost('/' + pageId + '/feed', { message: caption });
}

async function publishDraftById(draftId) {
  const state = loadDrafts();
  const draft = state.drafts.find(d => d.id === draftId);
  if (!draft) throw new Error('draft not found');
  if (draft.status === 'published') throw new Error('already published');
  if (draft.platform === 'FB') {
    const r = await publishFB(draft.caption);
    draft.status = 'published';
    draft.published_at = new Date().toISOString();
    draft.publish_id = r.id;
    saveDrafts(state);
    return { ok: true, platform: 'FB', publish_id: r.id };
  }
  if (draft.platform === 'IG') {
    draft.status = 'needs-image';
    draft.note = 'IG 需要圖片，請手動貼上 caption';
    saveDrafts(state);
    return { ok: false, platform: 'IG', reason: 'IG 需要圖片，caption 已備好' };
  }
  return { ok: false, reason: 'unknown platform' };
}

function registerCronJobs(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('0 10 * * *', generateAndQueueDrafts, { timezone: tz });
  console.log('[auto-publish] cron jobs registered (drafts daily 10:00)');
}

module.exports = {
  generateAndQueueDrafts,
  publishDraftById,
  publishFB,
  registerCronJobs,
  loadDrafts,
};
