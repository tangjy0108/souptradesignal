import { fetchKlines, detectRSIDivergence, SCAN_SYMBOLS } from './_strategy.js';
import { sendTelegram } from './_telegram.js';

const recentlySentDivergence = new Set();
const recentlySentLQ         = new Set();
const recentlySentAlert      = new Set(); // FVG/SNR 接近/突破預警
const recentlySentKillzone   = new Set();
const recentlySentSessionLiquidity = new Set();

function getTimePartsInZone(date, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(map.hour || 0);
  const minute = Number(map.minute || 0);

  return {
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    weekday: weekdayMap[map.weekday] ?? 0,
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

function inSession(minuteOfDay, startMinute, endMinute) {
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function getCronContext(now = new Date()) {
  const et = getTimePartsInZone(now, 'America/New_York');
  const isWeekday = et.weekday >= 1 && et.weekday <= 5;
  const isQuarterHour = now.getUTCMinutes() % 15 === 0;
  const inAsiaSession = inSession(et.minuteOfDay, 20 * 60, 0);
  const inLondonKillzone = isWeekday && inSession(et.minuteOfDay, 2 * 60, 5 * 60);
  const inNyKillzone = isWeekday && inSession(et.minuteOfDay, 8 * 60 + 30, 11 * 60);
  const inNyOpeningRange = isWeekday && inSession(et.minuteOfDay, 9 * 60 + 30, 10 * 60);
  const activeKillzoneSession = inAsiaSession ? 'Asia' : inLondonKillzone ? 'London' : inNyKillzone ? 'New York' : 'Off-Hours';

  return {
    et,
    isWeekday,
    isQuarterHour,
    inAsiaSession,
    inLondonKillzone,
    inNyKillzone,
    inNyOpeningRange,
    activeKillzoneSession,
    afterOpeningRange: inNyKillzone && et.minuteOfDay >= 10 * 60,
  };
}

function calcEMA(values, period) {
  const ema = new Array(values.length).fill(null);
  if (values.length < period) return ema;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcATRFromKlines(klines, period = 14) {
  const trs = klines.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = klines[i - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose)
    );
  });
  const atr = new Array(klines.length).fill(null);
  if (klines.length <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < trs.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function findLatestIndexAtOrBefore(klines, time) {
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].time <= time) return i;
  }
  return -1;
}

function getKillzoneSession(time) {
  const et = getTimePartsInZone(new Date(time), 'America/New_York');
  const isWeekday = et.weekday >= 1 && et.weekday <= 5;
  if (inSession(et.minuteOfDay, 20 * 60, 0)) return 'Asia';
  if (isWeekday && inSession(et.minuteOfDay, 2 * 60, 5 * 60)) return 'London';
  if (isWeekday && inSession(et.minuteOfDay, 8 * 60 + 30, 11 * 60)) return 'New York';
  return 'Off-Hours';
}

function getRollingTargetSession(currentSession) {
  if (currentSession === 'Asia') return 'New York';
  if (currentSession === 'London') return 'Asia';
  if (currentSession === 'New York') return 'London';
  return null;
}

function buildKillzoneRanges(klines) {
  const ranges = [];
  let active = null;

  for (const bar of klines) {
    const session = getKillzoneSession(bar.time);
    if (session === 'Off-Hours') {
      if (active) {
        ranges.push(active);
        active = null;
      }
      continue;
    }

    const et = getTimePartsInZone(new Date(bar.time), 'America/New_York');
    const sessionKey = `${session}_${et.dateKey}`;

    if (!active || active.sessionKey !== sessionKey) {
      if (active) ranges.push(active);
      active = {
        session,
        dateKey: et.dateKey,
        sessionKey,
        startTime: bar.time,
        endTime: bar.time,
        high: bar.high,
        low: bar.low,
      };
    } else {
      active.high = Math.max(active.high, bar.high);
      active.low = Math.min(active.low, bar.low);
      active.endTime = bar.time;
    }
  }

  if (active) ranges.push(active);
  return ranges;
}

async function safeSendTelegram(message, sendErrors, tag) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    const error = 'Telegram env vars not set';
    if (!sendErrors.includes(error)) sendErrors.push(error);
    return false;
  }
  try {
    await sendTelegram(message);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Telegram send failed [${tag}]`, msg);
    sendErrors.push(`[${tag}] ${msg}`);
    return false;
  }
}

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

async function runICTKillzoneOpt3Scan(now = new Date()) {
  const ctx = getCronContext(now);
  if (!ctx.inLondonKillzone && !ctx.inNyKillzone) return [];

  const signals = [];

  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const [k5, k1h, k1d] = await Promise.all([
        fetchKlines(sym, '5m', 320),
        fetchKlines(sym, '1h', 120),
        fetchKlines(sym, '1d', 10),
      ]);

      if (!k5 || !k1h || !k1d || k5.length < 80 || k1h.length < 60 || k1d.length < 2) return;

      const current = k5[k5.length - 1];
      const prev = k5[k5.length - 2];
      const prev2 = k5[k5.length - 3];
      if (!current || !prev || !prev2) return;

      const currentSession = getKillzoneSession(current.time);
      if (currentSession !== 'London' && currentSession !== 'New York') return;

      const et = getTimePartsInZone(new Date(current.time), 'America/New_York');
      const inLondon = currentSession === 'London';
      const inNyWindow = currentSession === 'New York';
      const afterOpeningRange = inNyWindow && et.minuteOfDay >= 10 * 60;

      const atrSeries = calcATRFromKlines(k5, 14);
      const atr = atrSeries[k5.length - 1];
      if (!atr) return;

      const emaFastSeries = calcEMA(k1h.map(bar => bar.close), 20);
      const emaSlowSeries = calcEMA(k1h.map(bar => bar.close), 50);
      const h1Idx = findLatestIndexAtOrBefore(k1h, current.time);
      const d1Idx = findLatestIndexAtOrBefore(k1d, current.time);
      const h1Fast = h1Idx >= 0 ? emaFastSeries[h1Idx] : null;
      const h1Slow = h1Idx >= 0 ? emaSlowSeries[h1Idx] : null;
      const dailyOpen = d1Idx >= 0 ? k1d[d1Idx].open : current.open;

      const bullBias = !!(h1Fast && h1Slow && h1Fast > h1Slow);
      const bearBias = !!(h1Fast && h1Slow && h1Fast < h1Slow);

      let asiaHigh = 0;
      let asiaLow = 0;
      let orHigh = 0;
      let orLow = 0;
      let prevInAsia = false;
      let prevNyWindow = false;

      for (const bar of k5) {
        const barEt = getTimePartsInZone(new Date(bar.time), 'America/New_York');
        const barIsWeekday = barEt.weekday >= 1 && barEt.weekday <= 5;
        const barInAsia = inSession(barEt.minuteOfDay, 20 * 60, 0);
        const barInNyWindow = barIsWeekday && inSession(barEt.minuteOfDay, 8 * 60 + 30, 11 * 60);
        const barInOpeningRange = barIsWeekday && inSession(barEt.minuteOfDay, 9 * 60 + 30, 10 * 60);

        if (barInAsia && !prevInAsia) {
          asiaHigh = bar.high;
          asiaLow = bar.low;
        } else if (barInAsia) {
          asiaHigh = Math.max(asiaHigh, bar.high);
          asiaLow = Math.min(asiaLow, bar.low);
        }

        if (barInNyWindow && !prevNyWindow) {
          orHigh = 0;
          orLow = 0;
        }
        if (barInOpeningRange) {
          orHigh = orHigh === 0 ? bar.high : Math.max(orHigh, bar.high);
          orLow = orLow === 0 ? bar.low : Math.min(orLow, bar.low);
        }

        prevInAsia = barInAsia;
        prevNyWindow = barInNyWindow;
      }

      const currentClose = current.close;
      const bodySize = Math.abs(current.close - current.open);
      const sweepBuffer = atr * 0.10;
      const stopBuffer = atr * 0.20;
      const highs = k5.map(bar => bar.high);
      const lows = k5.map(bar => bar.low);
      const bullMssLevel = Math.max(...highs.slice(Math.max(0, k5.length - 4), k5.length - 1));
      const bearMssLevel = Math.min(...lows.slice(Math.max(0, k5.length - 4), k5.length - 1));
      const bullMss = currentClose > bullMssLevel;
      const bearMss = currentClose < bearMssLevel;
      const bullDisplacement = current.close > current.open && bodySize >= atr * 0.5;
      const bearDisplacement = current.close < current.open && bodySize >= atr * 0.5;
      const bullFvg = current.low > prev2.high;
      const bearFvg = current.high < prev2.low;
      const bullConfirm = bullDisplacement && bullMss;
      const bearConfirm = bearDisplacement && bearMss;
      const recent = k5.slice(-11);

      const londonBullSweeps = inLondon && asiaLow > 0 ? recent.filter(bar => bar.low < asiaLow - sweepBuffer) : [];
      const londonBearSweeps = inLondon && asiaHigh > 0 ? recent.filter(bar => bar.high > asiaHigh + sweepBuffer) : [];
      const nyBullReversalSweeps = afterOpeningRange && orLow > 0 ? recent.filter(bar => bar.low < orLow - sweepBuffer) : [];
      const nyBearReversalSweeps = afterOpeningRange && orHigh > 0 ? recent.filter(bar => bar.high > orHigh + sweepBuffer) : [];

      let signal = null;

      if (inLondon && bullBias && bullConfirm && londonBullSweeps.length > 0) {
        const extreme = Math.min(...londonBullSweeps.map(bar => bar.low));
        const entry = currentClose;
        const stop = extreme - stopBuffer;
        const target = entry + (entry - stop) * 2.0;
        signal = {
          sym,
          direction: 'LONG',
          setupType: 'LONDON_REVERSAL',
          currentSession,
          bias: 'BULLISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'ASIA_LOW',
          sweepLevel: asiaLow,
          sweepExtreme: extreme,
          mssLevel: bullMssLevel,
          fvgLow: bullFvg ? prev2.high : 0,
          fvgHigh: bullFvg ? current.low : 0,
          dailyOpen,
        };
      } else if (inLondon && bearBias && bearConfirm && londonBearSweeps.length > 0) {
        const extreme = Math.max(...londonBearSweeps.map(bar => bar.high));
        const entry = currentClose;
        const stop = extreme + stopBuffer;
        const target = entry - (stop - entry) * 2.0;
        signal = {
          sym,
          direction: 'SHORT',
          setupType: 'LONDON_REVERSAL',
          currentSession,
          bias: 'BEARISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(entry - target) / Math.max(Math.abs(stop - entry), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'ASIA_HIGH',
          sweepLevel: asiaHigh,
          sweepExtreme: extreme,
          mssLevel: bearMssLevel,
          fvgLow: bearFvg ? current.high : 0,
          fvgHigh: bearFvg ? prev2.low : 0,
          dailyOpen,
        };
      } else if (afterOpeningRange && bullBias && bullConfirm && bullFvg && nyBullReversalSweeps.length > 0 && currentClose > orLow) {
        const extreme = Math.min(...nyBullReversalSweeps.map(bar => bar.low));
        const entry = currentClose;
        const stop = extreme - stopBuffer;
        const target = entry + (entry - stop) * 2.0;
        signal = {
          sym,
          direction: 'LONG',
          setupType: 'NY_REVERSAL',
          currentSession,
          bias: 'BULLISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_LOW',
          sweepLevel: orLow,
          sweepExtreme: extreme,
          mssLevel: bullMssLevel,
          fvgLow: prev2.high,
          fvgHigh: current.low,
          dailyOpen,
        };
      } else if (afterOpeningRange && bearBias && bearConfirm && nyBearReversalSweeps.length > 0 && currentClose < orHigh) {
        const extreme = Math.max(...nyBearReversalSweeps.map(bar => bar.high));
        const entry = currentClose;
        const stop = extreme + stopBuffer;
        const target = entry - (stop - entry) * 2.0;
        signal = {
          sym,
          direction: 'SHORT',
          setupType: 'NY_REVERSAL',
          currentSession,
          bias: 'BEARISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(entry - target) / Math.max(Math.abs(stop - entry), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_HIGH',
          sweepLevel: orHigh,
          sweepExtreme: extreme,
          mssLevel: bearMssLevel,
          fvgLow: bearFvg ? current.high : 0,
          fvgHigh: bearFvg ? prev2.low : 0,
          dailyOpen,
        };
      } else if (afterOpeningRange && bullBias && bullConfirm && bullFvg && orHigh > 0 && currentClose > orHigh && prev.close <= orHigh) {
        const entry = currentClose;
        const stop = Math.min(orLow || current.low, prev.low, prev2.low) - stopBuffer;
        const target = entry + (entry - stop) * 2.0;
        signal = {
          sym,
          direction: 'LONG',
          setupType: 'NY_CONTINUATION',
          currentSession,
          bias: 'BULLISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_HIGH',
          sweepLevel: orHigh,
          sweepExtreme: current.high,
          mssLevel: bullMssLevel,
          fvgLow: prev2.high,
          fvgHigh: current.low,
          dailyOpen,
        };
      } else if (afterOpeningRange && bearBias && bearConfirm && orLow > 0 && currentClose < orLow && prev.close >= orLow) {
        const entry = currentClose;
        const stop = Math.max(orHigh || current.high, prev.high, prev2.high) + stopBuffer;
        const target = entry - (stop - entry) * 2.0;
        signal = {
          sym,
          direction: 'SHORT',
          setupType: 'NY_CONTINUATION',
          currentSession,
          bias: 'BEARISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(entry - target) / Math.max(Math.abs(stop - entry), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_LOW',
          sweepLevel: orLow,
          sweepExtreme: current.low,
          mssLevel: bearMssLevel,
          fvgLow: bearFvg ? current.high : 0,
          fvgHigh: bearFvg ? prev2.low : 0,
          dailyOpen,
        };
      }

      if (!signal) return;

      const signalEt = getTimePartsInZone(new Date(current.time), 'America/New_York');
      const signalKey = `${signal.sym}_${signal.setupType}_${signal.direction}_${signalEt.dateKey}_${signal.currentSession}`;
      if (recentlySentKillzone.has(signalKey)) return;

      recentlySentKillzone.add(signalKey);
      setTimeout(() => recentlySentKillzone.delete(signalKey), 6 * 60 * 60 * 1000);
      signals.push(signal);
    } catch (_) {}
  }));

  return signals;
}

async function runSessionLiquidityScan(now = new Date()) {
  const currentSession = getKillzoneSession(now.getTime());
  const targetSession = getRollingTargetSession(currentSession);
  if (!targetSession) return [];

  const alerts = [];

  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const k5 = await fetchKlines(sym, '5m', 420);
      if (!k5 || k5.length < 80) return;

      const current = k5[k5.length - 1];
      const prev = k5[k5.length - 2];
      if (!current || !prev) return;

      const barSession = getKillzoneSession(current.time);
      if (barSession !== currentSession) return;

      const ranges = buildKillzoneRanges(k5);
      const targetRange = [...ranges]
        .reverse()
        .find(range => range.session === targetSession && range.endTime < current.time);

      if (!targetRange) return;

      let event = null;

      if (current.high > targetRange.high && current.close <= targetRange.high && prev.high <= targetRange.high) {
        event = {
          side: 'HIGH',
          type: 'SWEEP_HIGH',
          level: targetRange.high,
          extreme: current.high,
        };
      } else if (current.close > targetRange.high && prev.close <= targetRange.high) {
        event = {
          side: 'HIGH',
          type: 'BREAKOUT_HIGH',
          level: targetRange.high,
          extreme: current.high,
        };
      } else if (current.low < targetRange.low && current.close >= targetRange.low && prev.low >= targetRange.low) {
        event = {
          side: 'LOW',
          type: 'SWEEP_LOW',
          level: targetRange.low,
          extreme: current.low,
        };
      } else if (current.close < targetRange.low && prev.close >= targetRange.low) {
        event = {
          side: 'LOW',
          type: 'BREAKDOWN_LOW',
          level: targetRange.low,
          extreme: current.low,
        };
      }

      if (!event) return;

      const dedupeKey = `${sym}_${targetRange.sessionKey}_${event.side}`;
      if (recentlySentSessionLiquidity.has(dedupeKey)) return;

      recentlySentSessionLiquidity.add(dedupeKey);
      setTimeout(() => recentlySentSessionLiquidity.delete(dedupeKey), 36 * 60 * 60 * 1000);

      alerts.push({
        sym,
        currentSession,
        targetSession: targetRange.session,
        targetSessionKey: targetRange.sessionKey,
        targetHigh: targetRange.high,
        targetLow: targetRange.low,
        price: current.close,
        ...event,
      });
    } catch (_) {}
  }));

  return alerts;
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

  const now = new Date();
  const ctx = getCronContext(now);
  const twTime = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const etTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const sendErrors = [];

  try {
    let lqSignals = [];
    let divAlerts = [];
    let alertSignals = [];
    let killzoneSignals = [];
    let sessionLiquiditySignals = [];

    if (ctx.isQuarterHour) {
      lqSignals = await runSNRFVGScan();
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
        await safeSendTelegram(msg, sendErrors, 'lq');
      }

      divAlerts = await runDivergenceScan();
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
        await safeSendTelegram(msg, sendErrors, 'divergence');
      }

      alertSignals = await runAlertScan();
      for (const a of alertSignals) {
        const typeLabel = a.type === 'broke' ? '已突破' : '正在接近';
        let msg;
        if (a.level !== undefined) {
          msg = [
            `${a.emoji} <b>${a.sym} ${typeLabel} ${a.label}</b>`,
            ``,
            `📍 位置：<code>${fmt(a.level)}</code>`,
            `💰 目前價格：<code>${fmt(a.price)}</code>`,
            `⏰ ${twTime}`,
          ].join('\n');
        } else {
          msg = [
            `${a.emoji} <b>${a.sym} ${typeLabel} ${a.label}</b>`,
            ``,
            `📦 區間：<code>${fmt(a.low)} – ${fmt(a.high)}</code>`,
            `💰 目前價格：<code>${fmt(a.price)}</code>`,
            `⏰ ${twTime}`,
          ].join('\n');
        }
        await safeSendTelegram(msg, sendErrors, 'alert');
      }
    }

    if (ctx.inLondonKillzone || ctx.inNyKillzone) {
      killzoneSignals = await runICTKillzoneOpt3Scan(now);
      for (const s of killzoneSignals) {
        const emoji = s.direction === 'LONG' ? '🟢' : '🔴';
        const fvgText = s.fvgLow > 0 && s.fvgHigh > 0
          ? `📦 FVG：<code>${fmt(s.fvgLow)} – ${fmt(s.fvgHigh)}</code>`
          : `📦 FVG：<code>無</code>`;
        const msg = [
          `${emoji} <b>${s.sym} ICT Killzone Opt3</b>`,
          `Session：<b>${s.currentSession}</b> | Setup：<b>${s.setupType}</b>`,
          `Bias：<b>${s.bias}</b>`,
          ``,
          `💰 現價：<code>${fmt(s.price)}</code>`,
          `📍 Entry：<code>${fmt(s.entry)}</code>`,
          `🛡️ Stop：<code>${fmt(s.stop)}</code>`,
          `🎯 Target：<code>${fmt(s.target)}</code>`,
          `⚖️ R/R：<code>${s.rr.toFixed(2)}</code>`,
          ``,
          `🌏 Asia：<code>${fmt(s.asiaLow)} – ${fmt(s.asiaHigh)}</code>`,
          s.orHigh > 0 && s.orLow > 0 ? `🗽 OR：<code>${fmt(s.orLow)} – ${fmt(s.orHigh)}</code>` : '',
          `🪤 Sweep：<code>${s.sweepSide}</code> @ <code>${fmt(s.sweepLevel)}</code>`,
          `📉 MSS：<code>${fmt(s.mssLevel)}</code>`,
          fvgText,
          `⏰ TW ${twTime}`,
          `⏰ ET ${etTime}`,
        ].filter(Boolean).join('\n');
        await safeSendTelegram(msg, sendErrors, 'killzone');
      }
    }

    if (ctx.activeKillzoneSession !== 'Off-Hours') {
      sessionLiquiditySignals = await runSessionLiquidityScan(now);
      for (const s of sessionLiquiditySignals) {
        const isBullishEvent = s.type === 'BREAKOUT_HIGH' || s.type === 'SWEEP_LOW';
        const emoji = isBullishEvent ? '🟢' : '🔴';
        const eventLabel =
          s.type === 'BREAKOUT_HIGH' ? '突破前高' :
          s.type === 'BREAKDOWN_LOW' ? '跌破前低' :
          s.type === 'SWEEP_HIGH' ? '掃前高後收回' :
          '掃前低後收回';
        const msg = [
          `${emoji} <b>${s.sym} Session Liquidity</b>`,
          `當前時段：<b>${s.currentSession}</b> | 目標：<b>${s.targetSession}</b>`,
          `事件：<b>${eventLabel}</b>`,
          ``,
          `📍 ${s.targetSession} High：<code>${fmt(s.targetHigh)}</code>`,
          `📍 ${s.targetSession} Low：<code>${fmt(s.targetLow)}</code>`,
          `🎯 觸發位：<code>${fmt(s.level)}</code>`,
          `🪤 Extreme：<code>${fmt(s.extreme)}</code>`,
          `💰 現價：<code>${fmt(s.price)}</code>`,
          ``,
          `🔁 同一個 ${s.targetSession} 區間的 ${s.side} 只提醒一次`,
          `⏰ TW ${twTime}`,
          `⏰ ET ${etTime}`,
        ].join('\n');
        await safeSendTelegram(msg, sendErrors, 'session_liquidity');
      }
    }

    res.status(200).json({
      ok: sendErrors.length === 0,
      nowTw: twTime,
      nowEt: etTime,
      windows: {
        isQuarterHour: ctx.isQuarterHour,
        inAsiaSession: ctx.inAsiaSession,
        inLondonKillzone: ctx.inLondonKillzone,
        inNyKillzone: ctx.inNyKillzone,
        inNyOpeningRange: ctx.inNyOpeningRange,
        activeKillzoneSession: ctx.activeKillzoneSession,
      },
      ran: {
        lq: ctx.isQuarterHour,
        divergence: ctx.isQuarterHour,
        alerts: ctx.isQuarterHour,
        killzone: ctx.inLondonKillzone || ctx.inNyKillzone,
        sessionLiquidity: ctx.activeKillzoneSession !== 'Off-Hours',
      },
      counts: {
        lq: lqSignals.length,
        divergence: divAlerts.length,
        alerts: alertSignals.length,
        killzone: killzoneSignals.length,
        sessionLiquidity: sessionLiquiditySignals.length,
      },
      sendErrors,
    });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
}
