# Google Ads 整合設定指引（T5）

系統會幫你拉 Google Ads 的 campaign / keyword / search terms 報表，並用 AI 給優化建議。要先完成下面 6 步驟才能用。

⚠️ **時間提示**：第 2 步「申請 Developer Token」要等 Google 審核 1-3 個工作天。建議今天先把申請送出，明後天再回來繼續第 3-5 步。

---

## Step 1：建立 Google Ads Manager (MCC) 帳戶

如果你已經有 MCC 跳到 Step 2。

1. 開 https://ads.google.com/home/tools/manager-accounts/
2. 點「建立經理人帳戶」
3. 填基本資訊：
   - 帳戶名稱：`ofz beauty academy 行銷`
   - 國家：台灣
   - 時區：(GMT+08:00) 台北
   - 貨幣：TWD
4. 把你現有的 Google Ads 帳戶連結到這個 MCC
   - 在 MCC 介面 → 帳戶 → 子帳戶 → 連結現有帳戶
   - 輸入你 Google Ads 的 10 位數帳戶 ID
   - 對方（你自己另一個 Google）會收到邀請信，按接受

## Step 2：申請 Developer Token（這步最重要、要等 1-3 天）

1. 用 MCC 帳戶登入 Google Ads
2. 右上角齒輪 → **API 中心**（或網址直接打 https://ads.google.com/aw/apicenter）
3. 同意 API 條款
4. 看到「開發人員權杖」(Developer Token)，先把它複製起來
5. 但這個 token 一開始是「測試 / Test 等級」——只能用來打測試帳號
6. 在 API 中心點「申請存取權」，填申請表：
   - 公司名：ofz beauty academy
   - 公司網址：你的官網或 FB 粉絲頁
   - 預期 API 用途：自動化拉取 campaign、keyword、search terms 報表給內部行銷團隊分析優化
   - 預期每日 Operations：< 5,000
7. 送出 → 等 Google 審核（1-3 個工作天，會發信通知）
8. 審核通過後 token 自動升級為 **Basic 存取權**（每天 15,000 operations）

現在 token 還是 Test 等級也沒關係，下一步用 Test token 設定一切，等通過後再升 Basic。

## Step 3：建立 OAuth 2.0 Credentials

1. 開 https://console.cloud.google.com/
2. 建一個新專案：ofz beauty academy
3. 左邊選單 → **API 和服務** → **程式庫**
4. 搜尋「Google Ads API」→ 點進去 → 按「啟用」
5. 左邊 → **API 和服務** → **OAuth 同意畫面**
   - 使用者類型：選「外部」
   - 應用程式名稱：ofz beauty academy Office
   - 範圍：點「新增或移除範圍」→ 找 https://www.googleapis.com/auth/adwords 加進去
   - 測試使用者：把你自己的 Google email 加進去
6. 左邊 → **API 和服務** → **憑證** → 「+ 建立憑證」 → **OAuth 用戶端 ID**
   - 應用程式類型：桌面應用程式
   - 名稱：Macaron Office Desktop
   - 建立完會跳出：
     - 用戶端 ID（client_id）→ 複製存起來
     - 用戶端密鑰（client_secret）→ 複製存起來

## Step 4：取得 Refresh Token

用 OAuth 2.0 Playground：

1. 開 https://developers.google.com/oauthplayground/
2. 右上角齒輪 → **OAuth 2.0 configuration**
3. 勾 **Use your own OAuth credentials**
4. 貼上你的 OAuth client ID 和 secret
5. 關閉設定
6. 左邊「Step 1: Select & authorize APIs」
7. 在最下面的「Input your own scopes」貼：
   https://www.googleapis.com/auth/adwords
8. 按 **Authorize APIs**
9. 用你的 Google 帳號登入 → 同意授權
10. 回 Playground → 點 **Exchange authorization code for tokens**
11. 看到 **Refresh token** 那欄 → 複製存起來

⚠️ Refresh token 只會出現一次，沒複製到要重來。

## Step 5：把 5 個值放進 Render

1. 開 https://dashboard.render.com/web/srv-d7ciql7avr4c738tiiu0/env
2. 加 5-6 個環境變數：

   | Key | Value |
   |---|---|
   | GOOGLE_ADS_DEVELOPER_TOKEN | Step 2 拿到的 token |
   | GOOGLE_ADS_CLIENT_ID | Step 3 的用戶端 ID |
   | GOOGLE_ADS_CLIENT_SECRET | Step 3 的用戶端密鑰 |
   | GOOGLE_ADS_REFRESH_TOKEN | Step 4 的 refresh token |
   | GOOGLE_ADS_CUSTOMER_ID | 你要管理的 Google Ads 帳戶 ID（10 位數，不要連字號）|
   | GOOGLE_ADS_LOGIN_CUSTOMER_ID | （可選）MCC 帳戶 ID |

3. 按 **Save, rebuild, and deploy**
4. 等 3-5 分鐘 rebuild

## Step 6：驗證

1. 開 https://beauty-office.onrender.com/google.html
2. 應該看到「📊 已連線」狀態
3. 還沒投廣告 → campaign 列表會是空的，正常
4. 開始投放後 1-3 小時資料就會進來

---

## 常見問題

**Q: Developer Token 還在 Test 等級可以做事嗎？**  
A: Test token 只能打 Google 提供的測試帳號。等審核通過升 Basic 後才能讀真實資料。

**Q: 我帳戶還沒投放，這套有用嗎？**  
A: 暫時看不到績效資料，但帳戶結構（campaign / ad group / keyword）看得到。開始投放當天 1-3 小時內資料就會進來。
