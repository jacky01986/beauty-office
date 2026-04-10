# 🥐 MACARON DE LUXE · 虛擬辦公室

一個**真正可以上線**的 AI 虛擬公司，四位 AI 員工全部接真實 Claude API，支援即時串流、自動排程週報，一鍵部署到 Zeabur 之後，任何裝置打開瀏覽器都能使用。

## 四位 AI 員工

| 員工 | 角色 | 職責 |
|---|---|---|
| 🎯 LEON | AI 行銷總監 | 戰略、KPI、預算分配 |
| ✒️ CAMILLE | AI 文案企劃 | IG/FB/EDM/Meta Ads 全部文案 |
| 🎨 ARIA | AI 視覺設計指導 | Midjourney 提示詞與視覺概念 |
| 📊 DEX | AI 數據分析師 | 廣告成效與預算優化 |

## 功能

- 四位 AI 員工，各自有專屬的 System Prompt
- 介面左欄交付任務、中欄即時對話、右欄工作動態
- 回覆以 SSE 即時串流，跟 ChatGPT / Claude 官網的體驗一樣
- 一鍵查看或複製每位員工的 System Prompt
- **自動排程**：週一 09:00 (台北) Leon 自動產出《本週策略簡報》，週五 17:00 Dex 自動產出《週成效報告》
- 排程結果存在 `data/reports.json`，在前端「排程報告」分頁可直接查看
- 響應式排版，手機、平板、筆電都能用

## 本機開發

```bash
# 1. 安裝依賴
npm install

# 2. 設定環境變數
cp .env.example .env
# 然後編輯 .env 填入你的 ANTHROPIC_API_KEY

# 3. 啟動
npm start

# 4. 打開瀏覽器
open http://localhost:3000
```

## 部署到 Zeabur（最快 5 分鐘）

### Step 1 — 準備 Anthropic API Key

1. 打開 <https://console.anthropic.com/>
2. 登入後點左側 **API Keys → Create Key**
3. 複製產生的 key（長得像 `sk-ant-api03-...`），等一下要用

### Step 2 — 把這個資料夾推到 GitHub

```bash
cd macaron-office
git init
git add .
git commit -m "init: macaron de luxe virtual office"
# 到 github.com 開一個新 repo 然後：
git remote add origin https://github.com/你的帳號/macaron-office.git
git branch -M main
git push -u origin main
```

### Step 3 — 在 Zeabur 建立專案

1. 打開 <https://zeabur.com> 並用 GitHub 登入
2. 點 **Create Project → New Service → Deploy from GitHub**
3. 授權後選擇剛剛推上去的 `macaron-office` repo
4. Zeabur 會自動偵測到 `Dockerfile` 並開始建置

### Step 4 — 設定環境變數

在 Zeabur 專案頁面 → **Variables** 新增：

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | 你在 Step 1 拿到的 key |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929`（可省略） |

點 **Redeploy**，服務重啟。

### Step 5 — 綁定網址

1. 在 Zeabur 專案頁面 → **Networking → Generate Domain**
2. Zeabur 會給你一個 `xxx.zeabur.app` 的免費網址
3. 點開網址即可看到你的虛擬辦公室

現在從手機、iPad、筆電、任何裝置都能打開 URL 直接使用 🎉

## 專案結構

```
macaron-office/
├── server.js          # Express 後端 (API + SSE + cron)
├── employees.js       # 四位 AI 員工的 System Prompt
├── package.json
├── Dockerfile         # Zeabur 部署用
├── .env.example
├── public/
│   └── index.html     # 前端單檔介面
└── data/
    └── reports.json   # 排程產出的週報
```

## API 一覽

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/employees` | 取得四位員工清單（不含 prompt） |
| GET | `/api/employees/:id/prompt` | 取得某位員工的 System Prompt |
| POST | `/api/chat` | 對話端點（SSE 串流） |
| GET | `/api/reports` | 取得所有排程產出的報告 |
| GET | `/healthz` | 健康檢查 |

### `/api/chat` Request

```json
{
  "employeeId": "leon",
  "messages": [
    { "role": "user", "content": "請幫我規劃下週三櫃的行銷主軸" }
  ]
}
```

Response：SSE 串流，事件類型包含 `status`、`delta`、`done`、`error`。

## 調整排程時間

打開 `server.js`，找到 `cron.schedule(...)` 的兩行，改 cron 表達式即可。時區已固定為 `Asia/Taipei`。

```js
// 格式：分 時 日 月 週
cron.schedule("0 9 * * 1", ...);   // 週一早上 9 點
cron.schedule("0 17 * * 5", ...);  // 週五下午 5 點
```

## 客製化 AI 員工

想改 System Prompt？打開 `employees.js` 編輯 `systemPrompt` 欄位即可。
想新增第五位員工？在同一個物件裡多加一個 key：

```js
newbie: {
  id: "newbie",
  name: "NEWBIE",
  role: "AI 客服",
  ...
  systemPrompt: `...`,
  quickTasks: [...]
}
```

## 費用估算

- Zeabur 免費方案：每月 $5 免費額度，這個小專案綽綽有餘
- Anthropic API：四位員工每則對話約耗 2–4K token，`claude-sonnet-4-5` 一則大約 NT$0.3–0.6

---

**⚠️ 台南櫃點備註**：台南並沒有 SOGO 百貨。目前 System Prompt 裡寫「台南（新光三越或南紡購物中心，待確認）」。請確認真實櫃位後，到 `employees.js` 更新每位員工 prompt 裡的櫃點資訊。

---

🥐 Enjoy your virtual luxury macaron HQ.
