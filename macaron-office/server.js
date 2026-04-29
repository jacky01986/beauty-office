// ============================================================
// ofz beauty academy Â· Virtual Office Server v2
// ------------------------------------------------------------
// 1. /api/employees           â å¡å·¥æ¸å®
// 2. /api/chat                â ä¸è¬å®ä¸å¡å·¥ SSE å°è©±
// 3. /api/orchestrate         â è¡é·ç¸½ç£æ¨¡å¼ï¼æè§£ â å¹³è¡ â çµ±æ´
// 4. /api/reports             â æç¨å ±åç´é
// 5. node-cron èªåæç¨
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk").default;
const { EMPLOYEES } = require("./employees");
const meta = require("./meta");
const line = require("./line");
const google = require("./google");
const customers = require("./customers");
const alerts = require("./alerts");
const metaOverride = require("./meta-override");
metaOverride.applyOnStartup();
const autoPublish = require("./auto-publish");
const salesmartly = require("./salesmartly");
const metaCapi = require("./meta-capi");
const toolDefs = require("./tools");

// In-memory proposal storage (ä¿çå¨è¨æ¶é«å°±å¥½ï¼éåå¤±æ OK)
const PROPOSALS = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of PROPOSALS) if (now - v.createdAt > 30 * 60 * 1000) PROPOSALS.delete(k); }, 5 * 60 * 1000);
const multer = require("multer");

// Employees that benefit from Meta live data in their prompt
const META_AWARE_EMPLOYEES = new Set(["victor", "leon", "camille", "aria", "dex", "nova", "sofia", "milo", "emi"]);

const FORMAT_ENFORCEMENT = `

---
ãâ è¼¸åºæ ¼å¼éµå (æ¯ä¸è¼ªé½å¿é éµå®ï¼åå«ç¬¬ 2ã3ã4â¦ è¼ª) âã
æ¯æ¬¡åè¦é½å¿é ç¨ HTML çæ®µï¼ä¸è¦ç´æå­ï¼ï¼
<h4>æ¨é¡</h4>
<p>æ®µè½</p>
<ul><li>æ¢å</li></ul>
<div class="tldr">â¡ TL;DRï½éé»çµè«</div>
<table class="data"><thead><tr><th>é ç®</th><th>æ¸å­</th></tr></thead><tbody><tr><td>â¦</td><td>â¦</td></tr></tbody></table>
<strong>ç²é«</strong>ã<em>æé«</em>ã<code>ä»£ç¢¼</code>ã<blockquote>å¼è¿°</blockquote>

ç¦æ­¢ï¼ç´æå­æ®µè½ãMarkdown (## / **), åªè¼¸åº text æ²æ tagsã
æ¯æ¬¡é½è¦ç¨ <div class="tldr"> éé ­ç¸½çµï¼éåç¿æ£ä¸å¯çç¥ã

å¦æå°è©±é²å¥ç¬¬ 2ã3 è¼ªä»¥ä¸ï¼ä»é ä¿æä¸è¿° HTML çµæ§ï¼ä¸è¦å çºæ¯ãç¹¼çºå°è©±ãå°±ç°¡åã`;

async function maybeAugmentSystemPrompt(emp) {
  let baseSystem = emp.systemPrompt + FORMAT_ENFORCEMENT;
  if (!META_AWARE_EMPLOYEES.has(emp.id) || !meta.tokenOk()) return baseSystem;
  try {
    const metaBlock = await meta.buildCoachDataBlock();
    const googleBlock = google.tokenOk() ? await google.buildCoachDataBlock() : null;
    if (!metaBlock && !googleBlock) return baseSystem;
    let extra = "";
    if (metaBlock) {
      extra += "\n\n---\n[ð¡ COACHING DATA Â· Meta å³ææ¸æå¿«ç§]\n" +
        "ä»¥ä¸æ¯å¾ Meta Graph API å³ææåççå¯¦æ¸æï¼è«å¨æç·´å»ºè­°èåææåªåå¼ç¨éäºæ¸å­ï¼\n\n" +
        metaBlock + "\n\n(è³æä¾æºï¼Meta Graph API)";
    }
    if (googleBlock) {
      extra += "\n\n---\n[ð COACHING DATA Â· Google Ads å³ææ¸æå¿«ç§]\n" +
        googleBlock + "\n\n(è³æä¾æºï¼Google Ads API)";
    }
    return baseSystem + extra;
  } catch (e) {
    console.warn(`[meta coaching-data] ${emp.id}:`, e.message);
    return baseSystem;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
const DIRECTOR_MODEL = process.env.CLAUDE_DIRECTOR_MODEL || MODEL;
const DATA_DIR = path.join(__dirname, "data");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]", "utf8");

// LINE upload directory (T4.6)
const LINE_UPLOAD_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(LINE_UPLOAD_DIR)) fs.mkdirSync(LINE_UPLOAD_DIR, { recursive: true });
const lineUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LINE_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase().slice(0, 5);
    const safeExt = /\.(jpg|jpeg|png|gif|webp)$/i.test(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,10)}${safeExt}`);
  },
});
const lineUpload = multer({
  storage: lineUploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error("only images allowed"));
    cb(null, true);
  },
});

app.use(cors());

// ============================================================
// /api/line/webhook â LINE è¨æ¯æ¥æ¶ç«¯ï¼è¦ raw body é© signatureï¼
// å¿é æ¾å¨ express.json() middleware ä¹å
// ============================================================
app.post('/api/line/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-line-signature'];
    const rawBody = req.body.toString('utf8');
    if (!line.verifySignature(rawBody, signature)) {
      console.warn('[LINE webhook] signature mismatch');
      return res.status(401).send('invalid signature');
    }
    // åå 200 è® LINE ä¸è¦éè©¦
    res.status(200).send('ok');
    let payload;
    try { payload = JSON.parse(rawBody); } catch (e) { return; }
    for (const event of (payload.events || [])) {
      handleLineEvent(event).catch(err => console.error('[LINE event]', err));
    }
  }
);

app.use(express.json({ limit: "1mb" }));

// ============================================================
// GET / â æ³¨å¥å¨ç«å°è¦½åå° index.html
// ============================================================
app.get('/', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next();
    const navHtml = `<div id="__app_nav" style="position:fixed;top:14px;right:14px;z-index:9999;display:flex;gap:8px;background:rgba(253,247,238,0.98);padding:8px 10px;border-radius:10px;border:1px solid #8E3D4B;box-shadow:0 6px 20px rgba(142,61,75,0.22);font-family:-apple-system,'PingFang TC',sans-serif;">
      <a href="/optimize.html" style="color:#A37849;text-decoration:none;padding:6px 12px;background:rgba(163,120,73,0.14);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(163,120,73,0.55);">â¡ å»£åé«æª¢</a>
      <a href="/competitor.html" style="color:#A37849;text-decoration:none;padding:6px 12px;background:rgba(163,120,73,0.14);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(163,120,73,0.55);">ð¡ ç«¶åè¿½è¹¤</a>
      <a href="/social.html" style="color:#A37849;text-decoration:none;padding:6px 12px;background:rgba(163,120,73,0.14);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(163,120,73,0.55);">ð± FB/IG</a>
      <a href="/customers.html" style="color:#ff9f68;text-decoration:none;padding:6px 12px;background:rgba(255,159,104,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(255,159,104,0.3);">ð¥ å®¢äººç«å</a>
      <a href="/line.html" style="color:#06C755;text-decoration:none;padding:6px 12px;background:rgba(6,199,85,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(6,199,85,0.3);">ð¬ LINE</a>
    </div>`;
    const injected = html.replace('</body>', navHtml + '</body>');
    res.type('html').send(injected);
  });
});


app.use(express.static(path.join(__dirname, "public")));

// Serve LINE uploaded images publicly (LINE CDN ææéå URL)
app.use("/uploads", express.static(LINE_UPLOAD_DIR, { maxAge: "30d" }));

// POST /api/line/upload  ä¸å³åçæªçµ¦ LINE ç¨ï¼multipart/form-data, field: fileï¼
app.post("/api/line/upload", (req, res) => {
  lineUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
    if (!req.file) return res.status(400).json({ error: "no file" });
    const host = `${req.protocol}://${req.get("host")}`;
    const url = `${host}/uploads/${req.file.filename}`;
    res.json({ ok: true, url, filename: req.file.filename, size: req.file.size });
  });
});

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log("[OK] Anthropic client initialized | worker:", MODEL, "| director:", DIRECTOR_MODEL);
} else {
  console.warn("[WARN] ANTHROPIC_API_KEY not set");
}

// ============================================================
// /api/employees
// ============================================================
app.get("/api/employees", (req, res) => {
  const list = Object.values(EMPLOYEES).map(e => ({
    id: e.id,
    name: e.name,
    role: e.role,
    roleEn: e.roleEn,
    emoji: e.emoji,
    bio: e.bio,
    color: e.color,
    isDirector: !!e.isDirector,
    quickTasks: e.quickTasks,
  }));
  res.json(list);
});

app.get("/api/employees/:id/prompt", (req, res) => {
  const emp = EMPLOYEES[req.params.id];
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  res.json({ systemPrompt: emp.systemPrompt });
});

// ============================================================
// SSE helpers
// ============================================================
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// /api/meta/* â Stage 2 read-only Meta integration
// ============================================================
app.get("/api/meta/status", async (req, res) => {
  try {
    const status = await meta.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// /api/meta/assets â ååº user ææ FB Pages / IG Business / Ad Accountsï¼for switcherï¼
app.post("/api/salesmartly/webhook", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const evt = req.body || {};
    // SaleSmartly webhook format: 通常包含 event_type / event / type 等欄位 + 訊息資料
    // 我們關心的是「客人傳訊息」事件
    const evtType = evt.event_type || evt.event || evt.type || '';
    const isInbound = /message|chat|new_message|customer_message/i.test(evtType) ||
                      evt.direction === 'in' || evt.from_type === 'visitor' || evt.sender_type === 'customer';

    let capiResult = null;
    if (isInbound) {
      // Try common field names from SaleSmartly webhook payloads
      const data = evt.data || evt.message || evt;
      const contact = evt.contact || data.contact || data.from || {};
      capiResult = await metaCapi.sendLead({
        contact_id: contact.id || data.chat_user_id || data.user_id || data.contact_id,
        name: contact.name || contact.first_name || data.name,
        email: contact.email,
        phone: contact.phone,
        source_channel: data.channel || data.source_channel || 'salesmartly',
        message_preview: data.content || data.message || data.text,
      });
    }

    res.json({ ok: true, processed: !!isInbound, capi: capiResult });
  } catch (e) {
    console.error('[salesmartly-webhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/salesmartly/debug", async (req, res) => {
  try {
    const r = await salesmartly.probeAll();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/meta/assets", async (req, res) => {
    try {
      const result = await metaOverride.listAssets();
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

// /api/meta/switch â åæç®åä½¿ç¨ä¸­çç²çµ²é /IG/å»£åå¸³æ¶ï¼session-level overrideï¼
let SESSION_OVERRIDE = { pageId: null, igId: null, adAccountId: null };
app.post("/api/meta/switch", express.json(), (req, res) => {
  const { pageId, igId, adAccountId } = req.body || {};
  if (pageId !== undefined) SESSION_OVERRIDE.pageId = pageId || null;
  if (igId !== undefined) SESSION_OVERRIDE.igId = igId || null;
  if (adAccountId !== undefined) SESSION_OVERRIDE.adAccountId = adAccountId || null;
  // Update process.env so meta.js picks up the new IDs for subsequent API calls
  if (SESSION_OVERRIDE.pageId) process.env.META_FB_PAGE_ID = SESSION_OVERRIDE.pageId;
  if (SESSION_OVERRIDE.igId) process.env.META_IG_USER_ID = SESSION_OVERRIDE.igId;
  if (SESSION_OVERRIDE.adAccountId) process.env.META_AD_ACCOUNT_ID = String(SESSION_OVERRIDE.adAccountId).replace(/^act_/, '');
  res.json({ ok: true, current: {
    pageId: process.env.META_FB_PAGE_ID,
    igId: process.env.META_IG_USER_ID,
    adAccountId: process.env.META_AD_ACCOUNT_ID,
    override: SESSION_OVERRIDE,
  } });
});

app.get("/api/meta/fb/posts", async (req, res) => {
  try {
    const posts = await meta.getFbPagePosts({ limit: Number(req.query.limit) || 10 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/ig/media", async (req, res) => {
  try {
    const media = await meta.getIgMedia({ limit: Number(req.query.limit) || 10 });
    res.json(media);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/ads/insights", async (req, res) => {
  try {
    const insights = await meta.getAdsInsights({ datePreset: req.query.preset || "last_7d" });
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/ads/campaigns", async (req, res) => {
  try {
    const camps = await meta.getAdCampaigns({ limit: Number(req.query.limit) || 25 });
    res.json(camps);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ============================================================
// /api/optimize/* â Phase 1: å»£ååèªååªåï¼æè­° â ç¢ºèª â å·è¡ï¼
// ============================================================
const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");
if (!fs.existsSync(ACTIONS_FILE)) fs.writeFileSync(ACTIONS_FILE, "[]", "utf8");

function appendAction(record) {
  try {
    const arr = JSON.parse(fs.readFileSync(ACTIONS_FILE, "utf8"));
    arr.push({ ...record, id: Date.now() + Math.floor(Math.random() * 1000), createdAt: new Date().toISOString() });
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify(arr.slice(-200), null, 2), "utf8");
  } catch (e) {
    console.error("[appendAction]", e);
  }
}

// GET /api/optimize/propose-pauses?preset=last_7d&roas=0.8&ctr=0.5&cpm=250&max=5
app.get("/api/optimize/propose-pauses", async (req, res) => {
  try {
    const preset = req.query.preset || "last_7d";
    const ads = await meta.getAdsWithInsights({ datePreset: preset, limit: 100 });
    const rules = {
      minAgeDays: Number(req.query.minAgeDays) || 3,
      minSpend: Number(req.query.minSpend) || 1000,
      roasThreshold: Number(req.query.roas) || 0.8,
      ctrThreshold: Number(req.query.ctr) || 0.5,
      cpmCeiling: Number(req.query.cpm) || 250,
      maxProposals: Number(req.query.max) || 5,
    };
    const proposals = meta.proposePausesFromAds(ads, rules);
    res.json({
      preset,
      rules,
      totalAdsScanned: ads.length,
      proposalCount: proposals.length,
      proposals,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[propose-pauses]", err);
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// POST /api/optimize/execute-pause  body: {adId, adName, reason, confirmed: true}
app.post("/api/optimize/execute-pause", async (req, res) => {
  const { adId, adName, reason, confirmed } = req.body || {};
  if (!adId) return res.status(400).json({ error: "adId required" });
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });

  try {
    const result = await meta.pauseAd(adId);
    appendAction({
      type: "pause-ad",
      adId,
      adName: adName || null,
      reason: reason || null,
      success: true,
      result,
    });
    res.json({ ok: true, adId, result });
  } catch (err) {
    appendAction({
      type: "pause-ad",
      adId,
      adName: adName || null,
      reason: reason || null,
      success: false,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// GET /api/optimize/actions â æ­·å²ç´é
app.get("/api/optimize/actions", (req, res) => {
  try {
    const arr = JSON.parse(fs.readFileSync(ACTIONS_FILE, "utf8"));
    res.json(arr.slice(-50).reverse());
  } catch (e) {
    res.json([]);
  }
});


// GET /api/optimize/propose-budget-changes?preset=last_7d&high=2.5&low=1.5&inc=20&dec=30&maxBudget=500
app.get("/api/optimize/propose-budget-changes", async (req, res) => {
  try {
    const preset = req.query.preset || "last_7d";
    const adsets = await meta.getAdSetsWithInsights({ datePreset: preset, limit: 100 });
    const rules = {
      minAgeDays: Number(req.query.minAgeDays) || 3,
      minSpend: Number(req.query.minSpend) || 1000,
      roasHighThreshold: Number(req.query.high) || 2.5,
      roasLowThreshold: Number(req.query.low) || 1.5,
      increasePercent: Number(req.query.inc) || 20,
      decreasePercent: Number(req.query.dec) || 30,
      maxDailyBudget: Number(req.query.maxBudget) || 500,
      minDailyBudget: Number(req.query.minBudget) || 100,
      maxProposals: Number(req.query.max) || 10,
    };
    const proposals = meta.proposeBudgetChangesFromAdSets(adsets, rules);
    res.json({
      preset,
      rules,
      totalAdSetsScanned: adsets.length,
      proposalCount: proposals.length,
      proposals,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[propose-budget-changes]", err);
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// POST /api/optimize/execute-budget-change
// body: { adsetId, adsetName, newDailyBudget, oldDailyBudget, action, reason, confirmed:true }
app.post("/api/optimize/execute-budget-change", async (req, res) => {
  const { adsetId, adsetName, newDailyBudget, oldDailyBudget, action, reason, confirmed } = req.body || {};
  if (!adsetId) return res.status(400).json({ error: "adsetId required" });
  if (!Number.isFinite(newDailyBudget) || newDailyBudget < 100) return res.status(400).json({ error: "newDailyBudget must be >= 100" });
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });

  try {
    const result = await meta.updateAdSetBudget(adsetId, newDailyBudget);
    appendAction({
      type: "update-adset-budget",
      adsetId,
      adsetName: adsetName || null,
      oldDailyBudget: oldDailyBudget ?? null,
      newDailyBudget,
      action: action || null,
      reason: reason || null,
      success: true,
      result,
    });
    res.json({ ok: true, adsetId, newDailyBudget, result });
  } catch (err) {
    appendAction({
      type: "update-adset-budget",
      adsetId,
      adsetName: adsetName || null,
      oldDailyBudget: oldDailyBudget ?? null,
      newDailyBudget,
      action: action || null,
      reason: reason || null,
      success: false,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});


// ============================================================
// /api/intel/* â T2: ç«¶åæå ±ï¼Meta Ad Libraryï¼
// ============================================================

// GET /api/intel/competitor-ads?brand=æ³æ&country=TW
app.get("/api/intel/competitor-ads", async (req, res) => {
  try {
    const brand = req.query.brand;
    if (!brand) return res.status(400).json({ error: "brand required" });
    const country = req.query.country || "TW";
    const limit = Number(req.query.limit) || 25;
    const data = await meta.searchAdsLibrary({ searchTerms: brand, country, limit });
    res.json(data);
  } catch (err) {
    console.error("[competitor-ads]", err);
    res.status(500).json({
      error: String(err.message || err),
      graphError: err.graphError || null,
      fallbackUrl: `https://www.facebook.com/ads/library/?ad_type=all&country=${req.query.country || "TW"}&q=${encodeURIComponent(req.query.brand || "")}`,
    });
  }
});

// GET /api/intel/competitor-scan?country=TW â æé è¨­ç«¶ååå®
app.get("/api/intel/competitor-scan", async (req, res) => {
  try {
    const country = req.query.country || "TW";
    const limit = Number(req.query.limit) || 10;
    const data = await meta.scanCompetitors({ country, limit });
    res.json(data);
  } catch (err) {
    console.error("[competitor-scan]", err);
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// GET /api/intel/competitors â è¿åé è¨­ç«¶ååå®
app.get("/api/intel/competitors", (req, res) => {
  res.json(meta.DEFAULT_COMPETITORS);
});


// ============================================================
// /api/social/* â T3: ç¤¾ç¾¤èªåç¼æï¼NOVA å¯« â ä½ ç¢ºèª â ç¼ï¼
// ============================================================
const DRAFTS_FILE = path.join(DATA_DIR, "drafts.json");
if (!fs.existsSync(DRAFTS_FILE)) fs.writeFileSync(DRAFTS_FILE, "[]", "utf8");

function loadDrafts() {
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, "utf8")); } catch(e) { return []; }
}
function saveDrafts(arr) {
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(arr.slice(-100), null, 2), "utf8");
}

// POST /api/social/generate-draft  body: {brief, platform, count}
// ç¨ NOVA ç count ä»½èç¨¿
app.post("/api/social/generate-draft", async (req, res) => {
  const { brief, platform = "FB", count = 3 } = req.body || {};
  if (!brief || brief.trim().length < 5) return res.status(400).json({ error: "brief too short" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const emp = EMPLOYEES["nova"];
  const platformTag = platform === "IG" ? "Instagramï¼ç­ãéç«é¢æãhashtagsï¼" : "Facebookï¼è¼é·ãå¯å¸¶é£çµãæäºæï¼";

  const userPrompt = `è«éå°ä¸é¢ç briefï¼å¯« ${count} åä¸åé¢¨æ ¼ç ${platformTag} è²¼æèç¨¿ã

Briefï¼${brief}

è¦æ±ï¼
- åå³ JSON é£åæ ¼å¼ï¼[{"style":"é¢¨æ ¼å","caption":"å§å®¹"}, ...]
- æ¯åèç¨¿ç style æ¨é¡è¦ä¸åï¼ä¾å¦ï¼ææåãåè½åãå¥½å¥å¿åãæå¢åï¼
- caption è¦ç¬¦å ofz beauty academy åçèªèª¿ï¼ç²¾åãå§æãä¸è¾²å ´æ¨é¡ï¼
- FB è²¼æ 150-300 å­ï¼IG è²¼æ 80-150 å­ + 3-5 å hashtag
- ç´æ¥å JSON é£åï¼ä¸è¦ä»»ä½åå¾ç¶´æ markdown`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = msg.content.map(b => b.text || "").join("").trim();
    // åè©¦æ½å JSON é£å
    let drafts;
    try {
      const m = text.match(/\[[\s\S]*\]/);
      drafts = JSON.parse(m ? m[0] : text);
    } catch(e) {
      return res.status(500).json({ error: "Failed to parse NOVA response as JSON", raw: text.slice(0, 500) });
    }
    // å²å­ draft pack
    const record = {
      id: Date.now() + "_" + Math.floor(Math.random() * 1000),
      createdAt: new Date().toISOString(),
      brief,
      platform,
      drafts: drafts.map((d, i) => ({
        index: i,
        style: d.style || `çæ¬${i+1}`,
        caption: d.caption || "",
      })),
      status: "pending",
    };
    const arr = loadDrafts();
    arr.push(record);
    saveDrafts(arr);
    res.json(record);
  } catch (err) {
    console.error("[generate-draft]", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/social/drafts â ååºèç¨¿
app.get("/api/social/drafts", (req, res) => {
  res.json(loadDrafts().slice(-30).reverse());
});

// POST /api/social/publish  body: {draftId, index, caption, platform, confirmed:true}
// draftId + index æ¯å¾èç¨¿åé¸ä¸åï¼caption æ¯ä½ æçµç·¨è¼¯éççæ¬
app.post("/api/social/publish", async (req, res) => {
  const { draftId, index, caption, platform, imageUrl, link, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  if (!caption || caption.trim().length < 5) return res.status(400).json({ error: "caption too short" });

  try {
    let result;
    if (platform === "IG") {
      if (!imageUrl) return res.status(400).json({ error: "IG post requires imageUrl" });
      result = await meta.publishIgImagePost({ imageUrl, caption });
    } else {
      // FB: å¦ææ imageUrl å°±ç¨ photos endpointï¼å¦åç¨ feed
      if (imageUrl) {
        result = await meta.publishFbPhoto({ imageUrl, message: caption });
      } else {
        result = await meta.publishFbPost({ message: caption, link });
      }
    }

    // æ´æ° draft çæ
    if (draftId) {
      const arr = loadDrafts();
      const rec = arr.find(r => r.id === draftId);
      if (rec) {
        rec.status = "published";
        rec.publishedAt = new Date().toISOString();
        rec.publishedIndex = index ?? null;
        rec.publishedPlatform = platform;
        rec.publishedResult = result;
        saveDrafts(arr);
      }
    }
    // å¯« action log
    appendAction({
      type: "social-publish",
      platform,
      draftId: draftId || null,
      captionPreview: caption.slice(0, 80),
      success: true,
      result,
    });
    res.json({ ok: true, platform, result });
  } catch (err) {
    console.error("[social-publish]", err);
    appendAction({
      type: "social-publish",
      platform,
      draftId: draftId || null,
      captionPreview: caption.slice(0, 80),
      success: false,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});


// ============================================================
// /api/meta/token/* â Token ç®¡ç (T10)
// ============================================================

app.get("/api/meta/token/status", async (req, res) => {
  try {
    const status = await meta.getTokenStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/meta/token/refresh", async (req, res) => {
  try {
    const result = await meta.refreshUserToken();
    // æ´æ°è¨æ¶é«ä¸­ç env (ä¸æ¬¡ API å¼å«å°±æç¨æ° token)
    process.env.META_ACCESS_TOKEN = result.token;
    appendAction({ type: "meta-token-refresh", expiresAt: result.expiresAt });
    res.json({ ok: true, expiresAt: result.expiresAt, expiresIn: result.expiresIn, note: "æ° token å·²æ´æ°å°è¨æ¶é«ãè¦æ°¸ä¹ä¿å­è«æåè¤è£½å° Render env vars ç META_ACCESS_TOKENã" });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/token/pages", async (req, res) => {
  try {
    const pages = await meta.getLongLivedPageToken();
    // ä¸ç´æ¥åå³ token æç¢¼ï¼å®å¨èµ·è¦ï¼
    const masked = pages.map(p => ({ id: p.id, name: p.name, tokenPreview: p.pageToken.slice(0, 20) + "...", tokenFull: p.pageToken }));
    res.json({ ok: true, pages: masked });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Lazy refreshï¼ä¼ºæå¨ååå¾æ¯ 24 å°ææª¢æ¥ä¸æ¬¡ï¼è¥ token å©ä¸å° 10 å¤©èªåå·æ°
(async () => {
  const checkAndRefresh = async () => {
    try {
      if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) return;
      const status = await meta.getTokenStatus();
      if (status.needRefresh && status.daysLeft > 0) {
        const r = await meta.refreshUserToken();
        process.env.META_ACCESS_TOKEN = r.token;
        console.log(`[meta-token] auto-refreshed. expires ${r.expiresAt}`);
        appendAction({ type: "meta-token-auto-refresh", expiresAt: r.expiresAt });
      }
    } catch (e) {
      console.warn("[meta-token] auto-refresh error:", e.message);
    }
  };
  // ååå¾ 30 ç§åæª¢æ¥ä¸æ¬¡ï¼ä¹å¾æ¯ 24 å°æ
  setTimeout(checkAndRefresh, 30 * 1000);
  setInterval(checkAndRefresh, 24 * 3600 * 1000);
})();

// ============================================================
// Tool executor â è· READ tool åä½
// ============================================================
async function executeReadTool(name, input) {
  switch (name) {
    case "get_meta_summary": {
      const preset = input.datePreset || "last_7d";
      return await meta.getAdsInsights({ datePreset: preset });
    }
    case "get_meta_campaigns": {
      const limit = input.limit || 25;
      return await meta.getAdCampaigns({ limit });
    }
    case "get_meta_ads": {
      const preset = input.datePreset || "last_7d";
      const limit = input.limit || 50;
      return (await meta.getAdsWithInsights({ datePreset: preset, limit })).slice(0, limit);
    }
    case "get_meta_adsets": {
      const preset = input.datePreset || "last_7d";
      return (await meta.getAdSetsWithInsights({ datePreset: preset, limit: 50 })).slice(0, 50);
    }
    case "scan_competitors": {
      const country = "TW";
      if (input.brand) return await meta.searchAdsLibrary({ searchTerms: input.brand, country, limit: 20 });
      return await meta.scanCompetitors({ country, limit: 10 });
    }
    case "list_line_messages": {
      const all = (function loadLm() { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "line-messages.json"), "utf8")); } catch(e) { return []; }})();
      const filtered = input.onlyPending ? all.filter(m => !m.replied) : all;
      return filtered.slice(0, input.limit || 30).map(m => ({ id: m.id, userName: m.userName, text: m.text, intent: m.intent, replied: m.replied, timestamp: m.timestamp }));
    }
    case "get_customer_profile": {
      const msgs = customers.loadMessages(DATA_DIR);
      const profs = customers.loadCustomerProfiles(DATA_DIR);
      const list = customers.aggregateCustomers(msgs, profs);
      const c = list.find(x => x.userId === input.userId);
      if (!c) return { error: "customer not found" };
      return { ...c, messages: c.messages.slice(0, 10) };
    }
    case "list_customers_in_segment": {
      const msgs = customers.loadMessages(DATA_DIR);
      const profs = customers.loadCustomerProfiles(DATA_DIR);
      const list = customers.aggregateCustomers(msgs, profs);
      const groups = customers.groupBySegment(list);
      return (groups[input.segment] || []).map(c => ({ userId: c.userId, userName: c.userName, frequency: c.frequency, recencyDays: c.recencyDays, monetary: c.monetary, tags: c.tags }));
    }
    case "get_google_summary": {
      if (!google.tokenOk()) return { error: "Google Ads æªè¨­å®" };
      return await google.getAccountSummary({ dateRange: input.dateRange || "LAST_7_DAYS" });
    }
    case "get_account_health": {
      const out = { timestamp: new Date().toISOString() };
      try { out.meta = await meta.getAdsInsights({ datePreset: "last_7d" }); } catch(e) { out.meta = { error: e.message }; }
      try {
        const msgs = customers.loadMessages(DATA_DIR);
        const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
        const pending = (function() { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "line-messages.json"), "utf8")).filter(m => !m.replied).length; } catch(e){ return 0; }})();
        const groups = customers.groupBySegment(list);
        out.line = { totalCustomers: list.length, pending, vip: groups.vip.length, active: groups.active.length, new: groups.new.length, atrisk: groups.atrisk.length };
      } catch(e) { out.line = { error: e.message }; }
      try {
        if (google.tokenOk()) out.google = await google.getAccountSummary({ dateRange: "LAST_7_DAYS" });
        else out.google = { notConfigured: true };
      } catch(e) { out.google = { error: e.message }; }
      return out;
    }
    default:
      return { error: "unknown tool: " + name };
  }
}

// ============================================================
// /api/chat-agent â æ¯æ´ tool use loopï¼å¡å·¥å¯ä»¥ç¨å·¥å·
// ============================================================
const chatAgentHandler = async (req, res) => {
  const { employeeId, messages } = req.body || {};
  const emp = EMPLOYEES[employeeId];
  if (!emp) return res.status(400).json({ error: "Unknown employee" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages required" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const send = setupSSE(res);
  try {
    const system = await maybeAugmentSystemPrompt(emp);
    const tools = toolDefs.asAnthropicTools(emp.tools || []);
    let msgs = messages.map(m => ({ role: m.role === "ai" ? "assistant" : m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));

    send("status", { text: `ð¥ ${emp.name} æ¶å°ä»»åï¼å¯ç¨å·¥å· ${tools.length} å` });

    let safety = 0;
    while (safety++ < 8) {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 3072,
        system,
        tools,
        messages: msgs,
      });

      const textBlocks = resp.content.filter(b => b.type === "text");
      const toolUses = resp.content.filter(b => b.type === "tool_use");

      // Stream text blocks
      for (const tb of textBlocks) send("delta", { text: tb.text });

      if (toolUses.length === 0 || resp.stop_reason !== "tool_use") {
        send("done", { ok: true, turns: safety });
        return res.end();
      }

      // Process tool uses
      msgs.push({ role: "assistant", content: resp.content });
      const toolResults = [];
      for (const tu of toolUses) {
        if (toolDefs.isWriteTool(tu.name)) {
          // WRITEï¼å­ proposalãéç¥åç«¯ãæ«åå°è©±
          const proposalId = "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
          PROPOSALS.set(proposalId, {
            id: proposalId,
            employeeId,
            toolName: tu.name,
            toolInput: tu.input,
            messages: msgs,
            systemPrompt: system,
            tools,
            toolUseId: tu.id,
            createdAt: Date.now(),
          });
          send("proposal", {
            id: proposalId,
            tool: tu.name,
            description: toolDefs.TOOL_DEFINITIONS[tu.name].description,
            input: tu.input,
          });
          send("delta", { text: `\n\nâ ï¸ **æ³å·è¡ï¼${toolDefs.TOOL_DEFINITIONS[tu.name].description}**\n\n\`\`\`json\n${JSON.stringify(tu.input, null, 2)}\n\`\`\`\n\nProposal ID: \`${proposalId}\`\n\nåèªåæ¨¡å¼ï¼è«æª¢æ¥ä¸æ¹ææ¡ï¼ç¶å¾ POST /api/proposals/${proposalId}/execute ç¢ºèªå·è¡ã` });
          send("done", { ok: true, pending_proposal: true });
          return res.end();
        }
        // READ tool - execute
        send("tool_call", { tool: tu.name, input: tu.input });
          send("delta", { text: `\nð [ä½¿ç¨å·¥å· ${tu.name}]` });
        try {
          const result = await executeReadTool(tu.name, tu.input || {});
          send("tool_result", { tool: tu.name, ok: true });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
        } catch (e) {
          send("tool_result", { tool: tu.name, ok: false, error: String(e.message || e) });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: String(e.message || e) }) });
        }
      }
      msgs.push({ role: "user", content: toolResults });
    }
    send("error", { message: "tool loop exceeded 8 turns" });
    res.end();
  } catch (err) {
    console.error("[/api/chat-agent]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
};

app.post("/api/chat-agent", chatAgentHandler);

// /api/chat â è¥å¡å·¥æ toolsï¼èªåèµ° agent æµç¨
const _originalChatHandler = async (req, res) => {
  const { employeeId, messages } = req.body || {};
  const emp = EMPLOYEES[employeeId];
  if (emp?.tools?.length > 0) return chatAgentHandler(req, res);
  if (!emp) return res.status(400).json({ error: "Unknown employee" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages required" });
  const send = setupSSE(res);
  if (!anthropic) {
    send("status", { text: "ð¡ Demo æ¨¡å¼ï¼æªè¨­å® API Keyï¼" });
    send("delta", { text: `<div class="tldr">â¡ Demo æ¨¡å¼</div><p>è«è¨­å® ANTHROPIC_API_KEY å¾éæ°é¨ç½²</p>` });
    send("done", { ok: true });
    return res.end();
  }
  try {
    send("status", { text: `ð¥ ${emp.name} æ¶å°ä»»å` });
    const liveSystem = await maybeAugmentSystemPrompt(emp);
    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 3072,
      system: liveSystem,
      messages: messages.map(m => ({ role: m.role === "ai" ? "assistant" : m.role, content: typeof m.content === "string" ? m.content : String(m.content) })),
    });
    let full = "";
    stream.on("text", (delta) => { full += delta; send("delta", { text: delta }); });
    stream.on("error", (err) => { send("error", { message: String(err.message || err) }); res.end(); });
    await stream.finalMessage();
    send("done", { ok: true, length: full.length });
    res.end();
  } catch (err) {
    console.error("[/api/chat]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
};

// ============================================================
// /api/proposals/:id/execute â ä½¿ç¨èç¢ºèªå¾çæ­£å·è¡ write åä½
// ============================================================
app.post("/api/proposals/:id/execute", async (req, res) => {
  const p = PROPOSALS.get(req.params.id);
  if (!p) return res.status(404).json({ error: "proposal not found or expired" });
  const { override } = req.body || {};
  const input = override || p.toolInput;

  try {
    let result;
    switch (p.toolName) {
      case "propose_pause_ads":
        result = [];
        for (const adId of (input.adIds || [])) {
          try { await meta.pauseAd(adId); result.push({ adId, ok: true }); }
          catch (e) { result.push({ adId, ok: false, error: String(e.message || e) }); }
        }
        appendAction({ type: "ads-pause", reason: input.reason, count: result.length });
        break;
      case "propose_budget_changes":
        result = [];
        for (const c of (input.changes || [])) {
          try { await meta.updateAdSetBudget(c.adSetId, c.newDaily); result.push({ adSetId: c.adSetId, ok: true }); }
          catch (e) { result.push({ adSetId: c.adSetId, ok: false, error: String(e.message || e) }); }
        }
        appendAction({ type: "budget-change", count: result.length });
        break;
      case "propose_fb_post":
        if (input.imageUrl) result = await meta.publishFbPhoto({ imageUrl: input.imageUrl, message: input.caption });
        else result = await meta.publishFbPost({ message: input.caption, link: input.link });
        appendAction({ type: "fb-post-agent", preview: (input.caption||"").slice(0, 60) });
        break;
      case "propose_ig_post":
        result = await meta.publishIgImagePost({ imageUrl: input.imageUrl, caption: input.caption });
        appendAction({ type: "ig-post-agent", preview: (input.caption||"").slice(0, 60) });
        break;
      case "propose_line_reply": {
        const arr = loadLineMessages();
        const rec = arr.find(r => r.id === input.messageId);
        if (!rec) { result = { error: "message not found" }; break; }
        const msgs = line.buildMessages({ text: input.text, imageUrl: input.imageUrl, linkUrl: input.linkUrl, linkLabel: input.linkLabel });
        const ageMin = (Date.now() - new Date(rec.timestamp).getTime()) / 60000;
        if (ageMin < 30 && rec.replyToken) result = await line.replyMessage(rec.replyToken, msgs);
        else result = await line.pushMessage(rec.userId, msgs);
        rec.replied = true; rec.replyText = input.text; rec.repliedAt = new Date().toISOString();
        saveLineMessages(arr);
        appendAction({ type: "line-reply-agent", preview: input.text.slice(0, 60) });
        break;
      }
      case "propose_segment_push": {
        const list = customers.aggregateCustomers(customers.loadMessages(DATA_DIR), customers.loadCustomerProfiles(DATA_DIR));
        const groups = customers.groupBySegment(list);
        const targets = groups[input.segment] || [];
        const msgs = line.buildMessages({ text: input.text, imageUrl: input.imageUrl, linkUrl: input.linkUrl, linkLabel: input.linkLabel });
        result = [];
        for (const c of targets) {
          try { await line.pushMessage(c.userId, msgs); result.push({ userId: c.userId, ok: true }); }
          catch(e) { result.push({ userId: c.userId, ok: false, error: String(e.message||e) }); }
        }
        appendAction({ type: "segment-push-agent", segment: input.segment, count: targets.length });
        break;
      }
      default:
        return res.status(400).json({ error: "unknown proposal tool: " + p.toolName });
    }
    // ç¹¼çºå°è©± - æ tool çµæå¡åå»è®å¡å·¥ç¸½çµ
    const updatedMsgs = [...p.messages, { role: "user", content: [{ type: "tool_result", tool_use_id: p.toolUseId, content: JSON.stringify(result).slice(0, 4000) }] }];
    const followup = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: p.systemPrompt,
      tools: p.tools,
      messages: updatedMsgs,
    });
    const summary = (followup.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    PROPOSALS.delete(req.params.id);
    res.json({ ok: true, result, summary });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/chat", _originalChatHandler);
// ============================================================
// /api/orchestrate â Marketing Director mode
// ------------------------------------------------------------
// Phase 1: Director plans (returns JSON: {plan, assignments})
// Phase 2: All assigned workers run in PARALLEL
// Phase 3: Director consolidates final deliverable
// ============================================================
app.post("/api/orchestrate", async (req, res) => {
  const { task } = req.body || {};
  if (!task || typeof task !== "string")
    return res.status(400).json({ error: "task required" });

  const send = setupSSE(res);
  const director = EMPLOYEES.victor;
  const workerIds = Object.keys(EMPLOYEES).filter(id => id !== "victor");
  const workers = workerIds.map(id => EMPLOYEES[id]);

  if (!anthropic) {
    send("error", { message: "å°æªè¨­å® ANTHROPIC_API_KEY" });
    return res.end();
  }

  try {
    // âââââââââ Phase 1: Director planning âââââââââ
    send("phase", { phase: "planning", text: `ð ${director.name} æ­£å¨åæä»»åä¸¦è¦ååå·¥â¦` });

    const planningPrompt = `Jeffrey åäº¤ä»ä»¥ä¸ä»»åï¼

ã${task}ã

è«ä½ ä»¥è¡é·ç¸½ç£èº«ä»½ï¼ååç­ç¥æ§æèï¼ç¶å¾æ±ºå®è¦åæ´¾çµ¦åªäºåéæå¡å¹³è¡å·è¡ã

å¯åæ´¾çæå¡ï¼ä½ ä¸è½æ´¾çµ¦èªå·±ï¼ï¼
${workers.map(w => `- ${w.id} Â· ${w.name} Â· ${w.role}ï¼${w.bio}`).join("\n")}

è«ä»¥ JSON æ ¼å¼åè¦ï¼å¤é¢ç¨ \`\`\`json ... \`\`\` åè¦ï¼çµæ§å¦ä¸ï¼
{
  "strategy": "ä½ çç­ç¥æèï¼2â3 å¥ï¼",
  "assignments": [
    { "employeeId": "leon", "task": "è« LEON å·é«è¦åä»éº¼ï¼1â3 å¥ï¼" },
    { "employeeId": "camille", "task": "..." }
  ]
}

ååï¼
- è³å°åæ´¾çµ¦ 3 ä½ãæå¤ 6 ä½æå¡ï¼æ ¹æä»»åè¤éåº¦ï¼
- æ¯ååæ´¾ä»»åè¦å·é«ãå¯å·è¡
- ä¸è¦éè¤ææ´¾ç¸åç¯åçµ¦å¤äºº
- employeeId å¿é ä¾èªä¸é¢çæ¸å®`;

    const planResp = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 1500,
      system: director.systemPrompt,
      messages: [{ role: "user", content: planningPrompt }],
    });
    const planText = planResp.content.map(b => b.text || "").join("");
    const jsonMatch = planText.match(/```json\s*([\s\S]*?)\s*```/) || planText.match(/(\{[\s\S]*\})/);
    let plan;
    try {
      plan = JSON.parse(jsonMatch ? jsonMatch[1] : planText);
    } catch (e) {
      send("error", { message: "ç¸½ç£è¦å JSON è§£æå¤±æ" });
      return res.end();
    }
    if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) {
      send("error", { message: "ç¸½ç£æªç¢çææåæ´¾" });
      return res.end();
    }
    // Filter out invalid assignments
    plan.assignments = plan.assignments.filter(a => EMPLOYEES[a.employeeId] && a.employeeId !== "victor");

    send("plan", {
      strategy: plan.strategy || "",
      assignments: plan.assignments.map(a => ({
        employeeId: a.employeeId,
        employeeName: EMPLOYEES[a.employeeId].name,
        employeeRole: EMPLOYEES[a.employeeId].role,
        emoji: EMPLOYEES[a.employeeId].emoji,
        color: EMPLOYEES[a.employeeId].color,
        task: a.task,
      })),
    });

    // âââââââââ Phase 2: Parallel execution âââââââââ
    send("phase", { phase: "executing", text: `ð ${plan.assignments.length} ä½å°å¡åæéå·¥â¦` });

    const workerOutputs = {};
    const runWorker = async (assignment) => {
      const emp = EMPLOYEES[assignment.employeeId];
      const empId = assignment.employeeId;
      send("worker_start", { employeeId: empId, employeeName: emp.name });
      try {
        const liveSystem = await maybeAugmentSystemPrompt(emp);
        const stream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: 2048,
          system: liveSystem,
          messages: [{
            role: "user",
            content: `è¡é·ç¸½ç£ VICTOR å·²å°ä»¥ä¸ä»»ååæ´¾çµ¦ä½ ï¼\n\nã${assignment.task}ã\n\nèæ¯ï¼Jeffrey åæ¬äº¤ä»çä»»åæ¯ã${task}ãã\nè«èç¦æ¼ä½ è¢«åæ´¾çç¯åï¼ç¢åºå¯ç«å³ä½¿ç¨çå§å®¹ã`
          }],
        });
        let full = "";
        stream.on("text", (delta) => {
          full += delta;
          send("worker_delta", { employeeId: empId, text: delta });
        });
        await stream.finalMessage();
        workerOutputs[empId] = full;
        send("worker_done", { employeeId: empId, length: full.length });
      } catch (err) {
        console.error(`[orchestrate worker ${empId}]`, err);
        workerOutputs[empId] = `<p>â ï¸ ${emp.name} å·è¡å¤±æï¼${err.message}</p>`;
        send("worker_error", { employeeId: empId, message: String(err.message || err) });
      }
    };

    // PARALLEL execution
    await Promise.all(plan.assignments.map(runWorker));

    // âââââââââ Phase 3: Director consolidation âââââââââ
    send("phase", { phase: "consolidating", text: `ð ${director.name} æ­£å¨çµ±æ´å¨åéææâ¦` });

    const consolidationParts = plan.assignments.map(a => {
      const emp = EMPLOYEES[a.employeeId];
      return `### ${emp.name} Â· ${emp.role}\nåæ´¾ä»»åï¼${a.task}\n\nææï¼\n${workerOutputs[a.employeeId] || "(ç¡åæ)"}`;
    }).join("\n\n---\n\n");

    const consolidationPrompt = `ä½ ååå°ä»¥ä¸ä»»ååæ´¾çµ¦å°å¡å¹³è¡å·è¡ï¼

ãJeffrey åå§ä»»åã
${task}

ãä½ çç­ç¥ã
${plan.strategy}

ãåå°å¡ææã
${consolidationParts}

è«ä»¥è¡é·ç¸½ç£èº«ä»½ï¼å°ä»¥ä¸å°å¡æææ´åæä¸ä»½çµ¦ Jeffrey çé«å±¤ç´æ±ºç­å ±åã

**è¼¸åºçµæ§ï¼å´æ ¼æé åºï¼ï¼**

â  <div class="tldr">â¡ TL;DRï½ä¸å¥è©±çµè«</div>

â¡ <h4>ð¯ æ´é«ç­ç¥</h4>
2â3 å¥èªªææ¬æ¬¡è¡åçæ ¸å¿ä¸»è»¸ã

â¢ <h4>ð åå°å¡éé»æè¦</h4>
æ¯ä½å°å¡åªæè¦ 2â3 åæ ¸å¿è¦é»ï¼ä¸è¦éè¤è²¼åæï¼ãç¨ <ul><li> æçã

â£ <div class="action-box">
  <h4>â JEFFREY æ¬é±å¾è¾¦æ¸å®</h4>
  <p style="font-size:13px;opacity:0.85;">ä»¥ä¸æ¯ä½ ãæ¬äººãå¿é è¦ªèªåçäºï¼å°å¡å·²ç¶åçä¸è¦åå¨éï¼ï¼</p>
  <ol class="action-list">
    <li><strong>[DEADLINE]</strong> å·é«è¡åæè¿°ï¼çºä½è¦åãéè¦å¤ä¹ãåå®äº¤çµ¦èª°ï¼</li>
    â¦
  </ol>
</div>
å¾è¾¦é ç® 3â6 åï¼æ¯é å¿é å«æªæ­¢æ¥ï¼ä¾ï¼4/18 åãæ¬é±äºåï¼ï¼ä¸¦æ¨è¨»éè¦å¤ä¹ï¼10 åé/åå¤©/1 å¤©ï¼ã

â¤ <div class="decision-box">
  <h4>ð¤ éè¦ä½ ç¾å¨æ±ºç­çäº</h4>
  <p style="font-size:13px;opacity:0.85;">ä»¥ä¸æ±ºç­å¿é ä½ æ¬äººææ¿ï¼å°å¡ç¡æ³ä»£æ±ºï¼</p>
  <div class="decision">
    <div class="d-title"><strong>æ±ºç­ 1ï¼</strong>ï¼æ±ºç­ä¸»é¡ï¼</div>
    <div class="d-ctx">èæ¯èçµ¡ 1â2 å¥</div>
    <ul class="d-options">
      <li><strong>æ¹æ¡ Aï¼</strong>æè¿°ï½<em>åªé»ï¼â¦</em>ï½<em>ç¼ºé»ï¼â¦</em></li>
      <li><strong>æ¹æ¡ Bï¼</strong>æè¿°ï½<em>åªé»ï¼â¦</em>ï½<em>ç¼ºé»ï¼â¦</em></li>
      <li><strong>æ¹æ¡ Cï¼</strong>æè¿°ï½<em>åªé»ï¼â¦</em>ï½<em>ç¼ºé»ï¼â¦</em></li>
    </ul>
    <div class="d-reco">ð <strong>VICTOR å»ºè­°ï¼</strong>æ¹æ¡ Xï¼å çºâ¦</div>
  </div>
  ï¼1â3 åæ±ºç­ï¼
</div>

â¥ <h4>ð¦ éè¦ä½ æä¾çè³æº</h4>
<ul><li>é ç®ï¼ç´ æï¼ææ¬ï¼å¸³èæ¬éç­ç­ï¼æ¸æ¥ååºï¼æ²æå°±å¯«ãç¡ã</li></ul>

**è¦åï¼**
- å¨ç¨ä½¿ç¨ HTML æçï¼å¯ç¨ <h4>ã<p>ã<ul><li>ã<ol><li>ã<strong>ã<em>ã<table class="data">ãä»¥åä¸è¿° class
- å­æ¸ 900â1500 å­
- å¾è¾¦æ¸å®è£¡çäºå¿é æ¯ Jeffrey æ¬äººå¯å·è¡çï¼ä¾å¦ï¼ç¢ºèªé ç®ãè¯çµ¡ KOLãä¸å³ç´ æãæ¹åææ¡ï¼ï¼çµå°ä¸è¦æå°å¡å·²ç¶åå®çäºåé²å»
- æ±ºç­è«ç¤ºå¿é æä¾å·é«é¸é ï¼ä¸è¦åªåãè¦ä¸è¦åãéç¨®æ¯éé¡`;

    const finalStream = await anthropic.messages.stream({
      model: DIRECTOR_MODEL,
      max_tokens: 3072,
      system: director.systemPrompt,
      messages: [{ role: "user", content: consolidationPrompt }],
    });
    let finalText = "";
    finalStream.on("text", (delta) => {
      finalText += delta;
      send("summary_delta", { text: delta });
    });
    await finalStream.finalMessage();

    send("done", { ok: true, totalWorkers: plan.assignments.length, summaryLength: finalText.length });
    res.end();
  } catch (err) {
    console.error("[/api/orchestrate]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
});

// ============================================================
// Reports & cron
// ============================================================
app.get("/api/reports", (req, res) => {
  const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  res.json(reports.slice(-20).reverse());
});

const CRON_TZ = "Asia/Taipei";
async function runScheduledTask(empId, prompt, label) {
  if (!anthropic) return;
  const emp = EMPLOYEES[empId];
  if (!emp) return;
  console.log(`[cron:${label}] running ${emp.name}â¦`);
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content.map(b => b.text || "").join("");
    const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
    reports.push({
      id: Date.now(),
      createdAt: new Date().toISOString(),
      employeeId: empId,
      employeeName: emp.name,
      label, prompt, output: text,
    });
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), "utf8");
    console.log(`[cron:${label}] â done`);
  } catch (err) {
    console.error(`[cron:${label}]`, err);
  }
}

autoPublish.registerCronJobs(cron);
cron.schedule("0 9 * * 1", () => {
  runScheduledTask("victor",
    "è«ç¢åºæ¬é±çãåéé±ç­ç¥ç°¡å ±ãï¼æ¬é±ä¸»è»¸ãåå°å¡çéé»ä»»åãé ç®åéãé¢¨éªé è­¦ã3 åéè¦ Jeffrey æ±ºç­çåé¡ã",
    "weekly-strategy-brief");
}, { timezone: CRON_TZ });

cron.schedule("0 17 * * 5", () => {
  runScheduledTask("dex",
    "è«ç¢åºæ¬é±å»£åææå ±åãè¥ç¡å¯¦éæ¸æè«ä½¿ç¨æ¨¡æ¬æ¸æä¸¦æ¨è¨»ã",
    "weekly-analytics-report");
}, { timezone: CRON_TZ });

// ============================================================
// ä¸»åæ¨æ­ï¼æ¯æ¥ 09:00 æ©å®ç°¡å ± + æ¯ 30 åéäºä»¶ç£æ§
// ============================================================
cron.schedule("0 9 * * *", async () => {
  console.log("[alerts] running daily briefing...");
  try {
    const result = await alerts.dailyBriefing({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    console.log("[alerts] daily briefing:", result.pushed && result.pushed.ok ? "pushed" : "skipped (" + (result.pushed && result.pushed.reason || result.reason) + ")");
  } catch (err) {
    console.error("[alerts daily]", err);
  }
}, { timezone: CRON_TZ });

cron.schedule("*/30 * * * *", async () => {
  try {
    const result = await alerts.eventMonitor({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    if (result.alerts && result.alerts.length > 0) {
      console.log(`[alerts event] ${result.alerts.length} alerts pushed`);
    }
  } catch (err) {
    console.error("[alerts event]", err);
  }
}, { timezone: CRON_TZ });


// ============================================================
// /api/line/* â LINE å®¢æ + å»£æ­ (T4.5)
// ============================================================
const LINE_MESSAGES_FILE = path.join(DATA_DIR, "line-messages.json");
if (!fs.existsSync(LINE_MESSAGES_FILE)) fs.writeFileSync(LINE_MESSAGES_FILE, "[]", "utf8");

function loadLineMessages() {
  try { return JSON.parse(fs.readFileSync(LINE_MESSAGES_FILE, "utf8")); } catch (e) { return []; }
}
function saveLineMessages(arr) {
  fs.writeFileSync(LINE_MESSAGES_FILE, JSON.stringify(arr.slice(-500), null, 2), "utf8");
}

async function handleLineEvent(event) {
  // ç®ååèçæå­è¨æ¯ï¼åçãè²¼åå¯ä»¥ä¹å¾æ´å
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const userId = event.source && event.source.userId;
  const text = event.message.text;
  const replyToken = event.replyToken;
  const timestamp = new Date(event.timestamp).toISOString();

  let profile = null;
  if (userId) {
    try { profile = await line.getUserProfile(userId); } catch (e) {}
  }

  // åµæ¸¬ admin è¨»åæä»¤ï¼ä½¿ç¨èå¨ LINE Bot å°è©±å³ã/adminãå°±æ userId å­èµ·ä¾
  if (text.trim() === "/admin" || text.trim() === "/adminè¨»å") {
    if (userId) {
      alerts.registerAdminFromLine(DATA_DIR, userId, profile && profile.displayName);
      try {
        await line.replyMessage(replyToken, [{
          type: "text",
          text: `â å·²è¨»åçº adminï¼\n\nä½ ææ¶å°ï¼\nð æ¯æ¥æ©ä¸ 09:00 æ©å®ç°¡å ±\nâ ï¸ å»£å/å®¢æ¶/é ç® å³æè­¦ç¤º\n\nç¬¬ä¸ä»½ç°¡å ±æå¤©æ©ä¸è¦ãåå³ã/admin testãå¯ä»¥é¦¬ä¸è·ä¸ä»½æ¸¬è©¦ç°¡å ±ã`,
        }]);
      } catch (e) {}
    }
    return;
  }

  // admin æåè§¸ç¼æ¸¬è©¦ç°¡å ±
  if (text.trim() === "/admin test" || text.trim() === "/admin æ¸¬è©¦") {
    const adminData = alerts.loadAdmin(DATA_DIR);
    if (!adminData.lineUserId || adminData.lineUserId !== userId) {
      try { await line.replyMessage(replyToken, [{ type: "text", text: "â ï¸ ä½ ä¸æ¯ adminï¼è«åå³ /admin è¨»å" }]); } catch (e) {}
      return;
    }
    try { await line.replyMessage(replyToken, [{ type: "text", text: "ð æ­£å¨è·æ©å®ç°¡å ±ï¼30 ç§å§å³çµ¦ä½ ..." }]); } catch (e) {}
    alerts.dailyBriefing({ anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line }).catch(err => console.error("[alerts test]", err));
    return;
  }

  // åµæ¸¬ admin æ±ºç­åè¦ã1ok / 1no / 1?ã
  const decisionMatch = text.trim().match(/^([1-3])\s*(ok|no|\?)$/i);
  if (decisionMatch && userId) {
    const adminData = alerts.loadAdmin(DATA_DIR);
    if (adminData.lineUserId === userId) {
      const decisionNum = decisionMatch[1];
      const action = decisionMatch[2].toLowerCase();
      const actionLabel = action === "ok" ? "â åæ" : action === "no" ? "â æçµ" : "ð¤ è¦è¨è«";
      try {
        const actionsFile = path.join(DATA_DIR, "actions.json");
        const arr = JSON.parse(fs.readFileSync(actionsFile, "utf8"));
        arr.push({
          id: Date.now(),
          type: "admin-decision",
          decisionNum,
          action,
          actionLabel,
          createdAt: new Date().toISOString(),
        });
        fs.writeFileSync(actionsFile, JSON.stringify(arr.slice(-200), null, 2), "utf8");
      } catch (e) { console.error("[admin-decision log]", e); }
      let replyText;
      if (action === "ok") {
        replyText = `${actionLabel} æ±ºç­ ${decisionNum}\n\nå·²è¨éãVICTOR æå¨ä¸ä¸ä»½ç°¡å ±ç´å¥éåç­æ¡ï¼ç¸éçå·è¡ï¼å»£åèª¿æ´ãææ¡ç¼ä½ãå®¢äººåè¦ï¼è«å° https://beauty-office.onrender.com æ¾å°æå¡å·¥å®æã`;
      } else if (action === "no") {
        replyText = `${actionLabel} æ±ºç­ ${decisionNum}\n\nå·²è¨éçºæçµãVICTOR æå¤©æç¨æ°è§åº¦æ³å°ç­ã`;
      } else {
        replyText = `${actionLabel} æ±ºç­ ${decisionNum}\n\næé https://beauty-office.onrender.com æ¾ VICTOR éå§è¨è«`;
      }
      try { await line.replyMessage(replyToken, [{ type: "text", text: replyText }]); } catch (e) {}
      return;
    }
  }

  // ç¨ Claude åé¡æå + å¯«èç¨¿
  let classification = null;
  let draft = null;
  if (anthropic) {
    try {
      const sysPrompt = `ä½ æ¯ ofz beauty academy çå®¢æå©çã
ææ¶å°å®¢äººç LINE è¨æ¯ï¼è«åå©ä»¶äºä¸¦è¼¸åº JSONï¼
1. æååé¡ï¼price / pickup / storage / gifting / complaint / product / other
2. å»ºè­°çåè¦èç¨¿ï¼ç²¾åèªèª¿ãç´æ¥åå¥ãä¸åå¦ï¼

åçè³è¨ï¼ç¨ä¾åç­ï¼ï¼
- 4 å®¶éåºï¼å°åæ¬åºãæ°åè¥¿é B2ãæ°åä¸­æ¸¯ B2ãæ°ååè¥¿ B2
- æ ¸å¿çç¨ï¼é£ç NT$3,500 / é£é§ç NT$5,500 / é§ç NT$4,500 / é§å NT$4,500
- ä¿å­æéï¼çç¨å¾ 7 å¤©è§å¯æï¼å¸¸æº« 6 å°æ
- ä¸å«é²èåï¼æ¯æ¥ç¾å

è¼¸åºæ ¼å¼ï¼
{"intent": "...", "draft": "..."}

ç´æ¥å JSONï¼ä¸è¦åå¾ç¶´ãä¸è¦ markdownã`;
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 600,
        system: sysPrompt,
        messages: [{ role: "user", content: text }],
      });
      const responseText = msg.content.map(b => b.text || "").join("").trim();
      const m = responseText.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        classification = parsed.intent || null;
        draft = parsed.draft || null;
      }
    } catch (e) {
      console.error("[LINE classify]", e.message);
    }
  }

  const record = {
    id: Date.now() + "_" + Math.floor(Math.random() * 10000),
    timestamp,
    userId,
    userName: (profile && profile.displayName) || null,
    userPic: (profile && profile.pictureUrl) || null,
    text,
    replyToken,
    classification,
    draft,
    replied: false,
    replyText: null,
    repliedAt: null,
  };
  const arr = loadLineMessages();
  arr.push(record);
  saveLineMessages(arr);
}

// GET /api/line/status â æª¢æ¥ token æ¯å¦è¨­å®
app.get("/api/line/status", async (req, res) => {
  res.json({
    tokenSet: line.tokenOk(),
    webhookUrl: `${req.protocol}://${req.get("host")}/api/line/webhook`,
  });
});

// GET /api/line/messages â æè¿ 100 ç­è¨æ¯ï¼ææ°å¨åï¼
app.get("/api/line/messages", (req, res) => {
  const arr = loadLineMessages();
  res.json(arr.slice(-100).reverse());
});

// POST /api/line/reply  body: {id, text, imageUrl?, linkUrl?, linkLabel?, confirmed:true}
app.post("/api/line/reply", async (req, res) => {
  const { id, text, imageUrl, linkUrl, linkLabel, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  const hasContent = (text && text.trim().length > 0) || imageUrl || linkUrl;
  if (!hasContent) return res.status(400).json({ error: "text / imageUrl / linkUrl required" });

  const arr = loadLineMessages();
  const rec = arr.find(r => r.id === id);
  if (!rec) return res.status(404).json({ error: "message not found" });
  if (rec.replied) return res.status(400).json({ error: "already replied" });

  const messages = line.buildMessages({ text, imageUrl, linkUrl, linkLabel });
  if (messages.length === 0) return res.status(400).json({ error: "no messages to send" });

  try {
    const ageMinutes = (Date.now() - new Date(rec.timestamp).getTime()) / 60000;
    let result, method;
    if (ageMinutes < 30 && rec.replyToken) {
      method = "reply";
      result = await line.replyMessage(rec.replyToken, messages);
    } else if (rec.userId) {
      method = "push";
      result = await line.pushMessage(rec.userId, messages);
    } else {
      throw new Error("no userId and replyToken expired");
    }
    rec.replied = true;
    rec.replyText = text || "";
    rec.replyImageUrl = imageUrl || null;
    rec.replyLinkUrl = linkUrl || null;
    rec.replyLinkLabel = linkLabel || null;
    rec.repliedAt = new Date().toISOString();
    rec.replyMethod = method;
    saveLineMessages(arr);
    const preview = (text || "").slice(0, 60) + (imageUrl ? " [+å]" : "") + (linkUrl ? " [+é£çµ]" : "");
    appendAction({ type: "line-reply", method, userName: rec.userName, messagePreview: preview, success: true });
    res.json({ ok: true, method, result });
  } catch (err) {
    appendAction({ type: "line-reply", userName: rec.userName, messagePreview: (text || "").slice(0, 80), success: false, error: String(err.message || err) });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/line/broadcast  body: {text, imageUrl?, linkUrl?, linkLabel?, confirmed:true}
app.post("/api/line/broadcast", async (req, res) => {
  const { text, imageUrl, linkUrl, linkLabel, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  const hasContent = (text && text.trim().length > 0) || imageUrl || linkUrl;
  if (!hasContent) return res.status(400).json({ error: "text / imageUrl / linkUrl required" });

  const messages = line.buildMessages({ text, imageUrl, linkUrl, linkLabel });
  if (messages.length === 0) return res.status(400).json({ error: "no messages to send" });

  try {
    const result = await line.broadcastMessage(messages);
    const preview = (text || "").slice(0, 60) + (imageUrl ? " [+å]" : "") + (linkUrl ? " [+é£çµ]" : "");
    appendAction({ type: "line-broadcast", messagePreview: preview, success: true });
    res.json({ ok: true, result });
  } catch (err) {
    appendAction({ type: "line-broadcast", messagePreview: (text || "").slice(0, 80), success: false, error: String(err.message || err) });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ============================================================
// /api/google/* â Google Ads å ±è¡¨ (T5, read-only)
// ============================================================

app.get("/api/google/status", (req, res) => {
  res.json(google.status());
});

app.get("/api/google/summary", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const data = await google.getAccountSummary({ dateRange });
    res.json({ ok: true, summary: data, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/campaigns", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const campaigns = await google.getCampaigns({ dateRange });
    res.json({ ok: true, campaigns, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/adgroups", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const adGroups = await google.getAdGroups({ dateRange, campaignId: req.query.campaignId });
    res.json({ ok: true, adGroups, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/keywords", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const keywords = await google.getKeywords({ dateRange });
    res.json({ ok: true, keywords, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/search-terms", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const terms = await google.getSearchTerms({ dateRange });
    res.json({ ok: true, terms, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/ads", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const ads = await google.getAds({ dateRange });
    res.json({ ok: true, ads, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/google/analyze", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  if (!google.tokenOk()) return res.status(500).json({ error: "Google Ads æªè¨­å®" });
  const { scope = "campaigns", dateRange = "LAST_7_DAYS", extraContext = "" } = req.body || {};
  try {
    let dataBlock = "";
    if (scope === "campaigns") {
      const campaigns = await google.getCampaigns({ dateRange });
      dataBlock = campaigns.slice(0, 30).map(c => `${c.name} (${c.status}) Â· è±è²» NT$${Math.round(c.cost)} Â· é»æ ${c.clicks} Â· è½æ ${c.conversions.toFixed(1)} Â· ROAS ${c.roas.toFixed(2)}`).join("\n");
    } else if (scope === "keywords") {
      const kws = await google.getKeywords({ dateRange });
      dataBlock = kws.slice(0, 40).map(k => `[${k.matchType}] ${k.keyword} Â· ${k.campaignName}>${k.adGroupName} Â· é»æ${k.clicks} è±è²»NT$${Math.round(k.cost)} è½æ${k.conversions.toFixed(1)} ROAS${k.roas.toFixed(2)}`).join("\n");
    } else if (scope === "search-terms") {
      const terms = await google.getSearchTerms({ dateRange });
      dataBlock = terms.slice(0, 40).map(t => `"${t.term}" Â· ${t.campaignName}>${t.adGroupName} Â· é»æ${t.clicks} è±è²»NT$${Math.round(t.cost)} è½æ${t.conversions.toFixed(1)} ROAS${t.roas.toFixed(2)}`).join("\n");
    }
    if (!dataBlock) return res.json({ ok: true, analysis: "ç®åæ²æä»»ä½è³æå¯ä»¥åæï¼å¸³æ¶å¯è½éæ²éå§ææ¾ï¼ã" });

    const emp = EMPLOYEES["leon"] || EMPLOYEES["victor"];
    const systemPrompt = (emp?.systemPrompt || "ä½ æ¯æ¸ä½å»£åæç¤æã") + "\n\næ¬æ¬¡ä»»åï¼åæä»¥ä¸ Google Ads " + scope + " è³æï¼ç¨ç¹ä¸­åè¦ï¼çµ¦ 3-5 é»å·é«åªåå»ºè­°ãæ¯é»æ¨è¨»åªåé åºï¼é«/ä¸­/ä½ï¼ã";
    const userPrompt = `è³æåéï¼${dateRange}\n\nè³æï¼\n${dataBlock}\n\n${extraContext ? "é¡å¤æå¢ï¼" + extraContext + "\n\n" : ""}è«çµ¦åªåå»ºè­°ã`;
    const msg = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const analysis = (msg.content || []).map(c => c.text || "").join("\n");
    res.json({ ok: true, analysis, scope, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ============================================================
// /api/customers/* â LINE å®¢äººç«å + RFM åç¾¤ (T8)
// ============================================================

// GET /api/customers?refresh=1
app.get("/api/customers", (req, res) => {
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const profiles = customers.loadCustomerProfiles(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, profiles);
    const groups = customers.groupBySegment(list);
    const summary = {
      total: list.length,
      vip: groups.vip.length,
      active: groups.active.length,
      new: groups.new.length,
      atrisk: groups.atrisk.length,
    };
    res.json({ ok: true, summary, groups, segments: customers.SEGMENTS });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/customers/:userId
app.get("/api/customers/:userId", (req, res) => {
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const profiles = customers.loadCustomerProfiles(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, profiles);
    const c = list.find(x => x.userId === req.params.userId);
    if (!c) return res.status(404).json({ error: "customer not found" });
    res.json({ ok: true, customer: c });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/customers/:userId/analyze â AI çæç«å
app.post("/api/customers/:userId/analyze", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
    const c = list.find(x => x.userId === req.params.userId);
    if (!c) return res.status(404).json({ error: "customer not found" });

    const history = c.messages.slice(0, 30).reverse().map(m => `[${m.intent}] ${m.text}${m.replyText ? " â åºåè¦ï¼" + m.replyText.slice(0,60) : ""}`).join("\n");
    const systemPrompt = `ä½ æ¯ ofz beauty academy çå®¢äººåæå¸«ãæ ¹æå®¢äººèåçå®¢æç LINE å°è©±ç´éï¼æ¨æ¸¬å®¢äººç«åä¸¦çµ¦åºå·é«è¡åå»ºè­°ãåçä¸»æç´ç¹¡çç¨ï¼é£ç NT$3,500 / é£é§ç NT$5,500 / é§ç NT$4,500 / é§å NT$4,500ï¼çç¨å¾ 7 å¤©è§å¯æï¼ï¼3 å®¶ååº 12 ä½èå¸«ã

åè¦ JSONï¼
{
  "profile": "ä¸æ®µ 2-3 å¥è©±çå®¢äººç«åï¼æ¨æ¸¬å¹´é½¡ãèº«ä»½ãåæ©ï¼",
  "preferences": ["åå¥½ 1", "åå¥½ 2", "åå¥½ 3"],
  "tags": ["ç­æ¨ç±¤1", "ç­æ¨ç±¤2", "ç­æ¨ç±¤3"],
  "nextContact": "å»ºè­°ä¸æ¬¡è¯çµ¡ææ©èè¨æ¯ä¸»é¡",
  "suggestedMessage": "ä¸æ®µ 50-80 å­å¯ä»¥ç´æ¥ç¼çµ¦éä½å®¢äººç LINE è¨æ¯ï¼ç¹ä¸­ãååãå·é«ï¼"
}

ä¸è¦å ä»»ä½èªªæï¼åªåç´ JSONã`;
    const userPrompt = `å®¢äººåç¨±ï¼${c.userName}\nè¨æ¯æ¸ï¼${c.frequency}\næè¿ä¸æ¬¡å°è©±ï¼${c.recencyDays} å¤©å\næååä½ï¼${JSON.stringify(c.intents)}\nåçµï¼${c.segment}\n\nå°è©±ç´éï¼æå¤ 30 åï¼èâæ°ï¼ï¼\n${history}`;

    const msg = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const raw = (msg.content || []).map(x => x.text || "").join("");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!parsed) return res.status(500).json({ error: "AI åè¦ç¡æ³è§£æ", raw: raw.slice(0,300) });

    // å­ profile
    const profiles = customers.loadCustomerProfiles(DATA_DIR);
    profiles[c.userId] = {
      aiProfile: parsed.profile,
      preferences: parsed.preferences || [],
      tags: parsed.tags || [],
      nextContact: parsed.nextContact,
      suggestedMessage: parsed.suggestedMessage,
      updatedAt: new Date().toISOString(),
    };
    customers.saveCustomerProfiles(DATA_DIR, profiles);
    res.json({ ok: true, profile: profiles[c.userId] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/customers/segment-broadcast
// body: { segment: "vip"|"active"|"new"|"atrisk", brief: "..." } 
// NOVA å¯«çµ¦è©²çµçå®¢è£½å»£æ­èç¨¿
app.post("/api/customers/segment-broadcast", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const { segment = "active", brief = "" } = req.body || {};
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
    const groups = customers.groupBySegment(list);
    const group = groups[segment] || [];
    const segMeta = customers.SEGMENTS[segment];

    const sampleTags = [...new Set(group.slice(0, 20).flatMap(c => c.tags || []))].slice(0, 10);
    const sampleIntents = {};
    group.forEach(c => {
      Object.entries(c.intents || {}).forEach(([k, v]) => { sampleIntents[k] = (sampleIntents[k] || 0) + v; });
    });

    const emp = EMPLOYEES["nova"];
    const systemPrompt = (emp?.systemPrompt || "ä½ æ¯ NOVAï¼ofz beauty academy çç¤¾ç¾¤å°ç·¨ã") + `\n\næ¬æ¬¡ä»»åï¼éå° ${segMeta.label} éçµå®¢äººï¼${group.length} äººï¼ç¹è²ï¼${segMeta.desc}ï¼å¯« 3 å LINE å»£æ­èç¨¿ãæ¯åé¢¨æ ¼ä¸åã`;
    const userPrompt = `å®¢äººçµå¥ï¼${segMeta.label}ï¼${group.length} äººï¼\néçµå®¢äººå¸¸è¦æåï¼${JSON.stringify(sampleIntents)}\nå¸¸è¦æ¨ç±¤ï¼${sampleTags.join("ã") || "ï¼å°æªåæï¼"}\n\næ¬æ¬¡ briefï¼${brief || "ï¼ç¡ç¹å¥ä¸»é¡ï¼è«èªå·±ç¼æ®ï¼"}\n\nè«è¼¸åº JSON é£åï¼3 ååç´ ï¼æ¯åæ¯ { "style": "çæ¬å", "text": "è¨æ¯å§å®¹" }ãåªå JSONã`;

    const msg = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const raw = (msg.content || []).map(x => x.text || "").join("");
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const drafts = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.json({ ok: true, segment, groupSize: group.length, drafts });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/customers/segment-push
// body: { segment, text, imageUrl?, linkUrl?, linkLabel?, confirmed:true }
// å°è©²çµææå®¢äºº pushï¼ä¸æ¯ broadcast çµ¦å¨é¨å¥½åï¼
app.post("/api/customers/segment-push", async (req, res) => {
  const { segment = "active", text, imageUrl, linkUrl, linkLabel, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
    const groups = customers.groupBySegment(list);
    const group = groups[segment] || [];
    if (group.length === 0) return res.status(400).json({ error: "è©²çµæ²æå®¢äºº" });

    const messages = line.buildMessages({ text, imageUrl, linkUrl, linkLabel });
    if (messages.length === 0) return res.status(400).json({ error: "no messages to send" });

    const results = [];
    for (const c of group) {
      try {
        await line.pushMessage(c.userId, messages);
        results.push({ userId: c.userId, ok: true });
      } catch (e) {
        results.push({ userId: c.userId, ok: false, error: String(e.message || e) });
      }
    }
    const success = results.filter(r => r.ok).length;
    appendAction({ type: "segment-push", segment, total: group.length, success, preview: (text || "").slice(0, 60) });
    res.json({ ok: true, segment, total: group.length, success: group.length - success, results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/line/generate-broadcast  body: {brief, count}
// è® NOVA å¯« N åå»£æ­è¶ç¨¿ã
app.post("/api/line/generate-broadcast", async (req, res) => {
  const { brief, count = 3 } = req.body || {};
  if (!brief || brief.trim().length < 5) return res.status(400).json({ error: "brief too short" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const emp = EMPLOYEES["nova"];
  const userPrompt = `éå°ä¸é¢ briefï¼å¯« ${count} å LINE å®æ¹å¸³èå»£æ­è¨æ¯èç¨¿ï¼æ¯åé¢¨æ ¼ä¸åã

Briefï¼${brief}

è¦æ±ï¼
- LINE å»£æ­æç¼ç£å¨é¨å¥½åï¼èªæ°£è¦ªè¿ä½ä¿æç²¾åæ
- æ¯å 120-200 å­
- å¯å  emoji ä½ç¯å¶ï¼1-3 åï¼
- å JSON é£åï¼[{"style":"...","text":"..."}, ...]
- ä¸è¦ markdownï¼ç´æ¥å JSON`;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const responseText = msg.content.map(b => b.text || "").join("").trim();
    const m = responseText.match(/\[[\s\S]*\]/);
    const drafts = JSON.parse(m ? m[0] : responseText);
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});


// ============================================================
// /api/alerts/* â ä¸»åæ¨æ­ API
// ============================================================
app.get("/api/alerts/admin", (req, res) => {
  const a = alerts.loadAdmin(DATA_DIR);
  res.json({ registered: !!a.lineUserId, registeredAt: a.registeredAt, userName: a.userName });
});

app.post("/api/alerts/test-daily", async (req, res) => {
  try {
    const result = await alerts.dailyBriefing({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/alerts/test-event", async (req, res) => {
  try {
    const result = await alerts.eventMonitor({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true, model: MODEL, employees: Object.keys(EMPLOYEES).length }));

app.listen(PORT, () => {
  console.log(`\nð¥ ofz beauty academy Â· Virtual Office v2`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL} | Director: ${DIRECTOR_MODEL}`);
  console.log(`   Employees: ${Object.keys(EMPLOYEES).length}`);
  console.log(`   Cron: VICTOR Mon 09:00 / DEX Fri 17:00 (Asia/Taipei)\n`);
});
