# LINE 官方帳號整合設定指引（T4.5）

系統已經寫好了，你只要完成下面 5 個步驟就能開始用。全部大約 15-20 分鐘。

## Step 1：建立 LINE 官方帳號

1. 開 https://account.line.biz/login
2. 用你的 LINE 帳號登入
3. 點「建立帳號」→ 選免費方案即可開始
4. 帳號名稱建議：`ofz beauty academy` 或 `溫點WarmPlace`

## Step 2：啟用 Messaging API

1. 登入 https://developers.line.biz/console/
2. 建立一個 Provider（例：`ofz beauty academy`）
3. 在 Provider 底下建立 **Messaging API Channel**
4. 填必填資料：
   - Channel name：`溫點 AI 客服` 或你喜歡的
   - Channel description：隨便
   - Category / Subcategory：甜點 / 食品
   - Email：你的 email

## Step 3：取得 2 個關鍵值

進入你剛建的 Channel，在「Basic settings」分頁：

- **Channel secret** → 往下捲找到，點「Show」複製

在「Messaging API」分頁：

- **Channel access token (long-lived)** → 往下捲找到，點「Issue」產生一個 token → 複製

## Step 4：把 2 個值放進 Render

1. 開 https://dashboard.render.com/web/srv-d7ciql7avr4c738tiiu0/env
2. 點 **Edit**
3. 點 **Add variable** 加：
   - `LINE_CHANNEL_ACCESS_TOKEN` = 你剛複製的 token
   - `LINE_CHANNEL_SECRET` = 你剛複製的 secret
4. 點 **Save, rebuild, and deploy**
5. 等 3-5 分鐘 rebuild 完成

**不要貼這兩個值到對話！** 直接在 Render 介面貼就好。

## Step 5：設定 Webhook URL（讓 LINE 把客人訊息推給我們）

回到 LINE Developer Console → 你的 Channel → **Messaging API** 分頁：

1. 找到「Webhook settings」區塊
2. Webhook URL 填：
   ```
   https://beauty-office.onrender.com/api/line/webhook
   ```
3. 點 **Update** → 再點 **Verify**（應該跳 Success；跳 Error 代表 Render 還沒 rebuild 完，等一下再試）
4. **把 Use webhook 切到 ON**

然後在同一頁下方：

- **Auto-reply messages** → 切到 OFF（讓我們的 AI 來回，不用 LINE 預設的罐頭回覆）
- **Greeting messages** → OFF 或保留都行（看你要不要自訂歡迎詞）

## Step 6：加自己為好友測試

1. 同一頁最上面有 QR code
2. 用你自己的 LINE 掃它、加好友
3. 傳一句話測試（例：「6 入禮盒多少錢？」）
4. 開 https://beauty-office.onrender.com/line.html 看訊息有沒有進來 + AI 草稿
5. 在網頁上改草稿、按「送出」→ LINE 那邊會收到你的回覆

---

## 常見問題

**Q: Webhook Verify 失敗**  
A: Render 可能還在 rebuild。等 5 分鐘再試。或到 Render dashboard 看 deploy 狀態。

**Q: 收到訊息但沒有 AI 草稿**  
A: 檢查 Render log 有沒有 `[LINE classify]` 錯誤。通常是 ANTHROPIC_API_KEY 沒設或過期。

**Q: 能不能發圖片/貼圖？**  
A: 目前只支援文字。圖片/影片/貼圖未來可以擴充。

**Q: 廣播有沒有限制？**  
A: LINE 官方帳號免費方案每月 200 則訊息（推播+廣播合計）。廣播 1 則給 100 位好友 = 100 則。超過要升級付費方案。

**Q: 客人加好友會不會有歡迎訊息？**  
A: 目前沒做。你可以在 LINE Developer Console 的 Greeting messages 設一個固定的，或之後我們加「歡迎訊息自動發」功能。
