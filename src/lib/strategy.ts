import type { Kline } from '../hooks/useKlines';
import { calculateEMA, calculateATR, calculateADX, calculateRSI } from './indicators';

export type StrategyResult = {
  symbol: string;
  time: string;
  regime: string;
  price: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  entry_low: number;
  entry_high: number;
  stop: number;
  target: number;
  rr: number;
  logs?: string[];
  smcDetails?: {
    currentSession: string;
    targetSession: string;
    targetHigh: number;
    targetLow: number;
    chochUp: number;
    chochDown: number;
    obLow: number;
    obHigh: number;
    obType: 'BULLISH' | 'BEARISH' | null;
    sweepState: 'SWEEP_HIGH' | 'SWEEP_LOW' | 'NONE';
    sweepHigh?: number;
    sweepLow?: number;
  };
  killzoneDetails?: {
    currentSession: 'Asia' | 'London' | 'New York' | 'Off-Hours';
    setupType: 'LONDON_REVERSAL' | 'NY_REVERSAL' | 'NY_CONTINUATION' | 'NONE';
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    asiaHigh: number;
    asiaLow: number;
    orHigh: number;
    orLow: number;
    sweepSide: 'ASIA_HIGH' | 'ASIA_LOW' | 'OR_HIGH' | 'OR_LOW' | 'NONE';
    sweepLevel: number;
    sweepExtreme: number;
    mssLevel: number;
    fvgLow: number;
    fvgHigh: number;
  };
} | null;

const BINANCE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

async function fetchKlinesWithFallback(symbol: string, interval: string, limit: number) {
  let lastError;
  
  // Try Binance endpoints first
  for (const baseUrl of BINANCE_URLS) {
    try {
      const res = await fetch(`${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (res.ok) {
        const json = await res.json();
        return json.map((d: any) => ({
          time: d[0],
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
        }));
      }
    } catch (e) {
      lastError = e;
      console.warn(`Binance failed for ${symbol} ${interval} on ${baseUrl}, trying next...`);
    }
  }

  // If all Binance endpoints fail, fallback to KuCoin via CORS proxy
  try {
    console.warn(`All Binance endpoints failed for ${symbol} ${interval}, trying KuCoin...`);
    const kucoinSymbol = symbol.replace('USDT', '-USDT');
    const kucoinInterval = interval === '1h' ? '1hour' : interval === '4h' ? '4hour' : interval === '1d' ? '1day' : interval.replace('m', 'min');
    
    const now = Math.floor(Date.now() / 1000);
    let seconds = 60;
    if (interval.endsWith('m')) seconds = parseInt(interval.replace('m', '')) * 60;
    if (interval.endsWith('h')) seconds = parseInt(interval.replace('h', '')) * 3600;
    if (interval.endsWith('d')) seconds = parseInt(interval.replace('d', '')) * 86400;
    const startAt = now - (limit * seconds * 1.5); // 1.5x buffer

    const kucoinUrl = `https://api.kucoin.com/api/v1/market/candles?type=${kucoinInterval}&symbol=${kucoinSymbol}&startAt=${startAt}&endAt=${now}`;
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(kucoinUrl)}`);
    
    if (!res.ok) throw new Error('KuCoin error');
    const json = await res.json();
    if (json.code !== '200000') throw new Error(json.msg);
    
    return json.data.map((d: any) => ({
      time: parseInt(d[0]) * 1000,
      open: parseFloat(d[1]),
      close: parseFloat(d[2]),
      high: parseFloat(d[3]),
      low: parseFloat(d[4]),
    })).reverse();
  } catch (e) {
    throw lastError || new Error('All endpoints failed');
  }
}

type KillzoneSession = 'Asia' | 'London' | 'New York' | 'Off-Hours';

function getTimePartsInZone(time: number, timeZone: string = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(time));

  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const hour = Number(map.hour || 0);
  const minute = Number(map.minute || 0);
  const weekday = weekdayMap[map.weekday || 'Sun'] ?? 0;

  return {
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    weekday,
  };
}

function inSession(minuteOfDay: number, startMinute: number, endMinute: number) {
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function findLatestIndexAtOrBefore(klines: Kline[], time: number) {
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].time <= time) return i;
  }
  return -1;
}

function getCurrentKillzoneSession(time: number): KillzoneSession {
  const et = getTimePartsInZone(time);
  const tradeDay = et.weekday >= 1 && et.weekday <= 5;

  if (inSession(et.minuteOfDay, 20 * 60, 0)) return 'Asia';
  if (tradeDay && inSession(et.minuteOfDay, 2 * 60, 5 * 60)) return 'London';
  if (tradeDay && inSession(et.minuteOfDay, 8 * 60 + 30, 11 * 60)) return 'New York';
  return 'Off-Hours';
}

// --- Helper functions for Structural Reversal ---

function getSwingPoints(klines: any[], n: number = 3) {
  const highs = new Array(klines.length).fill(false);
  const lows = new Array(klines.length).fill(false);

  for (let i = n; i < klines.length - n; i++) {
    const window = klines.slice(i - n, i + n + 1);
    const windowHighs = window.map(k => k.high);
    const windowLows = window.map(k => k.low);

    if (klines[i].high === Math.max(...windowHighs)) {
      highs[i] = true;
    }
    if (klines[i].low === Math.min(...windowLows)) {
      lows[i] = true;
    }
  }
  return { highs, lows };
}

function detectTrend(klines: any[], swingHighs: boolean[], swingLows: boolean[]) {
  const highs = klines.filter((_, i) => swingHighs[i]).map(k => k.high);
  const lows = klines.filter((_, i) => swingLows[i]).map(k => k.low);

  if (highs.length < 2 || lows.length < 2) {
    return { trend: "RANGE", direction: null, highs, lows };
  }

  const lastHighs = highs.slice(-2);
  const lastLows = lows.slice(-2);

  if (lastHighs[1] > lastHighs[0] && lastLows[1] > lastLows[0]) {
    return { trend: "BULLISH", direction: "UP", highs, lows };
  } else if (lastHighs[1] < lastHighs[0] && lastLows[1] < lastLows[0]) {
    return { trend: "BEARISH", direction: "DOWN", highs, lows };
  } else {
    return { trend: "RANGE", direction: null, highs, lows };
  }
}

function findImpulse(klines: any[], swingHighs: boolean[], swingLows: boolean[], direction: string) {
  const highs = klines.filter((_, i) => swingHighs[i]).map(k => k.high);
  const lows = klines.filter((_, i) => swingLows[i]).map(k => k.low);

  if (highs.length === 0 || lows.length === 0) return null;

  if (direction === "UP") {
    return { low: lows[lows.length - 1], high: highs[highs.length - 1] };
  } else if (direction === "DOWN") {
    return { high: highs[highs.length - 1], low: lows[lows.length - 1] };
  }
  return null;
}

function calculatePRZ(low: number, high: number, direction: string) {
  const diff = high - low;
  if (direction === "UP") {
    return { prz_low: high - diff * 0.786, prz_high: high - diff * 0.618 };
  } else {
    return { prz_low: low + diff * 0.618, prz_high: low + diff * 0.786 };
  }
}

function detectDivergence(klines: any[]) {
  const closes = klines.map(k => k.close);
  const rsi = calculateRSI(closes, 14);
  const { highs: swingHighs, lows: swingLows } = getSwingPoints(klines, 3);

  const lows = klines.map((k, i) => ({ ...k, rsi: rsi[i], isSwing: swingLows[i] })).filter(k => k.isSwing);
  const highs = klines.map((k, i) => ({ ...k, rsi: rsi[i], isSwing: swingHighs[i] })).filter(k => k.isSwing);

  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];
    if (l2.low < l1.low && l2.rsi > l1.rsi) return "BULLISH_DIV";
  }

  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];
    if (h2.high > h1.high && h2.rsi < h1.rsi) return "BEARISH_DIV";
  }

  return null;
}

function detectEngulfing(klines: any[]) {
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];

  const bullish = (
    prev.close < prev.open &&
    last.close > last.open &&
    last.close > prev.open &&
    last.open < prev.close
  );

  const bearish = (
    prev.close > prev.open &&
    last.close < last.open &&
    last.open > prev.close &&
    last.close < prev.open
  );

  return { bullish, bearish };
}

const getDecimals = (symbol: string) => {
  if (['ADAUSDT', 'DOGEUSDT'].includes(symbol)) return 4;
  return 2;
};


// ═══════════════════════════════════════════════════════════
// 策略一：Market Structure + Order Block (重寫)
// 邏輯：
//   1. 用 4H 高低點判斷市場結構（上升/下降/盤整）
//   2. 找最近一個有效的 Order Block（突破前最後一根反向大實體K）
//   3. 等價格回踩到 OB 區域才發信號
//   4. 止損放在 OB 之外，目標放在下一個結構高/低點
// ═══════════════════════════════════════════════════════════

function detectMarketStructure(klines: Kline[]): {
  structure: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastSwingHigh: number;
  lastSwingLow: number;
  prevSwingHigh: number;
  prevSwingLow: number;
} {
  const n = 5; // 左右各5根確認擺動點
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = n; i < klines.length - n; i++) {
    const win = klines.slice(i - n, i + n + 1);
    if (klines[i].high === Math.max(...win.map(k => k.high))) swingHighs.push(klines[i].high);
    if (klines[i].low  === Math.min(...win.map(k => k.low)))  swingLows.push(klines[i].low);
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structure: 'RANGING', lastSwingHigh: 0, lastSwingLow: 0, prevSwingHigh: 0, prevSwingLow: 0 };
  }

  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const prevSwingHigh = swingHighs[swingHighs.length - 2];
  const lastSwingLow  = swingLows[swingLows.length - 1];
  const prevSwingLow  = swingLows[swingLows.length - 2];

  // 上升結構：高點創新高 + 低點創新高
  if (lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow) {
    return { structure: 'BULLISH', lastSwingHigh, lastSwingLow, prevSwingHigh, prevSwingLow };
  }
  // 下降結構：高點創新低 + 低點創新低
  if (lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow) {
    return { structure: 'BEARISH', lastSwingHigh, lastSwingLow, prevSwingHigh, prevSwingLow };
  }
  return { structure: 'RANGING', lastSwingHigh, lastSwingLow, prevSwingHigh, prevSwingLow };
}

function findOrderBlock(
  klines: Kline[],
  type: 'BULLISH' | 'BEARISH',
  breakoutIdx: number
): { low: number; high: number } | null {
  // 從突破點往前找，最後一根「明顯反向實體K線」就是 OB
  // 要求：實體 > 整根K線的 50%（過濾掉十字星）
  for (let i = breakoutIdx; i >= Math.max(0, breakoutIdx - 30); i--) {
    const k = klines[i];
    const body = Math.abs(k.close - k.open);
    const range = k.high - k.low;
    if (range === 0) continue;
    const bodyRatio = body / range;
    if (bodyRatio < 0.4) continue; // 實體太小，跳過

    if (type === 'BULLISH' && k.close < k.open) {
      // 做多 OB：空頭實體K（突破前的最後一根陰線）
      return { low: k.low, high: k.high };
    }
    if (type === 'BEARISH' && k.close > k.open) {
      // 做空 OB：多頭實體K（突破前的最後一根陽線）
      return { low: k.low, high: k.high };
    }
  }
  return null;
}

async function runMarketStructureOBStrategy(symbol: string): Promise<StrategyResult> {
  const decimals = getDecimals(symbol);
  const logs: string[] = [`[Market Structure + OB 策略]`, `📍 分析幣種: ${symbol}`];

  const klines4h  = await fetchKlinesWithFallback(symbol, '4h', 300);
  const klines15m = await fetchKlinesWithFallback(symbol, '15m', 200);

  if (klines4h.length < 50 || klines15m.length < 50) {
    return { symbol, time: new Date().toISOString(), regime: 'NO_DATA', price: 0, direction: 'NEUTRAL', entry_low: 0, entry_high: 0, stop: 0, target: 0, rr: 0, logs };
  }

  // 1. 判斷 4H 市場結構
  const ms = detectMarketStructure(klines4h);
  logs.push(`📊 4H 市場結構: ${ms.structure}`);

  if (ms.structure === 'RANGING') {
    logs.push(`⚠️ 4H 結構不明確，等待結構確認`);
    const price = klines4h[klines4h.length - 1].close;
    return { symbol, time: new Date().toISOString(), regime: 'RANGING_WAIT', price, direction: 'NEUTRAL', entry_low: 0, entry_high: 0, stop: 0, target: 0, rr: 0, logs };
  }

  const isBullish = ms.structure === 'BULLISH';
  const obType = isBullish ? 'BULLISH' : 'BEARISH';
  logs.push(`🔍 尋找 ${isBullish ? '做多 (Bullish)' : '做空 (Bearish)'} Order Block...`);

  // 2. 找最近突破點（4H）
  const breakoutIdx = klines4h.length - 10; // 往前10根找OB
  const ob = findOrderBlock(klines4h, obType, breakoutIdx);

  if (!ob) {
    logs.push(`❌ 找不到有效的 Order Block`);
    const price = klines4h[klines4h.length - 1].close;
    return { symbol, time: new Date().toISOString(), regime: 'NO_OB', price, direction: 'NEUTRAL', entry_low: 0, entry_high: 0, stop: 0, target: 0, rr: 0, logs };
  }

  logs.push(`✅ Order Block: ${ob.low.toFixed(decimals)} - ${ob.high.toFixed(decimals)}`);

  // 3. 判斷 15m 價格是否在 OB 區域內（允許±0.5% 緩衝）
  const price = klines15m[klines15m.length - 1].close;
  const obMid = (ob.low + ob.high) / 2;
  const buffer = obMid * 0.005;
  const inOB = price >= ob.low - buffer && price <= ob.high + buffer;

  logs.push(`💰 目前價格: ${price.toFixed(decimals)}`);
  logs.push(`📦 OB 區域: ${ob.low.toFixed(decimals)} - ${ob.high.toFixed(decimals)}`);

  if (!inOB) {
    logs.push(`⏳ 價格尚未回踩 OB，等待中...`);
    return { symbol, time: new Date().toISOString(), regime: 'WAITING_OB_RETEST', price, direction: 'NEUTRAL', entry_low: ob.low, entry_high: ob.high, stop: 0, target: 0, rr: 0, logs };
  }

  logs.push(`🎯 價格進入 OB 區域！準備入場`);

  // 4. 計算入場、止損、目標
  const atr = calculateATR(
    klines15m.map(k => k.high), klines15m.map(k => k.low), klines15m.map(k => k.close), 14
  ).pop() || 0;

  let entry_low: number, entry_high: number, stop: number, target: number;

  if (isBullish) {
    entry_low  = ob.low;
    entry_high = ob.high;
    stop       = ob.low - atr * 0.5;          // 止損放在 OB 之下
    target     = ms.lastSwingHigh;             // 目標：前高
  } else {
    entry_low  = ob.low;
    entry_high = ob.high;
    stop       = ob.high + atr * 0.5;         // 止損放在 OB 之上
    target     = ms.lastSwingLow;              // 目標：前低
  }

  const entryWorst = isBullish ? entry_high : entry_low;
  const risk = Math.abs(entryWorst - stop);
  const reward = Math.abs(target - entryWorst);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.5) {
    logs.push(`⚠️ R/R 不足 (${rr.toFixed(2)})，略過此信號`);
    return { symbol, time: new Date().toISOString(), regime: 'LOW_RR', price, direction: 'NEUTRAL', entry_low, entry_high, stop, target, rr, logs };
  }

  const direction = isBullish ? 'LONG' : 'SHORT';
  logs.push(`✅ 信號確認！方向: ${direction}`);
  logs.push(`📦 入場區: ${entry_low.toFixed(decimals)} - ${entry_high.toFixed(decimals)}`);
  logs.push(`🛡️ 止損: ${stop.toFixed(decimals)}`);
  logs.push(`🎯 目標: ${target.toFixed(decimals)}`);
  logs.push(`⚖️ R/R: ${rr.toFixed(2)}`);

  return {
    symbol,
    time: new Date().toISOString(),
    regime: `MS_OB_${ms.structure}`,
    price,
    direction,
    entry_low,
    entry_high,
    stop,
    target,
    rr,
    logs,
  };
}

async function runStructuralReversalStrategy(symbol: string): Promise<StrategyResult> {
  const decimals = getDecimals(symbol);
  const logs: string[] = [`Analyzing: ${symbol}`];
  
  const klines4h = await fetchKlinesWithFallback(symbol, '4h', 500);
  const { highs: swingHighs4h, lows: swingLows4h } = getSwingPoints(klines4h, 3);
  const rsi4h = calculateRSI(klines4h.map(k => k.close), 14).pop() || 0;
  
  let { trend, direction, highs, lows } = detectTrend(klines4h, swingHighs4h, swingLows4h);
  let activeKlines = klines4h;
  let activeSwingHighs = swingHighs4h;
  let activeSwingLows = swingLows4h;

  logs.push(`4H Trend: ${trend}`);
  logs.push(`Last 3 Swing Highs (4H): ${highs.slice(-3).map(v => v.toFixed(decimals)).join(', ')}`);
  logs.push(`Last 3 Swing Lows (4H): ${lows.slice(-3).map(v => v.toFixed(decimals)).join(', ')}`);
  logs.push(`Current 4H RSI: ${rsi4h.toFixed(2)}`);

  if (trend === "RANGE") {
    logs.push(`⚠ 4H Structure Not Clean (Transitional Market)`);
    logs.push(`>>> 啟動 1H 局部趨勢掃描...`);
    
    const klines1h = await fetchKlinesWithFallback(symbol, '1h', 500);
    const { highs: swingHighs1h, lows: swingLows1h } = getSwingPoints(klines1h, 3);
    const trend1hResult = detectTrend(klines1h, swingHighs1h, swingLows1h);
    
    if (trend1hResult.trend === "RANGE") {
      logs.push(`⚠ 1H 依然為 RANGE，啟動 [區間流動性監控模式]`);
      const rangeHigh = highs.length > 0 ? highs[highs.length - 1] : Math.max(...klines4h.map(k => k.high));
      const rangeLow = lows.length > 0 ? lows[lows.length - 1] : Math.min(...klines4h.map(k => k.low));
      
      logs.push(`Liquidity High (潛在做空區): ${rangeHigh.toFixed(decimals)}`);
      logs.push(`Liquidity Low (潛在做多區): ${rangeLow.toFixed(decimals)}`);
      logs.push(`⏳ 結論：等待價格觸及邊界，尋找假突破 (Sweep) 訊號。`);
      
      const price = klines4h[klines4h.length - 1].close;
      const atr = calculateATR(klines4h.map(k => k.high), klines4h.map(k => k.low), klines4h.map(k => k.close), 14).pop() || 0;

      const isNearHigh = Math.abs(price - rangeHigh) < atr;
      const isNearLow = Math.abs(price - rangeLow) < atr;

      if (isNearHigh) {
        return {
          symbol, time: new Date().toISOString(), regime: "LIQUIDITY_SWEEP_HIGH", price,
          direction: 'SHORT', entry_low: rangeHigh - atr * 0.5, entry_high: rangeHigh + atr * 0.5,
          stop: rangeHigh + atr, target: rangeLow, rr: (rangeHigh - rangeLow) / atr, logs
        };
      } else if (isNearLow) {
        return {
          symbol, time: new Date().toISOString(), regime: "LIQUIDITY_SWEEP_LOW", price,
          direction: 'LONG', entry_low: rangeLow - atr * 0.5, entry_high: rangeLow + atr * 0.5,
          stop: rangeLow - atr, target: rangeHigh, rr: (rangeHigh - rangeLow) / atr, logs
        };
      }
      return {
        symbol, time: new Date().toISOString(), regime: "RANGE_WAITING", price,
        direction: 'LONG', entry_low: 0, entry_high: 0, stop: 0, target: 0, rr: 0, logs
      };
    } else {
      logs.push(`✅ 找到 1H 局部趨勢: ${trend1hResult.trend}`);
      trend = trend1hResult.trend;
      direction = trend1hResult.direction;
      activeKlines = klines1h;
      activeSwingHighs = swingHighs1h;
      activeSwingLows = swingLows1h;
    }
  }

  const impulse = findImpulse(activeKlines, activeSwingHighs, activeSwingLows, direction!);
  if (!impulse) {
    logs.push(`❌ Could not find impulse leg`);
    return {
      symbol, time: new Date().toISOString(), regime: "NO_IMPULSE", price: activeKlines[activeKlines.length-1].close,
      direction: 'LONG', entry_low: 0, entry_high: 0, stop: 0, target: 0, rr: 0, logs
    };
  }

  const { prz_low, prz_high } = calculatePRZ(impulse.low, impulse.high, direction!);
  logs.push(`Impulse Leg Low: ${impulse.low.toFixed(decimals)}`);
  logs.push(`Impulse Leg High: ${impulse.high.toFixed(decimals)}`);
  logs.push(`PRZ Zone: ${prz_low.toFixed(decimals)} - ${prz_high.toFixed(decimals)}`);

  const klines15m = await fetchKlinesWithFallback(symbol, '15m', 200);
  const price = klines15m[klines15m.length - 1].close;
  const rsi15m = calculateRSI(klines15m.map(k => k.close), 14).pop() || 0;
  const atr = calculateATR(klines15m.map(k => k.high), klines15m.map(k => k.low), klines15m.map(k => k.close), 14).pop() || 0;

  logs.push(`15m Current Price: ${price.toFixed(decimals)}`);
  logs.push(`15m RSI: ${rsi15m.toFixed(2)}`);

  const div = detectDivergence(klines15m);
  const { bullish: isBullishEngulf, bearish: isBearishEngulf } = detectEngulfing(klines15m);
  
  logs.push(`15m Divergence: ${div || 'None'}`);
  logs.push(`Bullish Engulfing: ${isBullishEngulf}`);
  logs.push(`Bearish Engulfing: ${isBearishEngulf}`);

  const recentHigh = Math.max(...klines15m.slice(-20).map(k => k.high));
  const recentLow = Math.min(...klines15m.slice(-20).map(k => k.low));
  
  logs.push(`15m Recent High: ${recentHigh.toFixed(decimals)}`);
  logs.push(`15m Recent Low: ${recentLow.toFixed(decimals)}`);

  const bos_up = price > recentHigh;
  const bos_down = price < recentLow;
  
  logs.push(`BOS Up: ${bos_up}`);
  logs.push(`BOS Down: ${bos_down}`);

  const isInPRZ = price >= Math.min(prz_low, prz_high) && price <= Math.max(prz_low, prz_high);

  if (direction === "UP" && isInPRZ) {
    logs.push(`🔥 LONG PRZ ACTIVE`);
    const isLongSignal = div === "BULLISH_DIV" || isBullishEngulf;
    if (isLongSignal) {
      return {
        symbol, time: new Date().toISOString(), regime: `PRZ_REVERSAL_${trend}`, price,
        direction: 'LONG', entry_low: prz_low, entry_high: prz_high,
        stop: impulse.low, target: impulse.high, rr: (impulse.high - price) / (price - impulse.low), logs
      };
    }
  } else if (direction === "DOWN" && isInPRZ) {
    logs.push(`🔥 SHORT PRZ ACTIVE`);
    const isShortSignal = div === "BEARISH_DIV" || isBearishEngulf;
    if (isShortSignal) {
      return {
        symbol, time: new Date().toISOString(), regime: `PRZ_REVERSAL_${trend}`, price,
        direction: 'SHORT', entry_low: prz_low, entry_high: prz_high,
        stop: impulse.high, target: impulse.low, rr: (price - impulse.low) / (impulse.high - price), logs
      };
    }
  } else {
    logs.push(`⏳ Waiting for PRZ touch`);
  }

  const projected_entry = (prz_low + prz_high) / 2;
  let projected_rr = 0;
  if (direction === "UP") {
    projected_rr = (impulse.high - projected_entry) / (projected_entry - impulse.low);
  } else if (direction === "DOWN") {
    projected_rr = (projected_entry - impulse.low) / (impulse.high - projected_entry);
  }

  return {
    symbol, time: new Date().toISOString(), regime: isInPRZ ? "PRZ_WAITING_SIGNAL" : "WAITING_FOR_PRZ", price,
    direction: direction === "UP" ? 'LONG' : 'SHORT', entry_low: prz_low, entry_high: prz_high,
    stop: direction === "UP" ? impulse.low : impulse.high, 
    target: direction === "UP" ? impulse.high : impulse.low, 
    rr: projected_rr, logs
  };
}

function getSessionInfo(date: Date) {
  const h = date.getUTCHours();
  if (h >= 13 && h < 22) return { current: 'New York', target: 'London' };
  if (h >= 7 && h < 13) return { current: 'London', target: 'Asia' };
  if (h >= 0 && h < 7) return { current: 'Asia', target: 'New York' };
  return { current: 'Off-Hours', target: 'New York' }; 
}

function getTargetSessionHighLow(klines: Kline[], targetSession: string, currentDate: Date) {
  let startHour = 0, endHour = 0;
  let targetDate = new Date(currentDate);
  
  if (targetSession === 'London') {
    startHour = 7; endHour = 16;
  } else if (targetSession === 'Asia') {
    startHour = 0; endHour = 8;
  } else if (targetSession === 'New York') {
    startHour = 13; endHour = 22;
    if (currentDate.getUTCHours() < 13) {
      targetDate.setUTCDate(targetDate.getUTCDate() - 1);
    }
  }

  const targetYear = targetDate.getUTCFullYear();
  const targetMonth = targetDate.getUTCMonth();
  const targetDay = targetDate.getUTCDate();

  const sessionKlines = klines.filter(k => {
    const d = new Date(k.time);
    return d.getUTCFullYear() === targetYear &&
           d.getUTCMonth() === targetMonth &&
           d.getUTCDate() === targetDay &&
           d.getUTCHours() >= startHour &&
           d.getUTCHours() < endHour;
  });

  if (sessionKlines.length === 0) return null;

  const high = Math.max(...sessionKlines.map(k => k.high));
  const low = Math.min(...sessionKlines.map(k => k.low));
  return { high, low };
}

function findOB(klines: Kline[], sweepIndex: number, type: 'BULLISH' | 'BEARISH') {
  for (let i = sweepIndex; i >= Math.max(0, sweepIndex - 20); i--) {
    const k = klines[i];
    if (type === 'BEARISH' && k.close > k.open) {
      return { low: k.low, high: k.high };
    }
    if (type === 'BULLISH' && k.close < k.open) {
      return { low: k.low, high: k.high };
    }
  }
  return null;
}

async function runSMCStrategy(symbol: string): Promise<StrategyResult> {
  const decimals = getDecimals(symbol);
  const logs: string[] = [`[SMC Rolling Session 策略執行中...]`, `📍 分析幣種: ${symbol}`];
  
  const now = new Date();
  const { current: currentSession, target: targetSession } = getSessionInfo(now);
  
  const sessionColors: Record<string, string> = {
    'Asia': '🟦 亞洲盤 (Asian Session)',
    'London': '🟨 倫敦盤 (London Session)',
    'New York': '🟥 紐約盤 (New York Session)',
    'Off-Hours': '⬛ 盤整時段 (Off-Hours)'
  };
  
  logs.push(`🕒 當前時區: ${sessionColors[currentSession] || currentSession}`);
  logs.push(`----------------------------------------`);
  logs.push(`🔍 1. 流動性目標狀態 (15m 級別)`);
  
  const klines15m = await fetchKlinesWithFallback(symbol, '15m', 500);
  const targetHL = getTargetSessionHighLow(klines15m, targetSession, now);
  
  if (!targetHL) {
    logs.push(`  - ⚠️ 無法獲取 ${targetSession} 的高低點資料`);
    return {
      symbol, time: now.toISOString(), regime: 'WAITING', price: 0, direction: 'NEUTRAL',
      entry_low: 0, entry_high: 0, stop: 0, target: 0, rr: 0, logs
    };
  }
  
  const { high: targetHigh, low: targetLow } = targetHL;
  logs.push(`  - 目標: ${sessionColors[targetSession] || targetSession}`);
  logs.push(`  - ${targetSession} High: ${targetHigh.toFixed(decimals)}`);
  logs.push(`  - ${targetSession} Low: ${targetLow.toFixed(decimals)}`);
  
  const klines5m = await fetchKlinesWithFallback(symbol, '5m', 200);
  const currentPrice = klines5m[klines5m.length - 1].close;
  
  let sweepState: 'SWEEP_HIGH' | 'SWEEP_LOW' | 'NONE' = 'NONE';
  let sweepHigh = 0;
  let sweepLow = Infinity;
  let sweepIndex = -1;
  
  const recent5m = klines5m.slice(-24);
  const recentMax = Math.max(...recent5m.map(k => k.high));
  const recentMin = Math.min(...recent5m.map(k => k.low));
  
  if (recentMax > targetHigh) {
    sweepState = 'SWEEP_HIGH';
    sweepHigh = recentMax;
    sweepIndex = klines5m.findIndex(k => k.high === recentMax);
    logs.push(`  - ⚠️ 狀態: 【高度關注】目前價格曾刺穿 ${targetSession} High (最高來到 ${sweepHigh.toFixed(decimals)})`);
  } else if (recentMin < targetLow) {
    sweepState = 'SWEEP_LOW';
    sweepLow = recentMin;
    sweepIndex = klines5m.findIndex(k => k.low === recentMin);
    logs.push(`  - ⚠️ 狀態: 【高度關注】目前價格曾刺穿 ${targetSession} Low (最低來到 ${sweepLow.toFixed(decimals)})`);
  } else {
    logs.push(`  - 狀態: 價格在區間內震盪，等待流動性獵取 (Sweep)。`);
  }
  
  logs.push(`----------------------------------------`);
  logs.push(`⚖️ 2. 當前市場結構 (5m 級別)`);
  
  const { highs: swingHighs5m, lows: swingLows5m } = getSwingPoints(klines5m, 3);
  const highs5m = klines5m.filter((_, i) => swingHighs5m[i]).map(k => k.high);
  const lows5m = klines5m.filter((_, i) => swingLows5m[i]).map(k => k.low);
  
  const chochDown = lows5m.length > 0 ? lows5m[lows5m.length - 1] : 0;
  const chochUp = highs5m.length > 0 ? highs5m[highs5m.length - 1] : 0;
  
  logs.push(`  - 最近波段低點 (看空 CHOCH 位): ${chochDown.toFixed(decimals)}`);
  logs.push(`  - 最近波段高點 (看多延續位): ${chochUp.toFixed(decimals)}`);
  
  let obLow = 0, obHigh = 0;
  let obType: 'BULLISH' | 'BEARISH' | null = null;
  
  if (sweepState === 'SWEEP_HIGH') {
    const ob = findOB(klines5m, sweepIndex, 'BEARISH');
    if (ob) {
      obLow = ob.low; obHigh = ob.high; obType = 'BEARISH';
      logs.push(`  - 潛在阻力 OB: ${obLow.toFixed(decimals)} - ${obHigh.toFixed(decimals)}`);
    }
  } else if (sweepState === 'SWEEP_LOW') {
    const ob = findOB(klines5m, sweepIndex, 'BULLISH');
    if (ob) {
      obLow = ob.low; obHigh = ob.high; obType = 'BULLISH';
      logs.push(`  - 潛在支撐 OB: ${obLow.toFixed(decimals)} - ${obHigh.toFixed(decimals)}`);
    }
  } else {
    logs.push(`  - 尚未發生 Sweep，暫無高勝率 OB。`);
  }
  
  logs.push(`----------------------------------------`);
  logs.push(`🎯 3. 交易計畫推演 (If-Then Scenarios)`);
  
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let entry_low = 0, entry_high = 0, stop = 0, target = 0, rr = 0;
  
  if (sweepState === 'SWEEP_HIGH') {
    const isChoch = currentPrice < chochDown;
    // 真突破判斷：刺穿 High 後，當前價格仍站在 targetHigh 之上 → 回踩不破，視為真突破
    const isTrueBreakout = currentPrice > targetHigh;

    if (isTrueBreakout) {
      // ── 真突破：回踩不破 targetHigh，做多 ──
      direction = 'LONG';
      // 入場區：targetHigh 附近（回踩確認支撐）
      entry_low = targetHigh - (sweepHigh - targetHigh) * 0.5;
      entry_high = targetHigh + (sweepHigh - targetHigh) * 0.3;
      stop = targetHigh - (sweepHigh - targetHigh) * 1.0; // 跌破 targetHigh 就認錯
      target = sweepHigh + (sweepHigh - targetHigh) * 1.5; // 延伸目標
      const risk = Math.abs(entry_high - stop);
      rr = risk > 0 ? Math.abs(target - entry_high) / risk : 0;

      logs.push(`  🟢 狀態：真突破確認 (True Breakout)`);
      logs.push(`  - 判斷依據: 刺穿 ${targetSession} High (${targetHigh.toFixed(decimals)}) 後，當前價格 (${currentPrice.toFixed(decimals)}) 仍站在其上。`);
      logs.push(`  - 交易計畫: 等待價格回踩 ${targetSession} High 做多 (LONG)。`);
      logs.push(`  - 🛡️ 建議止損 (SL): 跌破 ${targetSession} High 之下 (${stop.toFixed(decimals)})。`);
      logs.push(`  - 🎯 建議目標 (TP): 看向前高延伸 (${target.toFixed(decimals)})。`);
    } else if (isChoch && obType === 'BEARISH') {
      // ── 假突破 + CHOCH 確認：做空 ──
      entry_low = obLow;
      entry_high = obHigh;
      stop = sweepHigh + (sweepHigh * 0.001);
      target = targetLow;
      rr = (entry_low - target) / (stop - entry_low);
      direction = 'SHORT';

      logs.push(`  🔴 狀態：已確認假突破轉空 (Sweep & CHOCH)`);
      logs.push(`  - 交易計畫: 價格回踩頂部 OB 做空 (SHORT)。`);
    } else {
      // ── 尚未確認方向，列出兩種劇本 ──
      if (obType === 'BEARISH') {
        entry_low = obLow;
        entry_high = obHigh;
        stop = sweepHigh + (sweepHigh * 0.001);
        target = targetLow;
        rr = (entry_low - target) / (stop - entry_low);
        direction = 'SHORT';
      }

      logs.push(`  🔴 劇本 A：假突破轉空 (Sweep & Reversal)`);
      logs.push(`  - 觸發條件: 5m K線向下跌破 CHOCH 位 (${chochDown.toFixed(decimals)})。`);
      logs.push(`  - 交易計畫: 等待價格回踩頂部 OB 做空 (SHORT)。`);
      logs.push(`  - 🛡️ 建議止損 (SL): 設於本次刺穿的最高點 (${sweepHigh.toFixed(decimals)}) + 緩衝。`);
      logs.push(`  - 🎯 建議目標 (TP): 看向 ${targetSession} Low (${targetLow.toFixed(decimals)})。`);
      logs.push(`\n  🟢 劇本 B：真突破延續 (Breakout & Continuation)`);
      logs.push(`  - 觸發條件: 價格持續撐在 ${targetSession} High (${targetHigh.toFixed(decimals)}) 之上。`);
      logs.push(`  - 交易計畫: 等待價格回踩 ${targetSession} High 做多 (LONG)。`);
    }
  } else if (sweepState === 'SWEEP_LOW') {
    const isChoch = currentPrice > chochUp;
    const isTrueBreakdown = currentPrice < targetLow;

    if (isTrueBreakdown) {
      // ── 真跌破：回踩不過 targetLow，做空 ──
      direction = 'SHORT';
      entry_high = targetLow + (targetLow - sweepLow) * 0.5;
      entry_low = targetLow - (targetLow - sweepLow) * 0.3;
      stop = targetLow + (targetLow - sweepLow) * 1.0;
      target = sweepLow - (targetLow - sweepLow) * 1.5;
      const risk = Math.abs(stop - entry_low);
      rr = risk > 0 ? Math.abs(entry_low - target) / risk : 0;

      logs.push(`  🔴 狀態：真跌破確認 (True Breakdown)`);
      logs.push(`  - 判斷依據: 刺穿 ${targetSession} Low (${targetLow.toFixed(decimals)}) 後，當前價格 (${currentPrice.toFixed(decimals)}) 仍在其下。`);
      logs.push(`  - 交易計畫: 等待價格反彈回踩 ${targetSession} Low 做空 (SHORT)。`);
      logs.push(`  - 🛡️ 建議止損 (SL): 突破 ${targetSession} Low 之上 (${stop.toFixed(decimals)})。`);
      logs.push(`  - 🎯 建議目標 (TP): 看向前低延伸 (${target.toFixed(decimals)})。`);
    } else if (isChoch && obType === 'BULLISH') {
      entry_low = obLow;
      entry_high = obHigh;
      stop = sweepLow - (sweepLow * 0.001);
      target = targetHigh;
      rr = (target - entry_high) / (entry_high - stop);
      direction = 'LONG';

      logs.push(`  🟢 狀態：已確認假跌破轉多 (Sweep & CHOCH)`);
      logs.push(`  - 交易計畫: 價格回踩底部 OB 做多 (LONG)。`);
    } else {
      if (obType === 'BULLISH') {
        entry_low = obLow;
        entry_high = obHigh;
        stop = sweepLow - (sweepLow * 0.001);
        target = targetHigh;
        rr = (target - entry_high) / (entry_high - stop);
        direction = 'LONG';
      }

      logs.push(`  🟢 劇本 A：假跌破轉多 (Sweep & Reversal)`);
      logs.push(`  - 觸發條件: 5m K線向上突破 CHOCH 位 (${chochUp.toFixed(decimals)})。`);
      logs.push(`  - 交易計畫: 等待價格回踩底部 OB 做多 (LONG)。`);
      logs.push(`  - 🛡️ 建議止損 (SL): 設於本次刺穿的最低點 (${sweepLow.toFixed(decimals)}) - 緩衝。`);
      logs.push(`  - 🎯 建議目標 (TP): 看向 ${targetSession} High (${targetHigh.toFixed(decimals)})。`);
      logs.push(`\n  🔴 劇本 B：真跌破延續 (Breakdown & Continuation)`);
      logs.push(`  - 觸發條件: 價格持續壓在 ${targetSession} Low (${targetLow.toFixed(decimals)}) 之下。`);
      logs.push(`  - 交易計畫: 等待價格回踩 ${targetSession} Low 做空 (SHORT)。`);
    }
  } else {
    logs.push(`  - 價格目前在區間內，請耐心等待價格來到 ${targetHigh.toFixed(decimals)} 或 ${targetLow.toFixed(decimals)} 附近。`);
  }
  
  logs.push(`----------------------------------------`);
  if (direction === 'NEUTRAL') {
    logs.push(`💡 結論: 目前處於決策邊界或震盪區間，請密切關注 CHOCH 位的突破情況。`);
  } else {
    logs.push(`💡 結論: 交易條件已成立，可依據 Entry Zone 佈局。`);
  }

  return {
    symbol,
    time: now.toISOString(),
    regime: direction !== 'NEUTRAL' ? 'ACTIVE' : 'WAITING',
    price: currentPrice,
    direction,
    entry_low,
    entry_high,
    stop,
    target,
    rr: rr > 0 ? rr : 0,
    logs,
    smcDetails: {
      currentSession,
      targetSession,
      targetHigh,
      targetLow,
      chochUp,
      chochDown,
      obLow,
      obHigh,
      obType,
      sweepState,
      sweepHigh,
      sweepLow
    }
  };
}

async function runIctKillzoneOpt3Strategy(symbol: string): Promise<StrategyResult> {
  const decimals = getDecimals(symbol);
  const logs: string[] = [`[ICT Killzone Opt3]`, `📍 分析幣種: ${symbol}`];

  const [klines5m, klines1h, klines1d] = await Promise.all([
    fetchKlinesWithFallback(symbol, '5m', 500),
    fetchKlinesWithFallback(symbol, '1h', 300),
    fetchKlinesWithFallback(symbol, '1d', 10),
  ]);

  if (klines5m.length < 80 || klines1h.length < 60 || klines1d.length < 2) {
    return {
      symbol,
      time: new Date().toISOString(),
      regime: 'NO_DATA',
      price: 0,
      direction: 'NEUTRAL',
      entry_low: 0,
      entry_high: 0,
      stop: 0,
      target: 0,
      rr: 0,
      logs: [...logs, '⚠️ 資料不足，無法計算 Killzone 模型'],
    };
  }

  const last = klines5m.length - 1;
  const current = klines5m[last];
  const prev = klines5m[last - 1];
  const prev2 = klines5m[last - 2];
  const currentSession = getCurrentKillzoneSession(current.time);
  const et = getTimePartsInZone(current.time);
  const tradeDay = et.weekday >= 1 && et.weekday <= 5;
  const inLondon = tradeDay && inSession(et.minuteOfDay, 2 * 60, 5 * 60);
  const inNyWindow = tradeDay && inSession(et.minuteOfDay, 8 * 60 + 30, 11 * 60);
  const afterOpeningRange = inNyWindow && et.minuteOfDay >= 10 * 60;

  const closes5m = klines5m.map(k => k.close);
  const highs5m = klines5m.map(k => k.high);
  const lows5m = klines5m.map(k => k.low);
  const atrSeries = calculateATR(highs5m, lows5m, closes5m, 14);
  const atr = atrSeries[last] || 0;
  const bodySize = Math.abs(current.close - current.open);
  const sweepBuffer = atr * 0.10;
  const stopBuffer = atr * 0.20;

  const emaFastSeries = calculateEMA(klines1h.map(k => k.close), 20);
  const emaSlowSeries = calculateEMA(klines1h.map(k => k.close), 50);
  const h1Idx = findLatestIndexAtOrBefore(klines1h, current.time);
  const d1Idx = findLatestIndexAtOrBefore(klines1d, current.time);
  const h1Fast = h1Idx >= 0 ? emaFastSeries[h1Idx] : null;
  const h1Slow = h1Idx >= 0 ? emaSlowSeries[h1Idx] : null;
  const dailyOpen = d1Idx >= 0 ? klines1d[d1Idx].open : current.open;

  const bullBias = !!(h1Fast && h1Slow && h1Fast > h1Slow);
  const bearBias = !!(h1Fast && h1Slow && h1Fast < h1Slow);
  const biasLabel = bullBias ? 'BULLISH' : bearBias ? 'BEARISH' : 'NEUTRAL';

  let asiaHigh = 0;
  let asiaLow = 0;
  let orHigh = 0;
  let orLow = 0;
  let prevInAsia = false;
  let prevNyWindow = false;

  for (const bar of klines5m) {
    const barEt = getTimePartsInZone(bar.time);
    const barTradeDay = barEt.weekday >= 1 && barEt.weekday <= 5;
    const barInAsia = inSession(barEt.minuteOfDay, 20 * 60, 0);
    const barInNyWindow = barTradeDay && inSession(barEt.minuteOfDay, 8 * 60 + 30, 11 * 60);
    const barInOpeningRange = barTradeDay && inSession(barEt.minuteOfDay, 9 * 60 + 30, 10 * 60);

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

  const bullMssLevel = Math.max(...highs5m.slice(Math.max(0, last - 3), last));
  const bearMssLevel = Math.min(...lows5m.slice(Math.max(0, last - 3), last));
  const bullMss = current.close > bullMssLevel;
  const bearMss = current.close < bearMssLevel;
  const bullDisplacement = current.close > current.open && bodySize >= atr * 0.5;
  const bearDisplacement = current.close < current.open && bodySize >= atr * 0.5;
  const bullFvg = current.low > prev2.high;
  const bearFvg = current.high < prev2.low;
  const bullConfirm = bullDisplacement && bullMss;
  const bearConfirm = bearDisplacement && bearMss;

  const recent = klines5m.slice(Math.max(0, last - 10), last + 1);
  const londonBullSweeps = inLondon && asiaLow > 0
    ? recent.filter(bar => bar.low < asiaLow - sweepBuffer)
    : [];
  const londonBearSweeps = inLondon && asiaHigh > 0
    ? recent.filter(bar => bar.high > asiaHigh + sweepBuffer)
    : [];
  const nyBullReversalSweeps = afterOpeningRange && orLow > 0
    ? recent.filter(bar => bar.low < orLow - sweepBuffer)
    : [];
  const nyBearReversalSweeps = afterOpeningRange && orHigh > 0
    ? recent.filter(bar => bar.high > orHigh + sweepBuffer)
    : [];

  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let entry_low = 0;
  let entry_high = 0;
  let stop = 0;
  let target = 0;
  let rr = 0;
  let regime = 'WAITING';
  let setupType: 'LONDON_REVERSAL' | 'NY_REVERSAL' | 'NY_CONTINUATION' | 'NONE' = 'NONE';
  let sweepSide: 'ASIA_HIGH' | 'ASIA_LOW' | 'OR_HIGH' | 'OR_LOW' | 'NONE' = 'NONE';
  let sweepLevel = 0;
  let sweepExtreme = 0;
  let mssLevel = 0;
  let fvgLow = 0;
  let fvgHigh = 0;

  const setTrade = (
    side: 'LONG' | 'SHORT',
    nextSetupType: 'LONDON_REVERSAL' | 'NY_REVERSAL' | 'NY_CONTINUATION',
    nextSweepSide: 'ASIA_HIGH' | 'ASIA_LOW' | 'OR_HIGH' | 'OR_LOW',
    nextSweepLevel: number,
    nextSweepExtreme: number,
    nextMssLevel: number,
    nextEntry: number,
    nextStop: number,
    nextTarget: number,
    nextFvgLow: number,
    nextFvgHigh: number,
    summary: string[],
  ) => {
    direction = side;
    setupType = nextSetupType;
    sweepSide = nextSweepSide;
    sweepLevel = nextSweepLevel;
    sweepExtreme = nextSweepExtreme;
    mssLevel = nextMssLevel;
    entry_low = nextEntry;
    entry_high = nextEntry;
    stop = nextStop;
    target = nextTarget;
    fvgLow = nextFvgLow;
    fvgHigh = nextFvgHigh;
    rr = Math.abs(nextTarget - nextEntry) / Math.max(Math.abs(nextEntry - nextStop), 0.0000001);
    regime = `${nextSetupType}_${side}`;
    logs.push(...summary);
  };

  logs.push(`🕒 當前時段: ${currentSession}`);
  logs.push(`📈 Bias: ${biasLabel} | H1 EMA20 ${h1Fast?.toFixed(decimals) ?? 'n/a'} / EMA50 ${h1Slow?.toFixed(decimals) ?? 'n/a'}`);
  logs.push(`🌞 Daily Open: ${dailyOpen.toFixed(decimals)}`);
  logs.push(`🌏 Asia Range: ${asiaLow.toFixed(decimals)} - ${asiaHigh.toFixed(decimals)}`);
  if (orHigh > 0 && orLow > 0) {
    logs.push(`🗽 NY Opening Range: ${orLow.toFixed(decimals)} - ${orHigh.toFixed(decimals)}`);
  }
  logs.push(`⚙️ Confirm: Disp ${bullDisplacement || bearDisplacement ? 'YES' : 'NO'} | Bull MSS ${bullMss ? 'YES' : 'NO'} | Bear MSS ${bearMss ? 'YES' : 'NO'}`);

  if (inLondon && bullBias && bullConfirm && londonBullSweeps.length > 0) {
    const extreme = Math.min(...londonBullSweeps.map(bar => bar.low));
    const entry = current.close;
    const stopPrice = extreme - stopBuffer;
    const targetPrice = entry + (entry - stopPrice) * 2.0;
    setTrade(
      'LONG',
      'LONDON_REVERSAL',
      'ASIA_LOW',
      asiaLow,
      extreme,
      bullMssLevel,
      entry,
      stopPrice,
      targetPrice,
      bullFvg ? prev2.high : 0,
      bullFvg ? current.low : 0,
      [
        `✅ London reversal long 觸發`,
        `- 掃掉 Asia Low 後反轉，MSS 位 ${bullMssLevel.toFixed(decimals)}`,
        `- 入場 ${entry.toFixed(decimals)} | Stop ${stopPrice.toFixed(decimals)} | Target ${targetPrice.toFixed(decimals)}`,
      ],
    );
  } else if (inLondon && bearBias && bearConfirm && londonBearSweeps.length > 0) {
    const extreme = Math.max(...londonBearSweeps.map(bar => bar.high));
    const entry = current.close;
    const stopPrice = extreme + stopBuffer;
    const targetPrice = entry - (stopPrice - entry) * 2.0;
    setTrade(
      'SHORT',
      'LONDON_REVERSAL',
      'ASIA_HIGH',
      asiaHigh,
      extreme,
      bearMssLevel,
      entry,
      stopPrice,
      targetPrice,
      bearFvg ? current.high : 0,
      bearFvg ? prev2.low : 0,
      [
        `✅ London reversal short 觸發`,
        `- 掃掉 Asia High 後反轉，MSS 位 ${bearMssLevel.toFixed(decimals)}`,
        `- 入場 ${entry.toFixed(decimals)} | Stop ${stopPrice.toFixed(decimals)} | Target ${targetPrice.toFixed(decimals)}`,
      ],
    );
  } else if (afterOpeningRange && bullBias && bullConfirm && bullFvg && nyBullReversalSweeps.length > 0 && current.close > orLow) {
    const extreme = Math.min(...nyBullReversalSweeps.map(bar => bar.low));
    const entry = current.close;
    const stopPrice = extreme - stopBuffer;
    const targetPrice = entry + (entry - stopPrice) * 2.0;
    setTrade(
      'LONG',
      'NY_REVERSAL',
      'OR_LOW',
      orLow,
      extreme,
      bullMssLevel,
      entry,
      stopPrice,
      targetPrice,
      prev2.high,
      current.low,
      [
        `✅ NY reversal long 觸發`,
        `- 掃掉 OR Low 後收回，且 NY long 保留 FVG 過濾`,
        `- 入場 ${entry.toFixed(decimals)} | Stop ${stopPrice.toFixed(decimals)} | Target ${targetPrice.toFixed(decimals)}`,
      ],
    );
  } else if (afterOpeningRange && bearBias && bearConfirm && nyBearReversalSweeps.length > 0 && current.close < orHigh) {
    const extreme = Math.max(...nyBearReversalSweeps.map(bar => bar.high));
    const entry = current.close;
    const stopPrice = extreme + stopBuffer;
    const targetPrice = entry - (stopPrice - entry) * 2.0;
    setTrade(
      'SHORT',
      'NY_REVERSAL',
      'OR_HIGH',
      orHigh,
      extreme,
      bearMssLevel,
      entry,
      stopPrice,
      targetPrice,
      bearFvg ? current.high : 0,
      bearFvg ? prev2.low : 0,
      [
        `✅ NY reversal short 觸發`,
        `- 掃掉 OR High 後反轉，等待回補失衡`,
        `- 入場 ${entry.toFixed(decimals)} | Stop ${stopPrice.toFixed(decimals)} | Target ${targetPrice.toFixed(decimals)}`,
      ],
    );
  } else if (afterOpeningRange && bullBias && bullConfirm && bullFvg && orHigh > 0 && current.close > orHigh && prev.close <= orHigh) {
    const entry = current.close;
    const stopPrice = Math.min(orLow || current.low, prev.low, prev2.low) - stopBuffer;
    const targetPrice = entry + (entry - stopPrice) * 2.0;
    setTrade(
      'LONG',
      'NY_CONTINUATION',
      'OR_HIGH',
      orHigh,
      current.high,
      bullMssLevel,
      entry,
      stopPrice,
      targetPrice,
      prev2.high,
      current.low,
      [
        `✅ NY continuation long 觸發`,
        `- 突破 OR High 並伴隨 displacement + MSS + FVG`,
        `- 入場 ${entry.toFixed(decimals)} | Stop ${stopPrice.toFixed(decimals)} | Target ${targetPrice.toFixed(decimals)}`,
      ],
    );
  } else if (afterOpeningRange && bearBias && bearConfirm && orLow > 0 && current.close < orLow && prev.close >= orLow) {
    const entry = current.close;
    const stopPrice = Math.max(orHigh || current.high, prev.high, prev2.high) + stopBuffer;
    const targetPrice = entry - (stopPrice - entry) * 2.0;
    setTrade(
      'SHORT',
      'NY_CONTINUATION',
      'OR_LOW',
      orLow,
      current.low,
      bearMssLevel,
      entry,
      stopPrice,
      targetPrice,
      bearFvg ? current.high : 0,
      bearFvg ? prev2.low : 0,
      [
        `✅ NY continuation short 觸發`,
        `- 跌破 OR Low 並延續`,
        `- 入場 ${entry.toFixed(decimals)} | Stop ${stopPrice.toFixed(decimals)} | Target ${targetPrice.toFixed(decimals)}`,
      ],
    );
  } else {
    if (inLondon) {
      logs.push(`⏳ 倫敦窗內，但還沒有完整的 sweep + displacement + MSS 組合`);
    } else if (afterOpeningRange) {
      logs.push(`⏳ NY 窗內，但 OR 劇本尚未完整確認`);
    } else if (inNyWindow) {
      logs.push(`⏳ 還在 NY Opening Range 建立中，先等 09:30-10:00 ET 完成`);
    } else {
      logs.push(`💤 目前不在 London / NY AM 執行窗，先看 levels 不急著下結論`);
    }
  }

  if (direction !== 'NEUTRAL') {
    logs.push(`⚖️ R/R: ${rr.toFixed(2)}`);
  }

  return {
    symbol,
    time: new Date(current.time).toISOString(),
    regime,
    price: current.close,
    direction,
    entry_low,
    entry_high,
    stop,
    target,
    rr,
    logs,
    killzoneDetails: {
      currentSession,
      setupType,
      bias: biasLabel,
      asiaHigh,
      asiaLow,
      orHigh,
      orLow,
      sweepSide,
      sweepLevel,
      sweepExtreme,
      mssLevel,
      fvgLow,
      fvgHigh,
    },
  };
}

export async function runStrategy(symbol: string, strategyId: string = 'ms_ob'): Promise<StrategyResult> {
  try {
    if (strategyId === 'structural_reversal') {
      return await runStructuralReversalStrategy(symbol);
    } else if (strategyId === 'smc_session') {
      return await runSMCStrategy(symbol);
    } else if (strategyId === 'ict_killzone_opt3') {
      return await runIctKillzoneOpt3Strategy(symbol);
    } else {
      return await runMarketStructureOBStrategy(symbol);
    }
  } catch (error) {
    console.error("Strategy execution failed:", error);
    return null;
  }
}

// ── 多數決：同時跑三個策略，至少2個同方向才回傳信號 ──
export async function runAllStrategies(symbol: string): Promise<{
  result: StrategyResult | null;
  signals: StrategyResult[];
  strength: number;
  agreeing: string[];
}> {
  const [r1, r2, r3] = await Promise.allSettled([
    runMarketStructureOBStrategy(symbol),
    runStructuralReversalStrategy(symbol),
    runSMCStrategy(symbol),
  ]);

  const results = [r1, r2, r3]
    .filter(r => r.status === 'fulfilled' && r.value?.direction !== 'NEUTRAL' && (r.value?.rr || 0) >= 1.5)
    .map(r => (r as any).value as StrategyResult);

  const longs  = results.filter(r => r.direction === 'LONG');
  const shorts = results.filter(r => r.direction === 'SHORT');
  const majority = longs.length >= shorts.length ? longs : shorts;

  if (majority.length < 2) {
    return { result: null, signals: results, strength: majority.length, agreeing: [] };
  }

  // 用 R/R 最高的那個當主要結果
  const best = majority.reduce((a, b) => a.rr > b.rr ? a : b);
  const strategyNames = ['MS+OB', 'Structural PRZ', 'SMC Session'];
  const agreeing = majority.map(r => {
    if (r.regime?.startsWith('MS_OB')) return 'MS+OB';
    if (r.regime?.includes('PRZ') || r.regime?.includes('IMPULSE') || r.regime?.includes('LIQUIDITY')) return 'Structural PRZ';
    return 'SMC Session';
  });

  return {
    result: { ...best, regime: `${best.regime} ★${majority.length}/3` },
    signals: results,
    strength: majority.length,
    agreeing,
  };
}
