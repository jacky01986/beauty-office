// ============================================================
// MACARON DE LUXE · Meta Graph API Client (read-only, Stage 2)
// ------------------------------------------------------------
// Wraps Graph API v21.0 endpoints for:
//   • Facebook Page posts / insights
//   • Instagram Business media / insights
//   • Meta Ads account-level insights + campaign list
//
// All calls are READ-ONLY. Writes (publishing, ad-budget edits)
// come in Stage 3.
//
// Required env vars:
//   META_ACCESS_TOKEN     long-lived system-user or page token
//   META_FB_PAGE_ID       numeric FB page id (optional)
//   META_IG_USER_ID       numeric IG Business user id (optional)
//   META_AD_ACCOUNT_ID    numeric ad account id without act_ prefix (optional)
// ============================================================

const GRAPH = "https://graph.facebook.com/v21.0";

function tokenOk() {
  return !!process.env.META_ACCESS_TOKEN;
}

async function graphGet(pathWithQuery) {
  if (!tokenOk()) throw new Error("META_ACCESS_TOKEN not set");
  const sep = pathWithQuery.includes("?") ? "&" : "?";
  const url = `${GRAPH}${pathWithQuery}${sep}access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    const code = body.error?.code;
    const err = new Error(`Graph API error: ${msg}${code ? ` (code ${code})` : ""}`);
    err.status = res.status;
    err.graphError = body.error;
    throw err;
  }
  return body;
}

// ─────────────────────── health / status ───────────────────────

async function getStatus() {
  const out = {
    tokenSet: tokenOk(),
    pageIdSet: !!process.env.META_FB_PAGE_ID,
    igIdSet: !!process.env.META_IG_USER_ID,
    adAccountSet: !!process.env.META_AD_ACCOUNT_ID,
    me: null,
    page: null,
    ig: null,
    ad: null,
    errors: [],
  };
  if (!out.tokenSet) {
    out.errors.push("META_ACCESS_TOKEN missing");
    return out;
  }
  try {
    out.me = await graphGet(`/me?fields=id,name`);
  } catch (e) {
    out.errors.push("token check: " + e.message);
  }
  if (out.pageIdSet) {
    try {
      out.page = await graphGet(`/${process.env.META_FB_PAGE_ID}?fields=id,name,fan_count,followers_count,about`);
    } catch (e) {
      out.errors.push("FB page: " + e.message);
    }
  }
  if (out.igIdSet) {
    try {
      out.ig = await graphGet(`/${process.env.META_IG_USER_ID}?fields=id,username,followers_count,media_count`);
    } catch (e) {
      out.errors.push("IG: " + e.message);
    }
  }
  if (out.adAccountSet) {
    try {
      out.ad = await graphGet(`/act_${process.env.META_AD_ACCOUNT_ID}?fields=name,account_status,currency,amount_spent,balance`);
    } catch (e) {
      out.errors.push("Ads: " + e.message);
    }
  }
  return out;
}

// ─────────────────────── Facebook Page ───────────────────────

async function getFbPagePosts({ limit = 10 } = {}) {
  const id = process.env.META_FB_PAGE_ID;
  if (!id) throw new Error("META_FB_PAGE_ID not set");
  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "reactions.summary(total_count)",
    "comments.summary(total_count)",
    "shares",
  ].join(",");
  const data = await graphGet(`/${id}/posts?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(p => ({
    id: p.id,
    message: p.message || "",
    createdTime: p.created_time,
    permalink: p.permalink_url,
    reactions: p.reactions?.summary?.total_count ?? 0,
    comments: p.comments?.summary?.total_count ?? 0,
    shares: p.shares?.count ?? 0,
  }));
}

// ─────────────────────── Instagram Business ───────────────────────

async function getIgMedia({ limit = 10 } = {}) {
  const id = process.env.META_IG_USER_ID;
  if (!id) throw new Error("META_IG_USER_ID not set");
  const fields = [
    "id",
    "caption",
    "media_type",
    "media_url",
    "thumbnail_url",
    "permalink",
    "timestamp",
    "like_count",
    "comments_count",
  ].join(",");
  const data = await graphGet(`/${id}/media?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(m => ({
    id: m.id,
    caption: m.caption || "",
    mediaType: m.media_type,
    mediaUrl: m.media_url,
    thumbnail: m.thumbnail_url,
    permalink: m.permalink,
    timestamp: m.timestamp,
    likes: m.like_count ?? 0,
    comments: m.comments_count ?? 0,
  }));
}

// ─────────────────────── Meta Ads ───────────────────────

async function getAdsInsights({ datePreset = "last_7d" } = {}) {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  const fields = [
    "impressions",
    "reach",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "spend",
    "actions",
    "action_values",
    "date_start",
    "date_stop",
  ].join(",");
  const data = await graphGet(`/act_${id}/insights?fields=${fields}&date_preset=${datePreset}&level=account`);
  const row = (data.data || [])[0] || null;
  if (!row) return null;
  const purchases = (row.actions || []).find(a => a.action_type === "purchase");
  const purchaseValue = (row.action_values || []).find(a => a.action_type === "purchase");
  return {
    dateStart: row.date_start,
    dateStop: row.date_stop,
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    ctr: Number(row.ctr || 0),
    cpc: Number(row.cpc || 0),
    cpm: Number(row.cpm || 0),
    spend: Number(row.spend || 0),
    purchases: Number(purchases?.value || 0),
    revenue: Number(purchaseValue?.value || 0),
    roas: purchaseValue && row.spend ? Number(purchaseValue.value) / Number(row.spend) : null,
  };
}

async function getAdCampaigns({ limit = 25 } = {}) {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  const fields = [
    "id",
    "name",
    "status",
    "effective_status",
    "objective",
    "daily_budget",
    "lifetime_budget",
    "start_time",
    "stop_time",
  ].join(",");
  const data = await graphGet(`/act_${id}/campaigns?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    effectiveStatus: c.effective_status,
    objective: c.objective,
    dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
    startTime: c.start_time,
    stopTime: c.stop_time,
  }));
}

// ─────────────────────── Live-data snapshot for prompt injection ───────────────────────

// Returns a compact plain-text block suitable for stuffing into an
// employee system prompt so LEON / NOVA / ZARA have real numbers.
async function buildLiveDataBlock({ include = ["fb", "ig", "ads"] } = {}) {
  if (!tokenOk()) return null;
  const chunks = [];
  if (include.includes("fb") && process.env.META_FB_PAGE_ID) {
    try {
      const posts = await getFbPagePosts({ limit: 5 });
      chunks.push(
        `[FB 最新 5 篇貼文]\n` +
          posts
            .map(
              (p, i) =>
                `${i + 1}. (${p.createdTime?.slice(0, 10)}) ❤️${p.reactions} 💬${p.comments} 🔁${p.shares}\n   ${String(p.message).slice(0, 120)}`
            )
            .join("\n")
      );
    } catch (e) {
      chunks.push(`[FB] 讀取失敗：${e.message}`);
    }
  }
  if (include.includes("ig") && process.env.META_IG_USER_ID) {
    try {
      const media = await getIgMedia({ limit: 5 });
      chunks.push(
        `[IG 最新 5 篇]\n` +
          media
            .map(
              (m, i) =>
                `${i + 1}. (${m.timestamp?.slice(0, 10)}) ❤️${m.likes} 💬${m.comments} · ${m.mediaType}\n   ${String(m.caption).slice(0, 120)}`
            )
            .join("\n")
      );
    } catch (e) {
      chunks.push(`[IG] 讀取失敗：${e.message}`);
    }
  }
  if (include.includes("ads") && process.env.META_AD_ACCOUNT_ID) {
    try {
      const ins = await getAdsInsights({ datePreset: "last_7d" });
      if (ins) {
        chunks.push(
          `[Ads 過去 7 天帳戶總覽]\n` +
            `曝光 ${ins.impressions.toLocaleString()} | 觸及 ${ins.reach.toLocaleString()} | 點擊 ${ins.clicks.toLocaleString()}\n` +
            `CTR ${ins.ctr.toFixed(2)}% | CPC $${ins.cpc.toFixed(2)} | CPM $${ins.cpm.toFixed(2)}\n` +
            `花費 $${ins.spend.toFixed(0)} | 購買次數 ${ins.purchases} | 收益 $${ins.revenue.toFixed(0)}` +
            (ins.roas !== null ? ` | ROAS ${ins.roas.toFixed(2)}` : "")
        );
      }
      const camps = await getAdCampaigns({ limit: 10 });
      if (camps.length) {
        chunks.push(
          `[Ads 活動清單 top 10]\n` +
            camps
              .map(
                (c, i) =>
                  `${i + 1}. ${c.name} · ${c.effectiveStatus} · ${c.objective}` +
                  (c.dailyBudget ? ` · 日預算 $${c.dailyBudget}` : "") +
                  (c.lifetimeBudget ? ` · 總預算 $${c.lifetimeBudget}` : "")
              )
              .join("\n")
        );
      }
    } catch (e) {
      chunks.push(`[Ads] 讀取失敗：${e.message}`);
    }
  }
  if (!chunks.length) return null;
  return chunks.join("\n\n");
}

module.exports = {
  tokenOk,
  getStatus,
  getFbPagePosts,
  getIgMedia,
  getAdsInsights,
  getAdCampaigns,
  buildLiveDataBlock,
};
