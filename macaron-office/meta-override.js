// meta-override.js — Meta 多帳戶切換器後端
// 用 BM-based listing：先抓 /me/businesses，再對每個 BM 抓 owned_pages + owned_ad_accounts
// 回傳同時包含 ad_accounts (snake_case) 跟 adAccounts (camelCase)，跟既有前端兼容

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OVERRIDE_FILE = path.join(DATA_DIR, 'meta-override.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function getOverride() {
  ensureDir();
  if (!fs.existsSync(OVERRIDE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); } catch { return {}; }
}
function applyToEnv(p) {
  if (!p) return;
  if (p.pageId) process.env.META_FB_PAGE_ID = String(p.pageId);
  if (p.igId) process.env.META_IG_USER_ID = String(p.igId);
  if (p.adAccountId) {
    let v = String(p.adAccountId);
    if (!v.startsWith('act_')) v = 'act_' + v;
    process.env.META_AD_ACCOUNT_ID = v;
  }
}
function setOverride(payload) {
  ensureDir();
  const merged = Object.assign(getOverride(), payload || {});
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(merged, null, 2));
  applyToEnv(merged);
  return merged;
}
function clearOverride() {
  if (fs.existsSync(OVERRIDE_FILE)) fs.unlinkSync(OVERRIDE_FILE);
  return {};
}
function applyOnStartup() {
  const ov = getOverride();
  if (Object.keys(ov).length > 0) {
    applyToEnv(ov);
    console.log('[meta-override] restored:', Object.keys(ov).join(','));
  }
}

async function metaGraph(endpoint, params = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN not set');
  const url = new URL('https://graph.facebook.com/v19.0' + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString());
  const j = await res.json();
  if (!res.ok || j.error) throw new Error('Graph: ' + (j.error?.message || res.status));
  return j;
}

async function listAllPages() {
  const seen = new Map();
  const errors = [];
  // Strategy 1: /me/accounts
  try {
    const r = await metaGraph('/me/accounts', { fields: 'id,name,instagram_business_account{id,username}', limit: 100 });
    (r.data || []).forEach(p => {
      seen.set(p.id, {
        pageId: p.id, name: p.name,
        igId: p.instagram_business_account?.id || null,
        igUsername: p.instagram_business_account?.username || null,
        source: 'me/accounts',
      });
    });
  } catch (e) { errors.push('me/accounts: ' + e.message); }
  // Strategy 2: per-BM owned_pages + client_pages
  try {
    const bizRes = await metaGraph('/me/businesses', { fields: 'id,name', limit: 100 });
    for (const biz of (bizRes.data || [])) {
      for (const p of ['owned_pages', 'client_pages']) {
        try {
          const r = await metaGraph('/' + biz.id + '/' + p, { fields: 'id,name,instagram_business_account{id,username}', limit: 100 });
          (r.data || []).forEach(pg => {
            if (!seen.has(pg.id)) {
              seen.set(pg.id, {
                pageId: pg.id, name: pg.name,
                igId: pg.instagram_business_account?.id || null,
                igUsername: pg.instagram_business_account?.username || null,
                source: p + ':' + biz.name,
                business: biz.name, businessId: biz.id,
              });
            }
          });
        } catch (e) {/* one of the two often empty */}
      }
    }
  } catch (e) { errors.push('me/businesses: ' + e.message); }
  return { pages: Array.from(seen.values()), errors };
}

async function listAllAdAccounts() {
  const seen = new Map();
  const errors = [];
  try {
    const r = await metaGraph('/me/adaccounts', { fields: 'id,account_id,name,account_status,currency', limit: 100 });
    (r.data || []).forEach(a => {
      seen.set(a.id, {
        id: a.id, adAccountId: a.id, accountId: a.account_id, account_id: a.account_id,
        name: a.name, currency: a.currency,
        status: a.account_status === 1 ? 'active' : 'disabled',
        source: 'me/adaccounts',
      });
    });
  } catch (e) { errors.push('me/adaccounts: ' + e.message); }
  try {
    const bizRes = await metaGraph('/me/businesses', { fields: 'id,name', limit: 100 });
    for (const biz of (bizRes.data || [])) {
      for (const p of ['owned_ad_accounts', 'client_ad_accounts']) {
        try {
          const r = await metaGraph('/' + biz.id + '/' + p, { fields: 'id,account_id,name,account_status,currency', limit: 100 });
          (r.data || []).forEach(a => {
            if (!seen.has(a.id)) {
              seen.set(a.id, {
                id: a.id, adAccountId: a.id, accountId: a.account_id, account_id: a.account_id,
                name: a.name, currency: a.currency,
                status: a.account_status === 1 ? 'active' : 'disabled',
                source: p + ':' + biz.name,
                business: biz.name, businessName: biz.name, businessId: biz.id,
              });
            }
          });
        } catch (e) {/* skip */}
      }
    }
  } catch (e) { errors.push('me/businesses(ads): ' + e.message); }
  return { ad_accounts: Array.from(seen.values()), errors };
}

async function listAssets() {
  const result = { pages: [], ad_accounts: [], adAccounts: [], current: null, debug: {} };
  const pagesR = await listAllPages();
  result.pages = pagesR.pages;
  if (pagesR.errors.length) result.debug.pages_errors = pagesR.errors;
  const adsR = await listAllAdAccounts();
  result.ad_accounts = adsR.ad_accounts;
  result.adAccounts = adsR.ad_accounts; // alias for old frontend
  if (adsR.errors.length) result.debug.ad_accounts_errors = adsR.errors;
  result.current = {
    pageId: process.env.META_FB_PAGE_ID || null,
    igId: process.env.META_IG_USER_ID || null,
    adAccountId: process.env.META_AD_ACCOUNT_ID || null,
  };
  result.override = getOverride();
  return result;
}

module.exports = { getOverride, setOverride, clearOverride, applyOnStartup, listAssets, listAllPages, listAllAdAccounts };
