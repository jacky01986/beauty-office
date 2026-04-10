// ============================================================
// MACARON DE LUXE · Virtual Office Server
// ------------------------------------------------------------
// Express 後端，負責：
//  1. 提供前端靜態檔 (public/)
//  2. POST /api/chat — 串接 Claude API，用 SSE 即時串流回前端
//  3. 每週自動執行的 node-cron 任務（Leon 週一策略簡報、Dex 週五週報）
//  4. 把所有自動產出的週報寫進 data/reports.json
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk").default;
const { EMPLOYEES } = require("./employees");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
const DATA_DIR = path.join(__dirname, "data");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");

// ---------------- 基礎設定 ----------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]", "utf8");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------- Anthropic client ----------------
// 若沒有 API key，server 仍然啟動（可以跑前端 + demo 模式）
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log("[OK] Anthropic client initialized with model:", MODEL);
} else {
  console.warn("[WARN] ANTHROPIC_API_KEY not set — /api/chat will run in demo mode");
}

// ---------------- API: 員工清單 ----------------
app.get("/api/employees", (req, res) => {
  // 只回傳前端需要的欄位，不把 systemPrompt 曝光（可另開 /api/employees/:id/prompt）
  const list = Object.values(EMPLOYEES).map(e => ({
    id: e.id,
    name: e.name,
    role: e.role,
    roleEn: e.roleEn,
    emoji: e.emoji,
    bio: e.bio,
    color: e.color,
    quickTasks: e.quickTasks,
  }));
  res.json(list);
});

app.get("/api/employees/:id/prompt", (req, res) => {
  const emp = EMPLOYEES[req.params.id];
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  res.json({ systemPrompt: emp.systemPrompt });
});

// ---------------- API: 聊天（SSE streaming） ----------------
app.post("/api/chat", async (req, res) => {
  const { employeeId, messages } = req.body || {};
  const emp = EMPLOYEES[employeeId];

  if (!emp) {
    res.status(400).json({ error: "Unknown employee" });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  // 設定 SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // 讓 nginx/zeabur 不要 buffer
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 若沒有設 API key，走 demo 模式回傳一段固定 HTML
  if (!anthropic) {
    send("status", { text: "🟡 Demo 模式（未設定 ANTHROPIC_API_KEY）" });
    const demo = `<div class="tldr">⚡ Demo 模式｜請在 Zeabur 的環境變數設定 ANTHROPIC_API_KEY 後即可連接真實 Claude</div>
<h4>目前狀態</h4>
<p>您剛剛交付的任務是：「<strong>${escapeHtml(messages[messages.length - 1].content)}</strong>」</p>
<p>完整 AI 回覆需要 Anthropic API Key。請到 <strong>console.anthropic.com</strong> 取得 key，然後在 Zeabur 的專案設定裡新增環境變數 <strong>ANTHROPIC_API_KEY</strong>，重新部署後即可正常運作。</p>`;
    // 逐字送出讓前端也能展示 streaming 動畫
    for (let i = 0; i < demo.length; i += 4) {
      send("delta", { text: demo.slice(i, i + 4) });
      await sleep(12);
    }
    send("done", { ok: true });
    res.end();
    return;
  }

  try {
    send("status", { text: `📥 ${emp.name} 收到任務...` });
    await sleep(120);
    send("status", { text: `🧠 ${emp.name} 正在思考...` });

    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      system: emp.systemPrompt,
      messages: messages.map(m => ({
        role: m.role === "ai" ? "assistant" : m.role,
        content: typeof m.content === "string" ? m.content : String(m.content),
      })),
    });

    let fullText = "";
    stream.on("text", (delta) => {
      fullText += delta;
      send("delta", { text: delta });
    });

    stream.on("error", (err) => {
      console.error("[stream error]", err);
      send("error", { message: String(err.message || err) });
      res.end();
    });

    await stream.finalMessage();
    send("done", { ok: true, length: fullText.length });
    res.end();
  } catch (err) {
    console.error("[/api/chat] error:", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
});

// ---------------- API: 排程報告紀錄 ----------------
app.get("/api/reports", (req, res) => {
  const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  res.json(reports.slice(-20).reverse()); // 最新的 20 筆
});

// ---------------- Scheduled tasks (node-cron) ----------------
// 時區統一用 Asia/Taipei
const CRON_TZ = "Asia/Taipei";

async function runScheduledTask(empId, prompt, label) {
  if (!anthropic) {
    console.warn(`[cron:${label}] skipped — no API key`);
    return;
  }
  const emp = EMPLOYEES[empId];
  console.log(`[cron:${label}] running ${emp.name}...`);
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content.map(b => b.text || "").join("");
    const report = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      employeeId: empId,
      employeeName: emp.name,
      label,
      prompt,
      output: text,
    };
    const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
    reports.push(report);
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), "utf8");
    console.log(`[cron:${label}] ✅ done, ${text.length} chars`);
  } catch (err) {
    console.error(`[cron:${label}] error`, err);
  }
}

// 週一 09:00 (台北) — Leon 自動產出週策略簡報
cron.schedule("0 9 * * 1", () => {
  runScheduledTask(
    "leon",
    "請幫我產出下一週的《本週策略簡報》。請遵守 system prompt 裡的五項必備欄位，並特別標註台南櫃點尚未確認的位置風險。",
    "weekly-strategy-brief"
  );
}, { timezone: CRON_TZ });

// 週五 17:00 (台北) — Dex 自動產出週成效報告
cron.schedule("0 17 * * 5", () => {
  runScheduledTask(
    "dex",
    "請產出本週廣告成效報告。由於目前尚未接上真實數據，請用合理的模擬數據作答，並在開頭標註「⚠️ 本次為模擬數據」。",
    "weekly-analytics-report"
  );
}, { timezone: CRON_TZ });

// ---------------- utils ----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------- boot ----------------
app.get("/healthz", (req, res) => res.json({ ok: true, model: MODEL }));

app.listen(PORT, () => {
  console.log(`\n🥐 MACARON DE LUXE · Virtual Office`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Scheduled tasks: Leon Mon 09:00 / Dex Fri 17:00 (Asia/Taipei)\n`);
});
