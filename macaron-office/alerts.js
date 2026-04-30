// ============================================================
// ofz beauty academy · 主動推播模組 (alerts) v3
// ------------------------------------------------------------
// 功能：
// 1. dailyBriefing()  — 每日 09:00 由 VICTOR 統合產出今日簡報
//                       依星期幾智慧切換：一(戰略) / 三(中週) / 日(回顧)
//                       每天都加「等你拍板」決策清單
// 2. eventMonitor()   — 每 30 分鐘檢查 ROAS / 燒預算
// 3. pushToAdmin()    — 把訊息推到 admin 的 LINE
// 4. registerAdminFromLine() — admin 在 LINE 對 Bot 傳 "/admin" 註冊
// ============================================================

const fs = require("fs");
const path = require("path");
const salesmartly = (() => { try { return require("./salesmartly"); } catch { return null; } })();

const ADMIN_FILE_NAME = "admin.json";

function adminPath(dataDir) {
  return path.join(dataDir, ADMIN_FILE_NAME);
}

function loadAdmin(dataDir) {
  // Env var 優先（永久化，不受 Render 重新部署影響）
  if (process.env.ADMIN_LINE_USER_ID) {
    return {
      lineUserId: process.env.ADMIN_LINE_USER_ID,
      userName: process.env.ADMIN_LINE_USER_NAME || null,
      registeredAt: "env-var",
      source: "env",
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(adminPath(dataDir), "utf8"));
    return { ...data, source: "file" };
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

async function dailyBriefing({ anthropic, model, employees, meta, customers, dataDir, line }) {
  const victor = employees.victor;
  if (!anthropic || !victor) return { ok: false, reason: "not configured" };

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
    snapshot.customerSegments = { error: e.message }
  }
  // 客服洞察（SaleSmartly）— 從 cache 讀（背景刷新避免拖慢 briefing）
  try {
    const cacheFile = path.join(__dirname, 'data', 'salesmartly_conversations.json');
    if (fs.existsSync(cacheFile)) {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cache && cache.topics) {
        snapshot.customerInsights = {
          conversation_count: cache.conversation_count,
          message_count: cache.message_count,
          topics: cache.topics,
          updated_at: cache.updated_at,
        };
      }
    }
    if (salesmartly && typeof salesmartly.getCustomerInsights === 'function') {
      salesmartly.getCustomerInsights({ days: 7 }).catch(() => {});
    }
  } catch (e) {
    console.error('[alerts] salesmartly cache read failed:', e.message);
  }

  const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const today = taipeiNow.toLocaleDateString("zh-TW");
  const dayNum = taipeiNow.getDay();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][dayNum];

  let specialBlock = "";
  if (dayNum === 1) {
    specialBlock = `

🎯 本週戰略（週一獨有，要花腦力想清楚）
本週主題：（一句話定調，例：「攻馬國線上課招生」）
3 大目標：
1. （含具體 KPI 數字）
2. ...
3. ...
員工分工：
· LEON：本週負責...
· SOFIA：本週負責...
· DEX：本週負責...
· （其他員工）...

⚠️ Jeffrey 本週只需要決定 2-3 件大事（後面決策清單會列）`;
  } else if (dayNum === 3) {
    specialBlock = `

🔄 中週調整（週三獨有）
週一目標完成度：1️⃣ X% 2️⃣ X% 3️⃣ X%
偏離預期的：（哪一項落後、為什麼、要不要調整方向）
後半週要修什麼：（具體動作）`;
  } else if (dayNum === 0) {
    specialBlock = `

📚 本週學習（週日獨有）
本週 work：（哪些動作奏效、為什麼）
本週 fail：（哪些 fail、學到什麼）
數字總結：本週招生 N 人、廣告燒 NT$X、ROAS Y

🔮 下週預告
下週主題：（預告，但別太死，週一會重新確認）
要 Jeffrey 週日晚上想清楚的：（1-2 件）`;
  }

  const userPrompt = `現在是台灣早上 09:00，請以 ofz beauty academy 行銷總監身分，產出推到 Jeffrey LINE 的「今日早安簡報」。

【今日資料快照】
${JSON.stringify(snapshot, null, 2).slice(0, 4500)}

【輸出規範（嚴格遵守）】
- 純文字格式（不要 HTML、不要 Markdown）
- LINE 訊息上限 1500 字
- 結構固定如下：

📊 ofz · 早安簡報 · ${today} (${weekday})
${specialBlock}

🎯 今日重點
（2-3 句濃縮昨日成效，分課程 vs 療程、🇹🇼 vs 🇲🇾）

🚨 今天 3 件員工任務（已分配，員工自己會做）
1. [LEON/SOFIA/DEX/誰] 動詞開頭的具體任務（誰、做什麼、deadline）
2. ...
3. ...

🤔 等你拍板（最多 3 件，每件都要附 AI 推薦 + 理由）
1. 【決策題目】：（一句話講清楚要決定什麼）
   背景：（1-2 句脈絡）
   👉 [員工名] 推薦：[具體答案]
   理由：（為何這個答案，1-2 句）
   📲 你回「1ok」同意 / 「1no」拒絕 / 「1?」要討論

2. 【決策題目】：...
   ...
   📲 回「2ok / 2no / 2?」

3. 【決策題目】：...
   ...
   📲 回「3ok / 3no / 3?」

📈 廣告紅綠燈
🔴 紅燈 N 個：（簡述）
🟡 黃燈 N 個：（簡述）
🟢 綠燈 N 個：（放著跑）

打 https://beauty-office.onrender.com 找 VICTOR 拿詳細

【鐵則】
- 不要寫「請問需要更多資訊嗎」這種廢話
- 「等你拍板」3 件必須是真正需要 Jeffrey 決定的事（不是員工自己能搞定的小事）
- 每件決策的「推薦答案」要明確（不要「看情況」、「再觀察」這種模糊回答）
- 推薦答案的「理由」要基於數據（廣告 ROAS、客人留言、課程銷量），不要憑感覺
- 沒有資料的欄位寫 "（資料缺，待設定）"，不要硬掰
- 如果今天真的沒有需要 Jeffrey 拍板的事，「等你拍板」就寫「✨ 今天沒大事，員工自己會處理」`;

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

  const pushed = await pushToAdmin({ line, dataDir, text });
  return { ok: true, text, pushed, snapshotKeys: Object.keys(snapshot) };
}

async function eventMonitor({ anthropic, model, employees, meta, customers, dataDir, line }) {
  const checks = [];

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
  } catch (e) {}

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
  } catch (e) {}

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
