# Meta App 權限升級指引

## 為什麼需要這一步

目前 Render 上的 `META_ACCESS_TOKEN` 只有「讀取」權限（`ads_read`、`pages_read_engagement` 等），
所以系統可以**看**廣告數據，但不能**操作**。

要讓 Phase 1「自動暫停廣告」生效，token 必須額外加一個權限：

- **`ads_management`** — 暫停 / 恢復 / 改預算 / 改受眾 / 改素材

## 開發模式 (Development) 路徑（最快，2 小時內可上線）

> 這是給你**自己用**的設定。如果之後要給別人用，才需要走 App Review。

### Step 1：前往 Meta for Developers

1. 開 https://developers.facebook.com/apps/
2. 點選你建立 `META_ACCESS_TOKEN` 時用的那個 App（如果忘記是哪個，看 Render env var 值的 prefix）

### Step 2：加入 `ads_management` 權限

1. 左側選單 → **App Roles** 或 **Permissions and Features**
2. 找 `ads_management`
3. 點旁邊 **Get Advanced Access**（在 Development 模式下會直接給你，不用審核）

### Step 3：重新生成 Access Token

**選項 A：用 Graph API Explorer（最快）**
1. 開 https://developers.facebook.com/tools/explorer/
2. 上方 App 下拉選單選你的 App
3. 「User or Page」選 **Get User Access Token**
4. Permissions 勾選：
   - `ads_management`（新加的，必選）
   - `ads_read`（保留）
   - `pages_read_engagement`（保留）
   - `pages_show_list`（保留）
   - `instagram_basic`（保留）
   - `business_management`（保留）
5. 點 **Generate Access Token** → 確認授權
6. 複製產生的 token（**短期 token**，1-2 小時會過期）

### Step 4：把短期 token 換成長期 token（建議做）

短期 token 1-2 小時就過期，要換成 **60 天長效 token**：

把這個 URL 在瀏覽器打開（替換 3 個變數）：

```
https://graph.facebook.com/v21.0/oauth/access_token?
  grant_type=fb_exchange_token
  &client_id=你的_App_ID
  &client_secret=你的_App_Secret
  &fb_exchange_token=剛才複製的短期token
```

回應裡的 `access_token` 就是 60 天長期 token。

> **找 App Secret**：Meta for Developers → 你的 App → Settings → Basic → App Secret（要按 Show，會要求密碼）

### Step 5：更新 Render Env Var

1. 開 https://dashboard.render.com/web/srv-d7ciql7avr4c738tiiu0/env
2. 找到 `META_ACCESS_TOKEN`，點 **Edit**
3. 把舊 token 換成新的 60 天 token
4. 點 **Save, rebuild, and deploy**
5. 等 Render rebuild 完成（約 3-5 分鐘）

### Step 6：驗證權限生效

開 https://beauty-office.onrender.com/optimize.html

如果**掃描廣告**按鈕能跑出建議清單、且按「確認暫停」沒回 `(#200) Permissions error`，就代表權限正確生效。

如果跳 `Permissions error`，回 Step 2 確認 `ads_management` 真的有勾並重新生成 token。

---

## 可選：未來要給別人用 → 走 App Review

如果之後想把這個工具給朋友的品牌用（不只 Jeffrey 自己），需要走 Meta App Review：

1. 在 App Dashboard 點 **App Review** → **Permissions and Features**
2. `ads_management` 點 **Request Advanced Access**
3. 填寫使用案例（用途說明 + 螢幕錄影）
4. 等 Meta 審核（約 2-4 週）

審核重點：
- 拍一段你的工具實際操作的錄影（從登入到暫停廣告）
- 解釋商業用途（馬卡龍品牌行銷自動化）
- 隱私政策頁面（要有對外可看的隱私政策 URL）

---

## 安全提醒

- `ads_management` 權限**很強**，可以動到你的廣告預算
- Phase 1 設計是**半自動 · 先提議後確認**，AI 不會自動執行任何動作
- 所有執行紀錄存在 Render 的 `data/actions.json`（可在 `/api/optimize/actions` 查）
- 如果發現異常操作，立刻到 Render env vars 把 `META_ACCESS_TOKEN` 換一個新的（會立刻失效舊的）
