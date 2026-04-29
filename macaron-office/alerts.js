// ============================================================
// ofz beauty academy Â· ä¸»åæ¨æ­æ¨¡çµ (alerts) v3
// ------------------------------------------------------------
// åè½ï¼
// 1. dailyBriefing()  â æ¯æ¥ 09:00 ç± VICTOR çµ±åç¢åºä»æ¥ç°¡å ±
//                       ä¾ææå¹¾æºæ§åæï¼ä¸(æ°ç¥) / ä¸(ä¸­é±) / æ¥(åé¡§)
//                       æ¯å¤©é½å ãç­ä½ ææ¿ãæ±ºç­æ¸å®
// 2. eventMonitor()   â æ¯ 30 åéæª¢æ¥ ROAS / çé ç®
// 3. pushToAdmin()    â æè¨æ¯æ¨å° admin ç LINE
// 4. registerAdminFromLine() â admin å¨ LINE å° Bot å³ "/admin" è¨»å
// ============================================================

const fs = require("fs");
const path = require("path");
const salesmartly = (() => { try { return require("./salesmartly"); } catch { return null; } })();

const ADMIN_FILE_NAME = "admin.json";

function adminPath(dataDir) {
  return path.join(dataDir, ADMIN_FILE_NAME);
}

function loadAdmin(dataDir) {
  // Env var åªåï¼æ°¸ä¹åï¼ä¸å Render éæ°é¨ç½²å½±é¿ï¼
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
    // LINE å®ä¸è¨æ¯é 5000 å­
    const safeText = text.length > 4900 ? text.slice(0, 4800) + "\n\nâ¦(è¨æ¯éé·å·²æªæ·)" : text;
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
  const weekday = ["æ¥", "ä¸", "äº", "ä¸", "å", "äº", "å­"][dayNum];

  let specialBlock = "";
  if (dayNum === 1) {
    specialBlock = `

ð¯ æ¬é±æ°ç¥ï¼é±ä¸ç¨æï¼è¦è±è¦åæ³æ¸æ¥ï¼
æ¬é±ä¸»é¡ï¼ï¼ä¸å¥è©±å®èª¿ï¼ä¾ï¼ãæ»é¦¬åç·ä¸èª²æçãï¼
3 å¤§ç®æ¨ï¼
1. ï¼å«å·é« KPI æ¸å­ï¼
2. ...
3. ...
å¡å·¥åå·¥ï¼
Â· LEONï¼æ¬é±è² è²¬...
Â· SOFIAï¼æ¬é±è² è²¬...
Â· DEXï¼æ¬é±è² è²¬...
Â· ï¼å¶ä»å¡å·¥ï¼...

â ï¸ Jeffrey æ¬é±åªéè¦æ±ºå® 2-3 ä»¶å¤§äºï¼å¾é¢æ±ºç­æ¸å®æåï¼`;
  } else if (dayNum === 3) {
    specialBlock = `

ð ä¸­é±èª¿æ´ï¼é±ä¸ç¨æï¼
é±ä¸ç®æ¨å®æåº¦ï¼1ï¸â£ X% 2ï¸â£ X% 3ï¸â£ X%
åé¢é æçï¼ï¼åªä¸é è½å¾ãçºä»éº¼ãè¦ä¸è¦èª¿æ´æ¹åï¼
å¾åé±è¦ä¿®ä»éº¼ï¼ï¼å·é«åä½ï¼`;
  } else if (dayNum === 0) {
    specialBlock = `

ð æ¬é±å­¸ç¿ï¼é±æ¥ç¨æï¼
æ¬é± workï¼ï¼åªäºåä½å¥æãçºä»éº¼ï¼
æ¬é± failï¼ï¼åªäº failãå­¸å°ä»éº¼ï¼
æ¸å­ç¸½çµï¼æ¬é±æç N äººãå»£åç NT$XãROAS Y

ð® ä¸é±é å
ä¸é±ä¸»é¡ï¼ï¼é åï¼ä½å¥å¤ªæ­»ï¼é±ä¸æéæ°ç¢ºèªï¼
è¦ Jeffrey é±æ¥æä¸æ³æ¸æ¥çï¼ï¼1-2 ä»¶ï¼`;
  }

  const userPrompt = `ç¾å¨æ¯å°ç£æ©ä¸ 09:00ï¼è«ä»¥ ofz beauty academy è¡é·ç¸½ç£èº«åï¼ç¢åºæ¨å° Jeffrey LINE çãä»æ¥æ©å®ç°¡å ±ãã

ãä»æ¥è³æå¿«ç§ã
${JSON.stringify(snapshot, null, 2).slice(0, 4500)}

ãè¼¸åºè¦ç¯ï¼å´æ ¼éµå®ï¼ã
- ç´æå­æ ¼å¼ï¼ä¸è¦ HTMLãä¸è¦ Markdownï¼
- LINE è¨æ¯ä¸é 1500 å­
- çµæ§åºå®å¦ä¸ï¼

ð ofz Â· æ©å®ç°¡å ± Â· ${today} (${weekday})
${specialBlock}

ð¯ ä»æ¥éé»
ï¼2-3 å¥æ¿ç¸®æ¨æ¥ææï¼åèª²ç¨ vs çç¨ãð¹ð¼ vs ð²ð¾ï¼

ð¨ ä»å¤© 3 ä»¶å¡å·¥ä»»åï¼å·²åéï¼å¡å·¥èªå·±æåï¼
1. [LEON/SOFIA/DEX/èª°] åè©éé ­çå·é«ä»»åï¼èª°ãåä»éº¼ãdeadlineï¼
2. ...
3. ...

ð¤ ç­ä½ ææ¿ï¼æå¤ 3 ä»¶ï¼æ¯ä»¶é½è¦é AI æ¨è¦ + çç±ï¼
1. ãæ±ºç­é¡ç®ãï¼ï¼ä¸å¥è©±è¬æ¸æ¥è¦æ±ºå®ä»éº¼ï¼
   èæ¯ï¼ï¼1-2 å¥èçµ¡ï¼
   ð [å¡å·¥å] æ¨è¦ï¼[å·é«ç­æ¡]
   çç±ï¼ï¼çºä½éåç­æ¡ï¼1-2 å¥ï¼
   ð² ä½ åã1okãåæ / ã1noãæçµ / ã1?ãè¦è¨è«

2. ãæ±ºç­é¡ç®ãï¼...
   ...
   ð² åã2ok / 2no / 2?ã

3. ãæ±ºç­é¡ç®ãï¼...
   ...
   ð² åã3ok / 3no / 3?ã

ð å»£åç´ç¶ ç
ð´ ç´ç N åï¼ï¼ç°¡è¿°ï¼
ð¡ é»ç N åï¼ï¼ç°¡è¿°ï¼
ð¢ ç¶ ç N åï¼ï¼æ¾èè·ï¼

æ https://beauty-office.onrender.com æ¾ VICTOR æ¿è©³ç´°

ãéµåã
- ä¸è¦å¯«ãè«åéè¦æ´å¤è³è¨åãéç¨®å»¢è©±
- ãç­ä½ ææ¿ã3 ä»¶å¿é æ¯çæ­£éè¦ Jeffrey æ±ºå®çäºï¼ä¸æ¯å¡å·¥èªå·±è½æå®çå°äºï¼
- æ¯ä»¶æ±ºç­çãæ¨è¦ç­æ¡ãè¦æç¢ºï¼ä¸è¦ãçææ³ãããåè§å¯ãéç¨®æ¨¡ç³åç­ï¼
- æ¨è¦ç­æ¡çãçç±ãè¦åºæ¼æ¸æï¼å»£å ROASãå®¢äººçè¨ãèª²ç¨é·éï¼ï¼ä¸è¦ææè¦º
- æ²æè³æçæ¬ä½å¯« "ï¼è³æç¼ºï¼å¾è¨­å®ï¼"ï¼ä¸è¦ç¡¬æ°
- å¦æä»å¤©ççæ²æéè¦ Jeffrey ææ¿çäºï¼ãç­ä½ ææ¿ãå°±å¯«ãâ¨ ä»å¤©æ²å¤§äºï¼å¡å·¥èªå·±æèçã`;

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
            `Â· ${a.name?.slice(0, 30) || "?"}ï¼ç NT$${Math.round(
              a.spend
            )} ROAS ${Number(a.purchase_roas[0].value).toFixed(2)}`
        )
        .join("\n");
      checks.push({
        type: "low-roas",
        severity: "high",
        title: `ð´ ${lowRoasAds.length} åå»£å ROAS < 1.0`,
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
        title: `ð´ éå» 7 å¤©å»£åç NT$${Math.round(totalSpend)} ä½ 0 è½æ`,
        detail: "å¯è½æ¯è¿½è¹¤ç¢¼å£äº / åç¾é¯äº / è½å°é å£äºï¼è«é¦¬ä¸èç",
      });
    }
  } catch (e) {}

  if (checks.length === 0) return { ok: true, alerts: [], pushed: null };

  const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  const text =
    `â ï¸ ofz Â· å³æè­¦ç¤º Â· ${now}\n\n` +
    checks.map((c) => `${c.title}\n${c.detail}`).join("\n\nâââ\n\n") +
    `\n\næ https://beauty-office.onrender.com æ¾ VICTOR èç`;

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
