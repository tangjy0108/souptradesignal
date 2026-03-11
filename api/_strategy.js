async function fetchFutures(symbol, interval, limit = 200) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!res.ok) return null;
    return (await res.json()).map(d => ({ time: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5]) }));
  } catch (_) { return null; }
}

async function fetchSpot(symbol, interval, limit = 200) {
  for (const base of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const res = await fetch(`${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (res.ok) return (await res.json()).map(d => ({ time: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5]) }));
    } catch (_) {}
  }
  return null;
}

export async function fetchKlines(symbol, interval, limit = 200) {
  return (await fetchFutures(symbol, interval, limit)) ?? (await fetchSpot(symbol, interval, limit));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = new Array(data.length).fill(null);
  if (data.length < period) return ema;
  ema[period - 1] = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function calcATR(highs, lows, closes, period = 14) {
  const tr = closes.map((_, i) => i === 0 ? highs[i] - lows[i] : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  const atr = new Array(closes.length).fill(null);
  atr[period] = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  for (let i = period + 1; i < closes.length; i++) atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period;
  return atr;
}

// ── Strategy 1: Market Structure + OB ──
function detectMarketStructure(klines) {
  const n = 5;
  const swingHighs = [], swingLows = [];
  for (let i = n; i < klines.length - n; i++) {
    const win = klines.slice(i - n, i + n + 1);
    if (klines[i].high === Math.max(...win.map(k => k.high))) swingHighs.push(klines[i].high);
    if (klines[i].low  === Math.min(...win.map(k => k.low)))  swingLows.push(klines[i].low);
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return { structure: 'RANGING', lastSwingHigh: 0, lastSwingLow: 0 };
  const lastH = swingHighs[swingHighs.length - 1], prevH = swingHighs[swingHighs.length - 2];
  const lastL = swingLows[swingLows.length - 1],  prevL = swingLows[swingLows.length - 2];
  if (lastH > prevH && lastL > prevL) return { structure: 'BULLISH', lastSwingHigh: lastH, lastSwingLow: lastL };
  if (lastH < prevH && lastL < prevL) return { structure: 'BEARISH', lastSwingHigh: lastH, lastSwingLow: lastL };
  return { structure: 'RANGING', lastSwingHigh: lastH, lastSwingLow: lastL };
}

function findOB(klines, type, fromIdx) {
  for (let i = fromIdx; i >= Math.max(0, fromIdx - 30); i--) {
    const k = klines[i];
    const body = Math.abs(k.close - k.open), range = k.high - k.low;
    if (range === 0 || body / range < 0.4) continue;
    if (type === 'BULLISH' && k.close < k.open) return { low: k.low, high: k.high };
    if (type === 'BEARISH' && k.close > k.open) return { low: k.low, high: k.high };
  }
  return null;
}

async function runMSOB(symbol) {
  const [k4h, k15m] = await Promise.all([fetchKlines(symbol, '4h', 300), fetchKlines(symbol, '15m', 200)]);
  if (!k4h || !k15m || k4h.length < 50) return null;
  const ms = detectMarketStructure(k4h);
  if (ms.structure === 'RANGING') return null;
  const isBull = ms.structure === 'BULLISH';
  const ob = findOB(k4h, isBull ? 'BULLISH' : 'BEARISH', k4h.length - 10);
  if (!ob) return null;
  const price = k15m[k15m.length - 1].close;
  const obMid = (ob.low + ob.high) / 2;
  const inOB = price >= ob.low - obMid * 0.005 && price <= ob.high + obMid * 0.005;
  if (!inOB) return null;
  const atr = calcATR(k15m.map(k => k.high), k15m.map(k => k.low), k15m.map(k => k.close), 14).pop() || 0;
  const entry_low = ob.low, entry_high = ob.high;
  const stop   = isBull ? ob.low - atr * 0.5 : ob.high + atr * 0.5;
  const target = isBull ? ms.lastSwingHigh : ms.lastSwingLow;
  const worst  = isBull ? entry_high : entry_low;
  const rr = Math.abs(target - worst) / Math.abs(worst - stop);
  if (rr < 1.5) return null;
  return { symbol, strategy: 'Market Structure + OB', price, direction: isBull ? 'LONG' : 'SHORT', regime: `MS_OB_${ms.structure}`, entry_low, entry_high, stop, target, rr };
}

// ── Strategy 2: Structural Reversal PRZ ──
async function runPRZ(symbol) {
  const k1h = await fetchKlines(symbol, '1h', 300);
  if (!k1h || k1h.length < 100) return null;
  const n = 5;
  const swingHighs = [], swingLows = [];
  for (let i = n; i < k1h.length - n; i++) {
    const win = k1h.slice(i - n, i + n + 1);
    if (k1h[i].high === Math.max(...win.map(k => k.high))) swingHighs.push(k1h[i].high);
    if (k1h[i].low  === Math.min(...win.map(k => k.low)))  swingLows.push(k1h[i].low);
  }
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  const price = k1h[k1h.length - 1].close;
  const lastH = swingHighs[swingHighs.length - 1], prevH = swingHighs[swingHighs.length - 2];
  const lastL = swingLows[swingLows.length - 1],   prevL = swingLows[swingLows.length - 2];
  const dir = lastH > prevH && lastL > prevL ? 'UP' : lastH < prevH && lastL < prevL ? 'DOWN' : null;
  if (!dir) return null;
  const diff = Math.abs(dir === 'UP' ? lastH - lastL : lastL - lastH);
  const prz_low  = dir === 'UP' ? lastH - diff * 0.786 : lastL + diff * 0.618;
  const prz_high = dir === 'UP' ? lastH - diff * 0.618 : lastL + diff * 0.786;
  const inPRZ = price >= prz_low * 0.998 && price <= prz_high * 1.002;
  if (!inPRZ) return null;
  const stop  = dir === 'UP' ? lastL  : lastH;
  const target = dir === 'UP' ? lastH : lastL;
  const worst = dir === 'UP' ? prz_high : prz_low;
  const rr = Math.abs(target - worst) / Math.abs(worst - stop);
  if (rr < 1.5) return null;
  return { symbol, strategy: 'Structural Reversal (PRZ)', price, direction: dir === 'UP' ? 'LONG' : 'SHORT', regime: 'PRZ_SIGNAL', entry_low: prz_low, entry_high: prz_high, stop, target, rr };
}

// ── Strategy 3: SMC Session ──
function getSessionInfo(date) {
  const h = date.getUTCHours();
  if (h >= 13 && h < 22) return { current: 'New York', target: 'London' };
  if (h >= 7  && h < 13) return { current: 'London',   target: 'Asia'   };
  return { current: 'Asia', target: 'New York' };
}

function getSessionHL(klines, session, date) {
  const hours = { London: [7,16], Asia: [0,8], 'New York': [13,22] };
  const [start, end] = hours[session] || [0, 8];
  const td = new Date(date);
  if (session === 'New York' && date.getUTCHours() < 13) td.setUTCDate(td.getUTCDate() - 1);
  const filtered = klines.filter(k => {
    const d = new Date(k.time);
    return d.getUTCFullYear() === td.getUTCFullYear() && d.getUTCMonth() === td.getUTCMonth() &&
           d.getUTCDate() === td.getUTCDate() && d.getUTCHours() >= start && d.getUTCHours() < end;
  });
  if (!filtered.length) return null;
  return { high: Math.max(...filtered.map(k => k.high)), low: Math.min(...filtered.map(k => k.low)) };
}

async function runSMC(symbol) {
  const klines = await fetchKlines(symbol, '15m', 500);
  if (!klines || klines.length < 50) return null;
  const now = new Date();
  const { target: sessionTarget } = getSessionInfo(now);
  const hl = getSessionHL(klines, sessionTarget, now);
  if (!hl) return null;
  const { high: targetHigh, low: targetLow } = hl;
  const recent = klines.slice(-24);
  const recentMax = Math.max(...recent.map(k => k.high));
  const recentMin = Math.min(...recent.map(k => k.low));
  const price = klines[klines.length - 1].close;
  let direction = null, entry_low = 0, entry_high = 0, stop = 0, priceTarget = 0, rr = 0, regime = '';
  if (recentMax > targetHigh) {
    const isTrueBreakout = price > targetHigh;
    if (isTrueBreakout) {
      direction = 'LONG'; regime = 'TRUE_BREAKOUT';
      entry_low = targetHigh * 0.999; entry_high = targetHigh * 1.001;
      stop = targetHigh * 0.995; priceTarget = recentMax + (recentMax - targetHigh) * 1.5;
      rr = Math.abs(priceTarget - entry_high) / Math.abs(entry_high - stop);
    } else {
      const sweepIdx = recent.findIndex(k => k.high === recentMax);
      let obLow = 0, obHigh = 0;
      for (let i = sweepIdx; i >= 0; i--) { if (recent[i].close > recent[i].open) { obLow = recent[i].low; obHigh = recent[i].high; break; } }
      if (!obLow) return null;
      direction = 'SHORT'; regime = 'SWEEP_HIGH';
      entry_low = obLow; entry_high = obHigh; stop = recentMax * 1.001; priceTarget = targetLow;
      rr = Math.abs(entry_low - priceTarget) / Math.abs(stop - entry_low);
    }
  } else if (recentMin < targetLow) {
    const isTrueBreakdown = price < targetLow;
    if (isTrueBreakdown) {
      direction = 'SHORT'; regime = 'TRUE_BREAKDOWN';
      entry_high = targetLow * 1.001; entry_low = targetLow * 0.999;
      stop = targetLow * 1.005; priceTarget = recentMin - (targetLow - recentMin) * 1.5;
      rr = Math.abs(entry_low - priceTarget) / Math.abs(stop - entry_low);
    } else {
      const sweepIdx = recent.findIndex(k => k.low === recentMin);
      let obLow = 0, obHigh = 0;
      for (let i = sweepIdx; i >= 0; i--) { if (recent[i].close < recent[i].open) { obLow = recent[i].low; obHigh = recent[i].high; break; } }
      if (!obLow) return null;
      direction = 'LONG'; regime = 'SWEEP_LOW';
      entry_low = obLow; entry_high = obHigh; stop = recentMin * 0.999; priceTarget = targetHigh;
      rr = Math.abs(priceTarget - entry_high) / Math.abs(entry_high - stop);
    }
  }
  if (!direction || rr < 1.5) return null;
  return { symbol, strategy: `SMC (${sessionTarget} Session)`, price, direction, regime, entry_low, entry_high, stop, target: priceTarget, rr };
}

// ── 多數決掃描：至少 2 個同方向才發 ──
export const SCAN_SYMBOLS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','LTCUSDT',
  'DOTUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','AAVEUSDT',
];

// ── RSI 計算 ──
export function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// ── RSI 背離偵測 ──
// 回傳 'CONFIRMED_BULL' | 'CONFIRMED_BEAR' | 'WARNING_BULL' | 'WARNING_BEAR' | null
export function detectRSIDivergence(klines) {
  if (klines.length < 30) return null;
  const closes = klines.map(k => k.close);
  const highs  = klines.map(k => k.high);
  const lows   = klines.map(k => k.low);
  const rsi    = calcRSI(closes, 14);
  const n = klines.length;

  // 找最近兩個擺動低點（看多背離）
  const swingLowIdxs = [];
  for (let i = 3; i < n - 3; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      swingLowIdxs.push(i);
  }
  if (swingLowIdxs.length >= 2) {
    const i1 = swingLowIdxs[swingLowIdxs.length - 2];
    const i2 = swingLowIdxs[swingLowIdxs.length - 1];
    const priceMakesLowerLow = lows[i2] < lows[i1];
    const rsiMakesHigherLow  = rsi[i2] !== null && rsi[i1] !== null && rsi[i2] > rsi[i1];
    if (priceMakesLowerLow && rsiMakesHigherLow) {
      // RSI 是否已勾頭（最新RSI > 前一根）
      const rsiHooked = rsi[n-1] !== null && rsi[n-2] !== null && rsi[n-1] > rsi[n-2];
      return rsiHooked ? 'CONFIRMED_BULL' : 'WARNING_BULL';
    }
  }

  // 找最近兩個擺動高點（看空背離）
  const swingHighIdxs = [];
  for (let i = 3; i < n - 3; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      swingHighIdxs.push(i);
  }
  if (swingHighIdxs.length >= 2) {
    const i1 = swingHighIdxs[swingHighIdxs.length - 2];
    const i2 = swingHighIdxs[swingHighIdxs.length - 1];
    const priceMakesHigherHigh = highs[i2] > highs[i1];
    const rsiMakesLowerHigh    = rsi[i2] !== null && rsi[i1] !== null && rsi[i2] < rsi[i1];
    if (priceMakesHigherHigh && rsiMakesLowerHigh) {
      const rsiHooked = rsi[n-1] !== null && rsi[n-2] !== null && rsi[n-1] < rsi[n-2];
      return rsiHooked ? 'CONFIRMED_BEAR' : 'WARNING_BEAR';
    }
  }

  return null;
}

// ── 反轉K棒識別 ──
function detectReversalCandle(klines, rsiValues) {
  const n = klines.length;
  if (n < 3) return null;
  const c  = klines[n - 1]; // 最新K
  const p  = klines[n - 2]; // 前一根K
  const pp = klines[n - 3]; // 前兩根K
  const rsi = rsiValues[n - 1] || 50;

  const cBody  = Math.abs(c.close - c.open);
  const cRange = c.high - c.low;
  const pBody  = Math.abs(p.close - p.open);

  // 看多K棒（RSI < 45 才算）
  if (rsi < 45) {
    // 錘頭 Hammer
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    if (c.close > c.open && lowerWick > cBody * 2 && upperWick < cBody * 0.5)
      return 'HAMMER';

    // 看多吞噬 Bullish Engulfing
    if (c.close > c.open && p.close < p.open &&
        c.open < p.close && c.close > p.open)
      return 'BULL_ENGULFING';

    // 晨星 Morning Star
    if (pp.close < pp.open &&
        Math.abs(p.close - p.open) < (p.high - p.low) * 0.3 &&
        c.close > c.open && c.close > (pp.open + pp.close) / 2)
      return 'MORNING_STAR';
  }

  // 看空K棒（RSI > 55 才算）
  if (rsi > 55) {
    // 射擊之星 Shooting Star
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (c.close < c.open && upperWick > cBody * 2 && lowerWick < cBody * 0.5)
      return 'SHOOTING_STAR';

    // 看空吞噬 Bearish Engulfing
    if (c.close < c.open && p.close > p.open &&
        c.open > p.close && c.close < p.open)
      return 'BEAR_ENGULFING';

    // 暮星 Evening Star
    if (pp.close > pp.open &&
        Math.abs(p.close - p.open) < (p.high - p.low) * 0.3 &&
        c.close < c.open && c.close < (pp.open + pp.close) / 2)
      return 'EVENING_STAR';
  }

  return null;
}

// ── 信號分級 ──
function gradeSignal(signal, divergence15m, divergence1h, divergence4h, reversalCandle) {
  const dir = signal.direction;
  const divMatch = (div) => div && (
    (dir === 'LONG'  && (div === 'CONFIRMED_BULL' || div === 'WARNING_BULL')) ||
    (dir === 'SHORT' && (div === 'CONFIRMED_BEAR' || div === 'WARNING_BEAR'))
  );
  const divConfirmed = (div) => div && (
    (dir === 'LONG'  && div === 'CONFIRMED_BULL') ||
    (dir === 'SHORT' && div === 'CONFIRMED_BEAR')
  );
  const bullishCandle = ['HAMMER', 'BULL_ENGULFING', 'MORNING_STAR'].includes(reversalCandle);
  const bearishCandle = ['SHOOTING_STAR', 'BEAR_ENGULFING', 'EVENING_STAR'].includes(reversalCandle);
  const candleMatch = (dir === 'LONG' && bullishCandle) || (dir === 'SHORT' && bearishCandle);

  const has4hConfirmed = divConfirmed(divergence4h);
  const has1hConfirmed = divConfirmed(divergence1h);
  const has15mConfirmed = divConfirmed(divergence15m);
  const hasAnyWarning = divMatch(divergence15m) || divMatch(divergence1h) || divMatch(divergence4h);

  if ((has4hConfirmed || has1hConfirmed) && candleMatch) return 'A';
  if (has4hConfirmed || (has1hConfirmed && candleMatch)) return 'A';
  if (has1hConfirmed || has15mConfirmed) return 'B';
  if (hasAnyWarning) return 'B-';
  return 'C';
}

export async function runStrategyScan() {
  const results = [];

  for (let i = 0; i < SCAN_SYMBOLS.length; i += 3) {
    const batch = SCAN_SYMBOLS.slice(i, i + 3);
    await Promise.all(batch.map(async sym => {
      // 同時跑三個策略 + 抓三個時框的 K 線做背離/反轉K棒
      const [r1, r2, r3, k15m, k1h, k4h] = await Promise.allSettled([
        runMSOB(sym),
        runPRZ(sym),
        runSMC(sym),
        fetchKlines(sym, '15m', 100),
        fetchKlines(sym, '1h',  100),
        fetchKlines(sym, '4h',  100),
      ]);

      const signals = [r1, r2, r3]
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      const longs  = signals.filter(s => s.direction === 'LONG');
      const shorts = signals.filter(s => s.direction === 'SHORT');
      const majority = longs.length >= shorts.length ? longs : shorts;

      // 至少 2 個同方向才繼續
      if (majority.length < 2) return;

      // 計算背離
      const klines15m = k15m.status === 'fulfilled' ? k15m.value : null;
      const klines1h  = k1h.status  === 'fulfilled' ? k1h.value  : null;
      const klines4h  = k4h.status  === 'fulfilled' ? k4h.value  : null;

      const div15m = klines15m ? detectRSIDivergence(klines15m) : null;
      const div1h  = klines1h  ? detectRSIDivergence(klines1h)  : null;
      const div4h  = klines4h  ? detectRSIDivergence(klines4h)  : null;

      // 反轉K棒（用 15m）
      let reversalCandle = null;
      if (klines15m) {
        const rsi15m = calcRSI(klines15m.map(k => k.close), 14);
        reversalCandle = detectReversalCandle(klines15m, rsi15m);
      }

      const best = majority.reduce((a, b) => a.rr > b.rr ? a : b);
      const agreeing = majority.map(s => s.strategy).join(' + ');
      const star = majority.length === 3 ? ' ⭐' : '';
      const grade = gradeSignal(best, div15m, div1h, div4h, reversalCandle);

      // C 級不發
      if (grade === 'C') return;

      results.push({
        ...best,
        strategy: agreeing + star,
        strength: majority.length,
        grade,
        divergence: { '15m': div15m, '1h': div1h, '4h': div4h },
        reversalCandle,
      });
    }));
    if (i + 3 < SCAN_SYMBOLS.length) await new Promise(r => setTimeout(r, 400));
  }

  return results;
}

