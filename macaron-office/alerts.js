// ============================================================
// ofz beauty academy · 主動推播模組 (alerts)
// ------------------------------------------------------------
// 功能：
// 1. dailyBriefing()  — 每日 09:00 由 VICTOR 統合產出今日簡報
// 2. eventMonitor()   — 每 30 分鐘檢查 ROAS / LINE 積壓 / 燒預算
// 3. pushToAdmin()    — 把訊息推到 admin 的 LINE
// 4. registerAdminFromLine() — admin 在 LINE 對 Bot 傳 "/admin" 註冊
// ============================================================

const fs = require("fs");
const path = require("path");

const ADMIN_FILE_NAME = "admin.json";

function adminPath(dataDir) {
  return path.join(dataDir, ADMIN_FILE_NAME);
}

function loadAdmin(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(adminPath(dataDir), "utf8"));
  } catch (e) {
    return { lineUserId: null, registeredAt: null };
  }
}

function saveAdmin(dataDir, data) {
  fs.writeFileSync(adminPath(dataDir), JSON.stringify(data, null, 2), "utf8");
}

function registerAdminFromLine(dataDir, userId, userName) {
  const data = {
    lineUserId: userId,
    userName: userName || null,
    registeredAt: new Date().toISOString(),
  };
  saveAdmin(dataDir, data);
  console.log(`[alerts] admin registered: ${userName || userId}`);
  return data;
}

async function pushToAdmin({ line, dataDir, text }) {
  const admin = loadAdmin(dataDir);
  if (!admin.lineUserId) {
    console.warn("[alerts] no admin registered, skipping push");
    return { ok: false, reason: "no admin" };
  }
  if (!line.tokenOk()) {
    console.warn("[alerts] LINE token not configured");
    return { ok: false, reason: "no LINE token" };
  }
  try {
    // LINE 單一訊息限 5000 字
    const safeText = text.length > 4900 ? text.slice(0, 4800) + "\n\n…(訊息過長已截斷)" : text;
    const result = await line.pushMessage(admin.lineUserId, [{ type: "text", text: safeText }]);
    return { ok: true, result };
  } catch (e) {
    console.error("[alerts] push failed", e.message || e);
    return { ok: false, reason: String(e.message || e) };
  }
}

// ────────────────────────────────────────────────────────────
// 每日早安簡報：VICTOR 統合產出
// ────────────────────────────────────────────────────────────
async function dailyBriefing({ anthropic, model, employees, meta, customers, dataDir, line }) {
  const victor = employees.victor;
  if (!anthropic || !victor) return { ok: false, reason: "not configured" };

  // 1. 收集資料快照
  const snapshot = { timestamp: new Date().toISOString() };

  try {
    snapshot.metaInsights = await meta.getAdsInsights({ datePreset: "last_7d" });
  } catch (e) {
    snapshot.metaInsights = { error: e.message };
  }

  try {
    const ads = await meta.getAdsWithInsights({ datePreset: "last_7d", limit: 30 });
    snapshot.topAds = ads.slice(0, 10).map((a) => ({
      name: a.name,
      spend: a.spend,
      roas: a.purchase_roas?.[0]?.value || null,
      ctr: a.ctr,
      cpm: a.cpm,
    }));
  } catch (e) {
    snapshot.topAds = { error: e.message };
  }

  try {
    const lineMessagesPath = path.join(dataDir, "line-messages.json");
    if (fs.existsSync(lineMessagesPath)) {
      const arr = JSON.parse(fs.readFileSync(lineMessagesPath, "utf8"));
      snapshot.linePending = arr.filter((m) => !m.replied).length;
      snapshot.lineTotal24h = arr.filter(
        (m) => Date.now() - new Date(m.timestamp).getTime() < 24 * 3600 * 1000
      ).length;
    }
  } catch (e) {
    snapshot.linePending = "?";
  }

  try {
    const profiles = customers.loadCustomerProfiles(dataDir);
    const messages = customers.loadMessages(dataDir);
    const list = customers.aggregateCustomers(messages, profiles);
    const groups = customers.groupBySegment(list);
    snapshot.customerSegments = {
      vip: groups.vip.length,
      active: groups.active.length,
      new: groups.new.length,
      atrisk: groups.atrisk.length,
    };
  } catch (e) {
    snapshot.customerSegments = { error: e.message };
  }

  // 2. 餵給 VICTOR 產簡報
  const today = new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][
    new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei", weekday: "long" }) ===
    new Date().toLocaleString("en-US", { weekday: "long" })
      ? new Date().getDay()
      : new Date().getDay()
  ];

  const userPrompt = `現在是台灣早上 09:00，請以 ofz beauty academy 行銷總監身分，產出推到 Jeffrey LINE 的「今日早安簡報」。

【今日資料快照】
${JSON.stringify(snapshot, null, 2).slice(0, 4500)}

【輸出規範（嚴格遵守）】
- 純文字格式（不要 HTML、不要 Markdown），LINE 訊息要短而精，不超過 800 字
- 結構固定如下：

📊 ofz · 早安簡報 · ${today} (${weekday})

🎯 今日重點
（2-3 句濃縮昨日成效，分課程 vs 療程、🇹🇼 vs 🇲🇾）

🚨 今天優先處理（最多 3 件）
1. [LEON/SOFIA/DEX/誰] 動詞開頭的具體建議（為何要做、預估多久、誰負責）
2. ...
3. ...

📈 廣告紅綠燈（不要太囉唆）
🔴 紅燈 N 個：（簡述）
🟡 黃燈 N 個：（簡述）
🟢 綠燈 N 個：（放著跑）

打 https://beauty-office.onrender.com 找 VICTOR 拿詳細

【鐵則】
- 不要寫「請問需要更多資訊嗎」這種廢話
- 三件待辦中，至少一件是「Jeffrey 必須親自做的決策」（其他可委派員工）
- 沒有資料的欄位寫 "（資料缺，待設定）"，不要硬掰`;

  let text;
  try {
    const msg = await anthropic.messages.create({
      model: model,
      max_tokens: 1500,
      system: victor.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    text = msg.content
      .map((b) => b.text || "")
      .join("")
      .trim();
  } catch (e) {
    console.error("[alerts dailyBriefing] AI failed", e);
    return { ok: false, reason: e.message };
  }

  if (!text) return { ok: false, reason: "empty briefing" };

  // 3. 推到 admin
  const pushed = await pushToAdmin({ line, dataDir, text });
  return { ok: true, text, pushed, snapshotKeys: Object.keys(snapshot) };
}

// ────────────────────────────────────────────────────────────
// 事件即時監控：ROAS / LINE 積壓 / 燒預算
// ────────────────────────────────────────────────────────────
async function eventMonitor({ anthropic, model, employees, meta, customers, dataDir, line }) {
  const checks = [];

  // Check 1: Meta 廣告 ROAS < 1.0 且燒費 > NTD 1000 = 紅燈
  try {
    const ads = await meta.getAdsWithInsights({ datePreset: "last_7d", limit: 50 });
    const lowRoasAds = ads.filter((a) => {
      const spend = Number(a.spend || 0);
      const roasVal = Number(a.purchase_roas?.[0]?.value || 0);
      return spend > 1000 && roasVal > 0 && roasVal < 1.0;
    });
    if (lowRoasAds.length > 0) {
      const detail = lowRoasAds
        .slice(0, 3)
        .map(
          (a) =>
            `· ${a.name?.slice(0, 30) || "?"}：燒 NT$${Math.round(
              a.spend
            )} ROAS ${Number(a.purchase_roas[0].value).toFixed(2)}`
        )
        .join("\n");
      checks.push({
        type: "low-roas",
        severity: "high",
        title: `🔴 ${lowRoasAds.length} 個廣告 ROAS < 1.0`,
        detail,
      });
    }
  } catch (e) {
    /* skip */
  }

  // Check 2: LINE 客人訊息 > 60 分鐘沒回（上班時間 09-21）
  try {
    const lineMessagesPath = path.join(dataDir, "line-messages.json");
    if (fs.existsSync(lineMessagesPath)) {
      const arr = JSON.parse(fs.readFileSync(lineMessagesPath, "utf8"));
      const now = Date.now();
      const stale = arr.filter(
        (m) => !m.replied && now - new Date(m.timestamp).getTime() > 60 * 60 * 1000
      );
      // 只在台灣 09:00-21:00 推
      const taipeiHour = Number(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei", hour: "numeric", hour12: false })
      );
      if (stale.length > 0 && taipeiHour >= 9 && taipeiHour < 21) {
        const detail = stale
          .slice(0, 3)
          .map(
            (m) => `· ${m.userName || "(匿名)"}：「${(m.text || "").slice(0, 40)}…」`
          )
          .join("\n");
        checks.push({
          type: "line-stale",
          severity: "medium",
          title: `💬 ${stale.length} 則 LINE 訊息超過 1 小時沒回`,
          detail,
        });
      }
    }
  } catch (e) {
    /* skip */
  }

  // Check 3: Meta 帳戶 7 日燒費 > 0 但 conv = 0 → 廣告白燒警告
  try {
    const insights = await meta.getAdsInsights({ datePreset: "last_7d" });
    const totalSpend = Number(insights?.spend || 0);
    const totalConv = Number(insights?.purchases || insights?.conversions || 0);
    if (totalSpend > 5000 && totalConv === 0) {
      checks.push({
        type: "no-conversions",
        severity: "high",
        title: `🔴 過去 7 天廣告燒 NT$${Math.round(totalSpend)} 但 0 轉換`,
        detail: "可能是追蹤碼壞了 / 受眾錯了 / 落地頁壞了，請馬上處理",
      });
    }
  } catch (e) {
    /* skip */
  }

  if (checks.length === 0) return { ok: true, alerts: [], pushed: null };

  const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  const text =
    `⚠️ ofz · 即時警示 · ${now}\n\n` +
    checks.map((c) => `${c.title}\n${c.detail}`).join("\n\n───\n\n") +
    `\n\n打 https://beauty-office.onrender.com 找 VICTOR 處理`;

  const pushed = await pushToAdmin({ line, dataDir, text });
  return { ok: true, alerts: checks, pushed };
}

module.exports = {
  loadAdmin,
  saveAdmin,
  registerAdminFromLine,
  pushToAdmin,
  dailyBriefing,
  eventMonitor,
};
