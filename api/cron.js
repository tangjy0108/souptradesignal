import { fetchKlines, detectRSIDivergence, SCAN_SYMBOLS } from './_strategy.js';
import { sendTelegram } from './_telegram.js';

const recentlySentDivergence = new Set();
const recentlySentLQ         = new Set();
const recentlySentAlert      = new Set(); // FVG/SNR 接近/突破預警

// ── SNR+FVG 核心邏輯（對應 snrFvg.ts）──
function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return 0;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function findPivotHighs(klines, str) {
  const result = [];
  for (let i = str; i < klines.length - str; i++) {
    let ok = true;
    for (let k = i - str; k <= i + str; k++) {
      if (k !== i && klines[k].high >= klines[i].high) { ok = false; break; }
    }
    if (ok) result.push(i);
  }
  return result;
}

function findPivotLows(klines, str) {
  const result = [];
  for (let i = str; i < klines.length - str; i++) {
    let ok = true;
    for (let k = i - str; k <= i + str; k++) {
      if (k !== i && klines[k].low <= klines[i].low) { ok = false; break; }
    }
    if (ok) result.push(i);
  }
  return result;
}

function detectSNRFVG(klines, snrStr = 15, fvgMinPct = 0.05, volThr = 1.1) {
  const n = klines.length;
  if (n < snrStr * 2 + 10) return null;

  const volMA = sma(klines.map(k => k.volume), 20);

  // SNR 區域
  const snrLevels = [];
  for (const pi of findPivotHighs(klines, snrStr)) {
    const bt = Math.max(klines[pi].open, klines[pi].close);
    let bodyEnd = n - 1, bodyActive = true;
    for (let k = pi + 1; k < Math.min(pi + snrStr * 3, n); k++) {
      if (klines[k].high >= bt && klines[k].low <= bt) { bodyEnd = k; bodyActive = false; break; }
    }
    snrLevels.push({ wickY: klines[pi].high, bodyY: bt, isRes: true, startBar: pi, bodyEnd, bodyActive });
  }
  for (const pi of findPivotLows(klines, snrStr)) {
    const bb = Math.min(klines[pi].open, klines[pi].close);
    let bodyEnd = n - 1, bodyActive = true;
    for (let k = pi + 1; k < Math.min(pi + snrStr * 3, n); k++) {
      if (klines[k].high >= bb && klines[k].low <= bb) { bodyEnd = k; bodyActive = false; break; }
    }
    snrLevels.push({ wickY: klines[pi].low, bodyY: bb, isRes: false, startBar: pi, bodyEnd, bodyActive });
  }

  // FVG 缺口
  const fvgZones = [];
  for (let i = 2; i < n; i++) {
    const curr = klines[i], prev2 = klines[i - 2];
    const vol1 = klines[i - 1].volume, vma = volMA[i - 1];
    if (curr.low > prev2.high) {
      const gap = curr.low - prev2.high;
      if (gap > curr.close * fvgMinPct / 100 && vol1 > vma * volThr)
        fvgZones.push({ top: curr.low, bottom: prev2.high, isBull: true, startBar: i });
    }
    if (curr.high < prev2.low) {
      const gap = prev2.low - curr.high;
      if (gap > curr.close * fvgMinPct / 100 && vol1 > vma * volThr)
        fvgZones.push({ top: prev2.low, bottom: curr.high, isBull: false, startBar: i });
    }
  }

  const last = klines[n - 1];
  let inBull = false, inBear = false;

  for (const s of snrLevels) {
    if (!s.bodyY) continue;
    const bHit = last.high >= s.bodyY && last.low <= s.bodyY;
    const bBrk = s.isRes ? last.close > s.bodyY : last.close < s.bodyY;
    if (bHit && !bBrk) { if (s.isRes) inBear = true; else inBull = true; }
  }
  for (const f of fvgZones) {
    const fHit = last.high >= f.bottom && last.low <= f.top;
    const fBrk = f.isBull ? last.close < f.bottom : last.close > f.top;
    if (fHit && !fBrk) { if (f.isBull) inBull = true; else inBear = true; }
  }

  // LQ 訊號：只看最後一根
  const curr2 = klines[n - 1], prev = klines[n - 2];
  const lqBull = inBull && prev.close < prev.open && curr2.close > curr2.open && curr2.low < prev.low;
  const lqBear = inBear && prev.close > prev.open && curr2.close < curr2.open && curr2.high > prev.high;

  if (lqBull) {
    const entry = curr2.close, stop = curr2.low, risk = entry - stop;
    return { direction: 'LONG', entry, stop, target: entry + risk, inBull, inBear, snrCount: snrLevels.length, fvgCount: fvgZones.length };
  }
  if (lqBear) {
    const entry = curr2.close, stop = curr2.high, risk = stop - entry;
    return { direction: 'SHORT', entry, stop, target: entry - risk, inBull, inBear, snrCount: snrLevels.length, fvgCount: fvgZones.length };
  }
  return null;
}

function fmt(price) {
  if (!price) return '0';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

function divLabel(div) {
  if (!div) return '—';
  if (div === 'CONFIRMED_BULL') return '✅ 確立看多';
  if (div === 'CONFIRMED_BEAR') return '✅ 確立看空';
  if (div === 'WARNING_BULL')   return '⚠️ 潛在看多';
  if (div === 'WARNING_BEAR')   return '⚠️ 潛在看空';
  return '—';
}

// FVG/SNR 接近/突破預警掃描
async function runAlertScan() {
  const alerts = [];
  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const klines = await fetchKlines(sym, '15m', 200);
      if (!klines || klines.length < 50) return;
      const n = klines.length;
      const last = klines[n - 1];
      const price = last.close;
      const threshold = 0.01; // 1% 以內算接近

      const { snrLevels, fvgZones } = detectSNRFVGFull(klines);

      // 掃 FVG
      for (const fvg of fvgZones.slice(0, 8)) {
        const label = fvg.isBull ? '多頭 FVG' : '空頭 FVG';
        const emoji = fvg.isBull ? '🔵' : '🟠';
        const brokeThru = fvg.isBull ? last.close < fvg.bottom : last.close > fvg.top;
        const nearEdge  = fvg.isBull
          ? Math.abs(price - fvg.bottom) / price <= threshold
          : Math.abs(price - fvg.top)    / price <= threshold;
        const keyEdge = fvg.isBull ? fmt(fvg.bottom) : fmt(fvg.top);

        if (brokeThru) {
          const key = `${sym}_fvg_broke_${keyEdge}`;
          if (!recentlySentAlert.has(key)) {
            recentlySentAlert.add(key);
            setTimeout(() => recentlySentAlert.delete(key), 4 * 60 * 60 * 1000);
            alerts.push({ sym, type: 'broke', label, emoji, price, low: fvg.bottom, high: fvg.top });
          }
        } else if (nearEdge) {
          const key = `${sym}_fvg_near_${keyEdge}`;
          if (!recentlySentAlert.has(key)) {
            recentlySentAlert.add(key);
            setTimeout(() => recentlySentAlert.delete(key), 4 * 60 * 60 * 1000);
            alerts.push({ sym, type: 'near', label, emoji, price, low: fvg.bottom, high: fvg.top });
          }
        }
      }

      // 掃 SNR
      for (const snr of snrLevels.slice(0, 10)) {
        const label = snr.isRes ? 'SNR 壓力' : 'SNR 支撐';
        const emoji = snr.isRes ? '🔴' : '🟢';
        const level = snr.bodyY || snr.wickY;
        const brokeThru = snr.isRes ? last.close > level : last.close < level;
        const nearLevel = Math.abs(price - level) / price <= threshold;

        if (brokeThru) {
          const key = `${sym}_snr_broke_${fmt(level)}`;
          if (!recentlySentAlert.has(key)) {
            recentlySentAlert.add(key);
            setTimeout(() => recentlySentAlert.delete(key), 4 * 60 * 60 * 1000);
            alerts.push({ sym, type: 'broke', label, emoji, price, level, isRes: snr.isRes });
          }
        } else if (nearLevel) {
          const key = `${sym}_snr_near_${fmt(level)}`;
          if (!recentlySentAlert.has(key)) {
            recentlySentAlert.add(key);
            setTimeout(() => recentlySentAlert.delete(key), 4 * 60 * 60 * 1000);
            alerts.push({ sym, type: 'near', label, emoji, price, level, isRes: snr.isRes });
          }
        }
      }
    } catch (_) {}
  }));
  return alerts;
}

function detectSNRFVGFull(klines, snrStr = 15, fvgMinPct = 0.05, volThr = 1.1) {
  const n = klines.length;
  const volMA = sma(klines.map(k => k.volume), 20);
  const snrLevels = [];
  for (const pi of findPivotHighs(klines, snrStr)) {
    const bt = Math.max(klines[pi].open, klines[pi].close);
    let bodyActive = true;
    for (let k = pi + 1; k < Math.min(pi + snrStr * 3, n); k++) {
      if (klines[k].high >= bt && klines[k].low <= bt) { bodyActive = false; break; }
    }
    snrLevels.push({ wickY: klines[pi].high, bodyY: bt, isRes: true, bodyActive });
  }
  for (const pi of findPivotLows(klines, snrStr)) {
    const bb = Math.min(klines[pi].open, klines[pi].close);
    let bodyActive = true;
    for (let k = pi + 1; k < Math.min(pi + snrStr * 3, n); k++) {
      if (klines[k].high >= bb && klines[k].low <= bb) { bodyActive = false; break; }
    }
    snrLevels.push({ wickY: klines[pi].low, bodyY: bb, isRes: false, bodyActive });
  }
  const fvgZones = [];
  for (let i = 2; i < n; i++) {
    const curr = klines[i], prev2 = klines[i - 2];
    const vol1 = klines[i - 1].volume, vma = volMA[i - 1];
    if (curr.low > prev2.high) {
      const gap = curr.low - prev2.high;
      if (gap > curr.close * fvgMinPct / 100 && vol1 > vma * volThr)
        fvgZones.push({ top: curr.low, bottom: prev2.high, isBull: true });
    }
    if (curr.high < prev2.low) {
      const gap = prev2.low - curr.high;
      if (gap > curr.close * fvgMinPct / 100 && vol1 > vma * volThr)
        fvgZones.push({ top: prev2.low, bottom: curr.high, isBull: false });
    }
  }
  return { snrLevels, fvgZones };
}

// SNR+FVG 掃描
async function runSNRFVGScan() {
  const signals = [];
  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const klines = await fetchKlines(sym, '15m', 200);
      if (!klines || klines.length < 50) return;
      const result = detectSNRFVG(klines);
      if (!result) return;

      const key = `${sym}_${result.direction}`;
      if (recentlySentLQ.has(key)) return;
      recentlySentLQ.add(key);
      setTimeout(() => recentlySentLQ.delete(key), 4 * 60 * 60 * 1000);

      signals.push({ sym, ...result });
    } catch (_) {}
  }));
  return signals;
}

// 4H 背離掃描
async function runDivergenceScan() {
  const alerts = [];
  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const k4h = await fetchKlines(sym, '4h', 100);
      if (!k4h) return;
      const div4h = detectRSIDivergence(k4h);
      if (!div4h) return;

      const dir = div4h.includes('BULL') ? 'BULL' : 'BEAR';
      const key = `${sym}_${dir}`;
      if (recentlySentDivergence.has(key)) return;
      recentlySentDivergence.add(key);
      setTimeout(() => recentlySentDivergence.delete(key), 4 * 60 * 60 * 1000);

      const [k1h, k15m] = await Promise.all([
        fetchKlines(sym, '1h', 100),
        fetchKlines(sym, '15m', 100),
      ]);
      const div1h  = k1h  ? detectRSIDivergence(k1h)  : null;
      const div15m = k15m ? detectRSIDivergence(k15m) : null;
      const price  = k15m ? k15m[k15m.length - 1].close : k4h[k4h.length - 1].close;
      alerts.push({ sym, div4h, div1h, div15m, price });
    } catch (_) {}
  }));
  return alerts;
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }


  const twTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  try {
    // ── 1. SNR+FVG LQ 訊號掃描（每 15 分鐘）──
    const lqSignals = await runSNRFVGScan();
    for (const s of lqSignals) {
      const emoji = s.direction === 'LONG' ? '🟢' : '🔴';
      const msg = [
        `${emoji} <b>${s.sym} LQ 獵取訊號</b>`,
        `方向：<b>${s.direction}</b>`,
        ``,
        `💰 入場：<code>${fmt(s.entry)}</code>`,
        `🛡️ 止損：<code>${fmt(s.stop)}</code>`,
        `🎯 目標(1:1)：<code>${fmt(s.target)}</code>`,
        ``,
        `📌 SNR 區域 ${s.snrCount} 個 | FVG 缺口 ${s.fvgCount} 個`,
        `⏰ ${twTime}`,
      ].join('\n');
      await sendTelegram(msg);
    }

    // ── 2. 4H 背離通知（每 15 分鐘，有才發）──
    const divAlerts = await runDivergenceScan();
    for (const a of divAlerts) {
      const emoji = a.div4h.includes('BULL') ? '📈' : '📉';
      const confirmed = a.div4h.startsWith('CONFIRMED');
      const msg = [
        `${emoji} <b>${a.sym} 4H RSI 背離</b>`,
        confirmed ? `🔴 <b>已確立，注意！</b>` : `⚠️ 潛在背離形成中`,
        ``,
        `4H：${divLabel(a.div4h)}`,
        a.div1h  ? `1H：${divLabel(a.div1h)}`  : '',
        a.div15m ? `15m：${divLabel(a.div15m)}` : '',
        ``,
        `💰 目前價格：<code>${fmt(a.price)}</code>`,
        `⏰ ${twTime}`,
      ].filter(Boolean).join('\n');
      await sendTelegram(msg);
    }

    // ── 3. FVG/SNR 接近/突破預警 ──
    const alertSignals = await runAlertScan();
    for (const a of alertSignals) {
      const typeLabel = a.type === 'broke' ? '已突破' : '正在接近';
      let msg;
      if (a.level !== undefined) {
        // SNR
        msg = [
          `${a.emoji} <b>${a.sym} ${typeLabel} ${a.label}</b>`,
          ``,
          `📍 位置：<code>${fmt(a.level)}</code>`,
          `💰 目前價格：<code>${fmt(a.price)}</code>`,
          `⏰ ${twTime}`,
        ].join('\n');
      } else {
        // FVG
        msg = [
          `${a.emoji} <b>${a.sym} ${typeLabel} ${a.label}</b>`,
          ``,
          `📦 區間：<code>${fmt(a.low)} – ${fmt(a.high)}</code>`,
          `💰 目前價格：<code>${fmt(a.price)}</code>`,
          `⏰ ${twTime}`,
        ].join('\n');
      }
      await sendTelegram(msg);
    }

    res.status(200).json({ ok: true, lq: lqSignals.length, divergence: divAlerts.length, alerts: alertSignals.length });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
}
