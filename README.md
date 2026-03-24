# QuantView v12

加密貨幣交易終端 + 策略回測平台

## 版本歷史
- v12 (2026-03-24): Signal Feed 接上 Supabase 持久化、cron 改成可 1 分鐘輪詢、後端可在沒開 app 時追蹤 TP / SL
- v12 (2026-03-23): 新增 ICT Killzone Opt3、Signal Feed、策略狀態顯示、Killzone/Session Liquidity cron、優化 MS+OB / Structural Reversal / SMC Session 邏輯
- v11 (2026-03-10): 新增回測頁面（StochRSI × SNR/FVG 策略、Heatmap 參數掃描、診斷報告）
- v10e (2026-03-09): FVG/SNR 預警掃描、4H RSI 背離通知
- v10 (2026-03-08): SNR+FVG 策略、諧波形態

## 功能
- 即時 K 線圖（Binance）
- 六大策略：MS+OB / PRZ / SMC / ICT Killzone Opt3 / SNR+FVG / 諧波
- Signal Feed：最近訊號會持久化到 Supabase，前後端共用同一份資料
- Strategy State：顯示 WAITING_CONFIRM / WAITING_RETEST / ACTIVE_TRADE / LIVE_SIGNAL
- Telegram 通知：Killzone / Session Liquidity，另外可由後端補送 TP_HIT / SL_HIT 更新
- 回測頁面：參數調整 / Heatmap 掃描 / 診斷報告

## 今日重點更新
- `Signal Feed / Supabase`
  - 訊號會寫入 Supabase，不再只靠 localStorage
  - 外部瀏覽器、桌面捷徑、不同裝置可共用同一份 feed
- `Cron / TP/SL`
  - 可用 cron-job.org 每分鐘打 `/api/cron`
  - 後端每分鐘會檢查資料庫裡 `LIVE_SIGNAL / ACTIVE_TRADE` 的 TP / SL
  - 後端訊號掃描維持 5 分 K 節奏，只在整 5 分鐘做 Killzone / Session Liquidity 篩選，避免 1 分鐘重複洗出同一筆 signal
- `ICT Killzone Opt3`
  - 會以最近完成的 5 分鐘 K 棒為準，不再吃還沒收線的 K 棒
  - Killzone signal 會先寫入資料庫，再決定要不要送 Telegram，減少重複通知

## 目前 TP / SL 判斷
- 前端 app：看到的 symbol 仍會依最新價格即時標記 `TP_HIT / SL_HIT`
- 伺服器端 cron：也會從 Supabase 追蹤 `LIVE_SIGNAL / ACTIVE_TRADE`，即使你沒開 app 也會更新
- 建議部署：cron-job.org 每分鐘打一次 `/api/cron`

## 部署
Vercel + cron-job.org + Supabase
