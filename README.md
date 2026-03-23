# QuantView v12

加密貨幣交易終端 + 策略回測平台

## 版本歷史
- v12 (2026-03-23): 新增 ICT Killzone Opt3、Signal Feed、策略狀態顯示、Killzone/Session Liquidity cron、優化 MS+OB / Structural Reversal / SMC Session 邏輯
- v11 (2026-03-10): 新增回測頁面（StochRSI × SNR/FVG 策略、Heatmap 參數掃描、診斷報告）
- v10e (2026-03-09): FVG/SNR 預警掃描、4H RSI 背離通知
- v10 (2026-03-08): SNR+FVG 策略、諧波形態

## 功能
- 即時 K 線圖（Binance）
- 六大策略：MS+OB / PRZ / SMC / ICT Killzone Opt3 / SNR+FVG / 諧波
- Signal Feed：記錄最近訊號，並在前端依最新價格標記 TP / SL
- Strategy State：顯示 WAITING_CONFIRM / WAITING_RETEST / ACTIVE_TRADE / LIVE_SIGNAL
- Telegram 通知：目前保留 Killzone Opt3 與 Session Liquidity 提醒
- 回測頁面：參數調整 / Heatmap 掃描 / 診斷報告

## 今日重點更新
- `ICT Killzone Opt3`
  - 新增 app 版即時訊號策略，沿用我們在 Pine 研究後保留的 `opt3` 邏輯
  - 圖表顯示 Asia Range、NY Opening Range、Sweep、MSS、FVG、Entry/SL/TP
- `Signal Feed`
  - 右側面板新增近期訊號列表
  - 會顯示 strategy、direction、session、setup type、bias、Entry/Stop/Target、R/R
  - 前端會依照最新價格自動標記 `TP_HIT / SL_HIT`
- `Killzone State Machine`
  - app 內的 opt3 已從單純快照判斷改成 `sweep -> confirm -> retest -> active trade`
  - 狀態比對會更接近 TradingView / Pine 那套流程
- `Cron / Telegram`
  - cron 流程簡化，只保留較核心的 `ICT Killzone Opt3` 與 `Session Liquidity`
  - 每次通知如果同輪有完整 trade plan，會附上 Entry / Stop / Target / R/R
  - Session Liquidity 同一個 session range 的高低點只提醒一次，避免連續重複發送
- `Legacy Strategy Fixes`
  - `MS+OB`：改為從最近完成的 4H K 棒往回找有效 OB
  - `Structural Reversal`：等待狀態改回 `NEUTRAL`，避免假方向誤導
  - `SMC Session`：改用 `America/New_York` rolling session 邏輯，不再用寫死 UTC 小時切分

## 目前 TP / SL 判斷
- 前端 app：已可在 Signal Feed 內依最新價格標記 `TP_HIT / SL_HIT`
- 伺服器端 cron：目前還沒有持久化追蹤每一筆 open signal
- 若要讓 Vercel 在你沒開 app 時也能持續追 TP / SL，需要額外接資料庫，將 signal 存成 `OPEN` 並用 cron 定期檢查後更新

## 部署
Vercel + cron-job.org
