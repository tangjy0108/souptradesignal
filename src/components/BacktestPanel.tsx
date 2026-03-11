import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────
interface Kline { t: number; o: number; h: number; l: number; c: number; v: number; }

type StrategyId = 'stoch_snr' | 'trend_pullback' | 'snr_fvg_lq_tc';

interface StochParams {
  stochBull: number; stochBear: number;
  snrDist: number; requireBoth: boolean;
  longEnabled: boolean; shortEnabled: boolean;
  extremeEntry: boolean;
}
interface TrendPbParams {
  htfFactor: number;
  htfFastEma: number; htfSlowEma: number;
  ltfEma: number;
  adxLength: number; adxThreshold: number;
  pullbackAtrMult: number; lookbackBars: number;
  atrLength: number;
}
interface SnrLqParams {
  snrStrength: number;
  fvgMinSizePct: number; volumeThreshold: number;
  signalGap: number; lqSweepLookback: number;
  tcTapWindow: number; fvgFreshnessBars: number;
  zoneAtrBuffer: number;
  adxLength: number; adxThreshold: number;
  atrLength: number;
}

interface Trade {
  dir: 'LONG' | 'SHORT'; setup: string; regime: string;
  entryTime: number; entryPrice: number; exitPrice: number;
  result: 'WIN' | 'LOSS'; pnl: number; pnlR: number; bars: number;
  exitReason: 'target' | 'stop' | 'time_end';
}
interface BacktestResult { sym: string; trades: Trade[]; error?: string; }
interface HeatCell { stop: number; target: number; winRate: number; expectancy: number; trades: number; totalPnl: number; }

// ─────────────────────────────────────────────────────────────────
// 預設參數
// ─────────────────────────────────────────────────────────────────
const DEFAULT_STOCH: StochParams = {
  stochBull: 30, stochBear: 70, snrDist: 2.5,
  requireBoth: false, longEnabled: true, shortEnabled: true, extremeEntry: true,
};
const DEFAULT_TRENDPB: TrendPbParams = {
  htfFactor: 4, htfFastEma: 50, htfSlowEma: 200,
  ltfEma: 20, adxLength: 14, adxThreshold: 20,
  pullbackAtrMult: 0.6, lookbackBars: 5, atrLength: 14,
};
const DEFAULT_SNRLQ: SnrLqParams = {
  snrStrength: 15, fvgMinSizePct: 0.05, volumeThreshold: 1.1,
  signalGap: 3, lqSweepLookback: 5, tcTapWindow: 3,
  fvgFreshnessBars: 20, zoneAtrBuffer: 0.15,
  adxLength: 14, adxThreshold: 20, atrLength: 14,
};

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT'];
const FEE_BPS = 4;
const SLIPPAGE_BPS = 2;

// ─────────────────────────────────────────────────────────────────
// 指標（RMA-based，對齊交易員版引擎）
// ─────────────────────────────────────────────────────────────────
function rma(values: number[], len: number): number[] {
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : (prev * (len - 1) + values[i]) / len;
    out.push(prev);
  }
  return out;
}

function ema(values: number[], len: number): number[] {
  const alpha = 2 / (len + 1);
  let prev = values[0] ?? 0;
  return values.map((v, i) => { prev = i === 0 ? v : alpha * v + (1 - alpha) * prev; return prev; });
}

function atrArr(klines: Kline[], len: number): number[] {
  const trs = klines.map((k, i) => {
    if (i === 0) return k.h - k.l;
    const pc = klines[i - 1].c;
    return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
  });
  return rma(trs, len);
}

function adxArr(klines: Kline[], len: number): number[] {
  const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
  for (let i = 0; i < klines.length; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); tr.push(klines[i].h - klines[i].l); continue; }
    const up = klines[i].h - klines[i - 1].h, down = klines[i - 1].l - klines[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(klines[i].h - klines[i].l, Math.abs(klines[i].h - klines[i - 1].c), Math.abs(klines[i].l - klines[i - 1].c)));
  }
  const trR = rma(tr, len), pR = rma(plusDM, len), mR = rma(minusDM, len);
  const dx = trR.map((t, i) => { const pdi = t === 0 ? 0 : 100 * pR[i] / t, mdi = t === 0 ? 0 : 100 * mR[i] / t; const d = pdi + mdi; return d === 0 ? 0 : 100 * Math.abs(pdi - mdi) / d; });
  return rma(dx, len);
}

// ─────────────────────────────────────────────────────────────────
// StochRSI（原版策略用）
// ─────────────────────────────────────────────────────────────────
function calcRSI(closes: number[], p = 14): (number | null)[] {
  const res: (number | null)[] = new Array(closes.length).fill(null);
  const g: number[] = [], l: number[] = [];
  for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  for (let i = p; i < closes.length; i++) {
    const ag = g.slice(i - p, i).reduce((a, b) => a + b, 0) / p;
    const al = l.slice(i - p, i).reduce((a, b) => a + b, 0) / p;
    res[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return res;
}

function calcStochRSI(closes: number[]): { K: (number | null)[]; D: (number | null)[] } {
  const rsi = calcRSI(closes, 14);
  const rawK: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 13; i < rsi.length; i++) {
    const w = rsi.slice(i - 13, i + 1).filter((v): v is number => v !== null);
    if (w.length < 14) continue;
    const lo = Math.min(...w), hi = Math.max(...w);
    rawK[i] = hi === lo ? 50 : ((rsi[i] as number) - lo) / (hi - lo) * 100;
  }
  const K: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 2; i < rawK.length; i++) { const w = rawK.slice(i - 2, i + 1).filter((v): v is number => v !== null); if (w.length === 3) K[i] = w.reduce((a, b) => a + b, 0) / 3; }
  const D: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 2; i < K.length; i++) { const w = K.slice(i - 2, i + 1).filter((v): v is number => v !== null); if (w.length === 3) D[i] = w.reduce((a, b) => a + b, 0) / 3; }
  return { K, D };
}

// ─────────────────────────────────────────────────────────────────
// 原版 StochRSI × SNR/FVG 引擎
// ─────────────────────────────────────────────────────────────────
function findPivots(klines: Kline[], str = 6): { highs: number[]; lows: number[] } {
  const highs: number[] = [], lows: number[] = [];
  for (let i = str; i < klines.length - str; i++) {
    let isH = true, isL = true;
    for (let k = i - str; k <= i + str; k++) { if (k === i) continue; if (klines[k].h >= klines[i].h) isH = false; if (klines[k].l <= klines[i].l) isL = false; }
    if (isH) highs.push(klines[i].h); if (isL) lows.push(klines[i].l);
  }
  return { highs: highs.slice(-8), lows: lows.slice(-8) };
}

function findFVG(klines: Kline[]): { bull: [number, number][]; bear: [number, number][] } {
  const bull: [number, number][] = [], bear: [number, number][] = [];
  for (let i = 2; i < klines.length; i++) {
    if (klines[i].l > klines[i - 2].h) bull.push([klines[i - 2].h, klines[i].l]);
    if (klines[i].h < klines[i - 2].l) bear.push([klines[i].h, klines[i - 2].l]);
  }
  return { bull: bull.slice(-5), bear: bear.slice(-5) };
}

function getStochSignal(klines: Kline[], i: number, K: (number | null)[], D: (number | null)[], p: StochParams): 'LONG' | 'SHORT' | null {
  if (i < 60 || K[i] == null || D[i] == null) return null;
  const Kv = K[i] as number, Dv = D[i] as number;
  const price = klines[i].c;
  const sBull = Kv < p.stochBull && Kv > Dv;
  const sBear = Kv > p.stochBear && Kv < Dv;
  const win = klines.slice(Math.max(0, i - 100), i + 1);
  const { highs, lows } = findPivots(win, 6);
  const { bull: bFVG, bear: rFVG } = findFVG(win.slice(-60));
  const nearSup = lows.some(lv => Math.abs(price - lv) / price < p.snrDist / 100);
  const nearRes = highs.some(h => Math.abs(price - h) / price < p.snrDist / 100);
  const inBull = bFVG.some(([lo, hi]) => price >= lo * 0.99 && price <= hi * 1.01);
  const inBear = rFVG.some(([lo, hi]) => price >= lo * 0.99 && price <= hi * 1.01);
  const longOk = p.requireBoth ? (nearSup && inBull) : (nearSup || inBull);
  const shortOk = p.requireBoth ? (nearRes && inBear) : (nearRes || inBear);
  if (sBull && longOk && p.longEnabled) return 'LONG';
  if (sBear && shortOk && p.shortEnabled) return 'SHORT';
  if (p.extremeEntry) { if (Kv < 10 && p.longEnabled) return 'LONG'; if (Kv > 90 && p.shortEnabled) return 'SHORT'; }
  return null;
}

function runStochBacktest(klines: Kline[], stopPct: number, targetPct: number, p: StochParams): Trade[] {
  const { K, D } = calcStochRSI(klines.map(k => k.c));
  const trades: Trade[] = [];
  let inTrade = false, entry = 0, dir: 'LONG' | 'SHORT' = 'LONG', entryI = 0, entryTime = 0;
  for (let i = 60; i < klines.length - 1; i++) {
    if (inTrade) {
      const bar = klines[i];
      const stop = dir === 'LONG' ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
      const tgt = dir === 'LONG' ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
      const hitS = dir === 'LONG' ? bar.l <= stop : bar.h >= stop;
      const hitT = dir === 'LONG' ? bar.h >= tgt : bar.l <= tgt;
      if (hitS || hitT) {
        const exitPrice = hitS ? stop : tgt;
        const grossPnl = dir === 'LONG' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100;
        const pnl = grossPnl - (FEE_BPS * 2 + SLIPPAGE_BPS) / 100;
        trades.push({ dir, setup: 'stoch_snr', regime: 'n/a', entryTime, entryPrice: entry, exitPrice, result: pnl > 0 ? 'WIN' : 'LOSS', pnl, pnlR: stopPct > 0 ? pnl / stopPct : 0, bars: i - entryI, exitReason: hitS ? 'stop' : 'target' });
        inTrade = false;
      }
    } else {
      const sig = getStochSignal(klines, i, K, D, p);
      if (sig) { inTrade = true; entry = klines[i + 1].o; dir = sig; entryI = i; entryTime = klines[i].t; }
    }
  }
  return trades;
}

// ─────────────────────────────────────────────────────────────────
// 共用工具
// ─────────────────────────────────────────────────────────────────
function resample(klines: Kline[], factor: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < klines.length; i += factor) {
    const chunk = klines.slice(i, i + factor);
    if (!chunk.length) continue;
    out.push({ t: chunk[0].t, o: chunk[0].o, h: Math.max(...chunk.map(k => k.h)), l: Math.min(...chunk.map(k => k.l)), c: chunk[chunk.length - 1].c, v: chunk.reduce((s, k) => s + k.v, 0) });
  }
  return out;
}

// 嚴格小於（修正前瞻偏差）
function htfIndexAt(htf: Kline[], ltfTime: number): number {
  let idx = -1;
  for (let j = 0; j < htf.length; j++) { if (htf[j].t < ltfTime) idx = j; else break; }
  return idx;
}

function finalizeTrade(trades: Trade[], klines: Kline[], side: 'LONG' | 'SHORT', setup: string, regime: string, entryIdx: number, exitIdx: number, entryPrice: number, exitPrice: number, stopPrice: number, exitReason: Trade['exitReason']) {
  const slip = SLIPPAGE_BPS / 10000;
  const effExit = side === 'LONG' ? exitPrice * (1 - slip) : exitPrice * (1 + slip);
  const grossPct = side === 'LONG' ? (effExit - entryPrice) / entryPrice * 100 : (entryPrice - effExit) / entryPrice * 100;
  const netPct = grossPct - (FEE_BPS * 2 + SLIPPAGE_BPS) / 100;
  const riskPct = side === 'LONG' ? (entryPrice - stopPrice) / entryPrice * 100 : (stopPrice - entryPrice) / entryPrice * 100;
  trades.push({ dir: side, setup, regime, entryTime: klines[entryIdx].t, entryPrice, exitPrice: effExit, result: netPct > 0 ? 'WIN' : 'LOSS', pnl: netPct, pnlR: riskPct > 0 ? netPct / riskPct : 0, bars: exitIdx - entryIdx, exitReason });
}

// ─────────────────────────────────────────────────────────────────
// HTF Trend Pullback 引擎
// ─────────────────────────────────────────────────────────────────
function runTrendPullback(klines: Kline[], stopPct: number, targetPct: number, p: TrendPbParams, maxBars = 80): Trade[] {
  const closes = klines.map(k => k.c);
  const ltfEmaV = ema(closes, p.ltfEma);
  const atrV = atrArr(klines, p.atrLength);
  const htf = resample(klines, p.htfFactor);
  const htfFast = ema(htf.map(k => k.c), p.htfFastEma);
  const htfSlow = ema(htf.map(k => k.c), p.htfSlowEma);
  const htfAdx = adxArr(htf, p.adxLength);

  const trades: Trade[] = [];
  let open: { side: 'LONG' | 'SHORT'; setup: string; regime: string; idx: number; entry: number; stop: number; target: number } | null = null;
  const start = Math.max(p.lookbackBars + 2, 5);

  for (let i = start; i < klines.length; i++) {
    const k = klines[i];
    const hi = htfIndexAt(htf, k.t);
    const hFast = hi >= 0 ? htfFast[hi] : 0;
    const hSlow = hi >= 0 ? htfSlow[hi] : 0;
    const hAdx = hi >= 0 ? htfAdx[hi] : 0;
    const trendBull = hFast > hSlow && hAdx >= p.adxThreshold;
    const trendBear = hFast < hSlow && hAdx >= p.adxThreshold;
    const regime = trendBull ? 'trend_bull' : trendBear ? 'trend_bear' : 'chop';

    if (open) {
      let exitR: Trade['exitReason'] | null = null, exitP = k.c;
      if (open.side === 'LONG') { if (k.l <= open.stop) { exitR = 'stop'; exitP = open.stop; } else if (k.h >= open.target) { exitR = 'target'; exitP = open.target; } }
      else { if (k.h >= open.stop) { exitR = 'stop'; exitP = open.stop; } else if (k.l <= open.target) { exitR = 'target'; exitP = open.target; } }
      if (!exitR && i - open.idx >= maxBars) { exitR = 'time_end'; exitP = k.c; }
      if (exitR || i === klines.length - 1) {
        finalizeTrade(trades, klines, open.side, open.setup, open.regime, open.idx, i, open.entry, exitP, open.stop, exitR ?? 'time_end');
        open = null;
      }
      continue;
    }

    if (!(trendBull || trendBear)) continue;
    const atrNow = atrV[i], emaNow = ltfEmaV[i];
    const slice = klines.slice(Math.max(0, i - p.lookbackBars), i);
    const recentLow = Math.min(...slice.map(x => x.l));
    const recentHigh = Math.max(...slice.map(x => x.h));
    const nearPbLong = k.l <= emaNow + atrNow * p.pullbackAtrMult && recentLow < emaNow;
    const nearPbShort = k.h >= emaNow - atrNow * p.pullbackAtrMult && recentHigh > emaNow;
    const bullConfirm = k.c > k.o && k.h > klines[i - 1].h && k.c > emaNow;
    const bearConfirm = k.c < k.o && k.l < klines[i - 1].l && k.c < emaNow;
    const slip = SLIPPAGE_BPS / 10000;

    if (trendBull && nearPbLong && bullConfirm) {
      const entry = k.c * (1 + slip);
      open = { side: 'LONG', setup: 'pullback_long', regime, idx: i, entry, stop: entry * (1 - stopPct / 100), target: entry * (1 + targetPct / 100) };
    } else if (trendBear && nearPbShort && bearConfirm) {
      const entry = k.c * (1 - slip);
      open = { side: 'SHORT', setup: 'pullback_short', regime, idx: i, entry, stop: entry * (1 + stopPct / 100), target: entry * (1 - targetPct / 100) };
    }
  }
  return trades;
}

// ─────────────────────────────────────────────────────────────────
// SNR + FVG + LQ / TC 引擎（修正：前瞻偏差 & FVG 部分填補）
// ─────────────────────────────────────────────────────────────────
type ZoneSNR = { wickY: number; bodyY: number; startBar: number; isRes: boolean };
type ZoneFVG = { top: number; bottom: number; startBar: number; isBull: boolean; hitCount: number };

function runSnrLqTc(klines: Kline[], stopPct: number, targetPct: number, p: SnrLqParams, maxBars = 80): Trade[] {
  const closes = klines.map(k => k.c);
  const highs = klines.map(k => k.h);
  const lows = klines.map(k => k.l);
  const volumes = klines.map(k => k.v);
  const ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const atrV = atrArr(klines, p.atrLength), adxV = adxArr(klines, p.adxLength);
  const vma20 = ema(volumes, 20);
  const pDMraw = highs.map((h, i) => { if (i === 0) return 0; const u = h - highs[i-1], d = lows[i-1] - lows[i]; return u > d && u > 0 ? u : 0; });
  const nDMraw = lows.map((l, i) => { if (i === 0) return 0; const u = highs[i] - highs[i-1], d = lows[i-1] - l; return d > u && d > 0 ? d : 0; });
  const trL = klines.map((k, i) => i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - closes[i-1]), Math.abs(k.l - closes[i-1])));
  const trR = rma(trL, p.adxLength);
  const pDiR = rma(pDMraw, p.adxLength);
  const nDiR = rma(nDMraw, p.adxLength);
  const pDi = trR.map((t, i) => t === 0 ? 0 : 100 * pDiR[i] / t);
  const nDi = trR.map((t, i) => t === 0 ? 0 : 100 * nDiR[i] / t);

  const snrActive: ZoneSNR[] = [], fvgActive: ZoneFVG[] = [], trades: Trade[] = [];
  let open: { side: 'LONG' | 'SHORT'; setup: string; regime: string; idx: number; entry: number; stop: number; target: number } | null = null;
  let lastSig = -9999, lastSupBreak = -9999, lastResBreak = -9999;
  let lastBullFvgTap = -9999, lastBearFvgTap = -9999, smcTrend = 0;
  const str = p.snrStrength, start = Math.max(str * 2 + 3, 10);

  for (let i = start; i < klines.length; i++) {
    const k = klines[i], atrNow = atrV[i];
    const isTrend = adxV[i] > p.adxThreshold;
    const trendBull = ema50[i] > ema200[i] && isTrend;
    const trendBear = ema50[i] < ema200[i] && isTrend;
    const regime = trendBull ? 'trend_bull' : trendBear ? 'trend_bear' : 'chop';

    // SNR pivot
    const pivotIdx = i - str;
    if (pivotIdx - str >= 0) {
      let isH = true, isL = true;
      for (let j = pivotIdx - str; j <= pivotIdx + str; j++) {
        if (j < 0 || j >= klines.length || j === pivotIdx) continue;
        if (highs[pivotIdx] <= highs[j]) isH = false;
        if (lows[pivotIdx] >= lows[j]) isL = false;
      }
      if (isH) snrActive.push({ wickY: highs[pivotIdx], bodyY: Math.max(klines[pivotIdx].o, klines[pivotIdx].c), startBar: pivotIdx, isRes: true });
      if (isL) snrActive.push({ wickY: lows[pivotIdx], bodyY: Math.min(klines[pivotIdx].o, klines[pivotIdx].c), startBar: pivotIdx, isRes: false });
    }

    // FVG
    if (i >= 2) {
      const bullGap = k.l > highs[i-2] && (k.l - highs[i-2]) / k.c * 100 > p.fvgMinSizePct && volumes[i-1] > vma20[i] * p.volumeThreshold;
      if (bullGap) fvgActive.push({ top: k.l, bottom: highs[i-2], startBar: i, isBull: true, hitCount: 0 });
      const bearGap = k.h < lows[i-2] && (lows[i-2] - k.h) / k.c * 100 > p.fvgMinSizePct && volumes[i-1] > vma20[i] * p.volumeThreshold;
      if (bearGap) fvgActive.push({ top: lows[i-2], bottom: k.h, startBar: i, isBull: false, hitCount: 0 });
    }

    let inBull = false, inBear = false;

    for (let z = snrActive.length - 1; z >= 0; z--) {
      const s = snrActive[z];
      if (i <= s.startBar) continue;
      const buf = atrNow * p.zoneAtrBuffer;
      const bHit = k.h >= s.bodyY - buf && k.l <= s.bodyY + buf;
      const bBreak = s.isRes ? k.c > s.bodyY : k.c < s.bodyY;
      if (bBreak) { if (s.isRes) { lastResBreak = i; smcTrend = 1; } else { lastSupBreak = i; smcTrend = -1; } }
      if (bHit && !bBreak) { if (s.isRes) inBear = true; else inBull = true; }
      const stale = i - s.startBar > p.fvgFreshnessBars * 2;
      if (bBreak || stale) snrActive.splice(z, 1);
    }

    for (let z = fvgActive.length - 1; z >= 0; z--) {
      const f = fvgActive[z];
      if (i <= f.startBar) continue;
      const stale = i - f.startBar > p.fvgFreshnessBars;
      const fHit = k.h >= f.bottom && k.l <= f.top;
      const fBreak = f.isBull ? k.c < f.bottom : k.c > f.top;
      if (fBreak) { if (f.isBull) { lastSupBreak = i; smcTrend = -1; } else { lastResBreak = i; smcTrend = 1; } }
      if (fHit && !fBreak) { if (f.isBull) { inBull = true; lastBullFvgTap = i; } else { inBear = true; lastBearFvgTap = i; } f.hitCount++; }
      // 修正：只在 break/stale/過度使用 才刪除，不在 touch 時刪除
      if (fBreak || stale || f.hitCount > 3) fvgActive.splice(z, 1);
    }

    if (open) {
      let exitR: Trade['exitReason'] | null = null, exitP = k.c;
      if (open.side === 'LONG') { if (k.l <= open.stop) { exitR = 'stop'; exitP = open.stop; } else if (k.h >= open.target) { exitR = 'target'; exitP = open.target; } }
      else { if (k.h >= open.stop) { exitR = 'stop'; exitP = open.stop; } else if (k.l <= open.target) { exitR = 'target'; exitP = open.target; } }
      if (!exitR && i - open.idx >= maxBars) { exitR = 'time_end'; exitP = k.c; }
      if (exitR || i === klines.length - 1) {
        finalizeTrade(trades, klines, open.side, open.setup, open.regime, open.idx, i, open.entry, exitP, open.stop, exitR ?? 'time_end');
        open = null;
      }
      continue;
    }

    const canSig = (i - lastSig) >= p.signalGap;
    const sweep = Math.max(2, p.lqSweepLookback);
    const prevLow = Math.min(...lows.slice(Math.max(0, i - sweep), i));
    const prevHigh = Math.max(...highs.slice(Math.max(0, i - sweep), i));
    const bullSweep = k.l < prevLow && k.c > prevLow;
    const bullReject = k.c > k.o && k.c > closes[i-1] && k.c > k.l + (k.h - k.l) * 0.55;
    const bearSweep = k.h > prevHigh && k.c < prevHigh;
    const bearReject = k.c < k.o && k.c < closes[i-1] && k.c < k.h - (k.h - k.l) * 0.55;
    const lqBull = canSig && inBull && bullSweep && bullReject && !trendBear;
    const lqBear = canSig && inBear && bearSweep && bearReject && !trendBull;
    const tcBull = canSig && (i - lastSupBreak) > 2 && smcTrend === 1 && pDi[i] > nDi[i] && (i - lastBullFvgTap) <= p.tcTapWindow && trendBull && k.c > k.o && k.c > Math.max(klines[i-1].o, klines[i-1].c);
    const tcBear = canSig && (i - lastResBreak) > 2 && smcTrend === -1 && nDi[i] > pDi[i] && (i - lastBearFvgTap) <= p.tcTapWindow && trendBear && k.c < k.o && k.c < Math.min(klines[i-1].o, klines[i-1].c);

    const makeEntry = (side: 'LONG' | 'SHORT', setup: string) => {
      const slip = SLIPPAGE_BPS / 10000;
      const entry = side === 'LONG' ? k.c * (1 + slip) : k.c * (1 - slip);
      open = { side, setup, regime, idx: i, entry, stop: side === 'LONG' ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100), target: side === 'LONG' ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100) };
      lastSig = i;
    };

    if (lqBull) { makeEntry('LONG', 'lq_long'); continue; }
    if (lqBear) { makeEntry('SHORT', 'lq_short'); continue; }
    if (tcBull) { makeEntry('LONG', 'tc_long'); continue; }
    if (tcBear) { makeEntry('SHORT', 'tc_short'); continue; }
  }
  return trades;
}

// ─────────────────────────────────────────────────────────────────
// Heatmap 掃描
// ─────────────────────────────────────────────────────────────────
// 可掃描的維度定義
type ScanDimKey = 'stop' | 'target' | 'adxThreshold' | 'rrTarget' | 'snrStrength' | 'pullbackAtrMult' | 'ltfEma' | 'lqSweepLookback' | 'fvgFreshnessBars';

interface ScanDimDef {
  key: ScanDimKey;
  label: string;
  values: number[];
  strategies: StrategyId[];
}

const SCAN_DIMS: ScanDimDef[] = [
  { key: 'stop',             label: 'Stop %',            values: [0.5,1.0,1.5,2.0,2.5,3.0],    strategies: ['stoch_snr','trend_pullback','snr_fvg_lq_tc'] },
  { key: 'target',           label: 'Target %',          values: [1.0,1.5,2.0,2.5,3.0,4.0,5.0], strategies: ['stoch_snr','trend_pullback','snr_fvg_lq_tc'] },
  { key: 'adxThreshold',     label: 'ADX 門檻',           values: [15,18,20,22,25,28],           strategies: ['trend_pullback','snr_fvg_lq_tc'] },
  { key: 'rrTarget',         label: 'RR Target',         values: [1.5,2.0,2.5,3.0],             strategies: ['trend_pullback','snr_fvg_lq_tc'] },
  { key: 'snrStrength',      label: 'SNR Strength',      values: [8,10,12,15,18,20],            strategies: ['snr_fvg_lq_tc'] },
  { key: 'pullbackAtrMult',  label: 'Pullback ATR Mult', values: [0.3,0.5,0.6,0.8,1.0,1.2],    strategies: ['trend_pullback'] },
  { key: 'ltfEma',           label: 'LTF EMA',           values: [10,15,20,25,30],              strategies: ['trend_pullback'] },
  { key: 'lqSweepLookback',  label: 'LQ Lookback',       values: [3,5,7,10,12],                strategies: ['snr_fvg_lq_tc'] },
  { key: 'fvgFreshnessBars', label: 'FVG Freshness',     values: [10,15,20,30,40],              strategies: ['snr_fvg_lq_tc'] },
];

interface FlexHeatCell { x: number; y: number; winRate: number; expectancy: number; trades: number; totalPnl: number; profitFactor: number; }

function runWithOverride(klines: Kline[], stopPct: number, targetPct: number, strategyId: StrategyId, sp: StochParams, tp: TrendPbParams, lp: SnrLqParams, overrides: Partial<Record<ScanDimKey, number>>): Trade[] {
  const s2 = stopPct, t2 = targetPct;
  const effStop   = overrides.stop   ?? s2;
  const effTarget = overrides.target ?? t2;
  if (strategyId === 'stoch_snr') return runStochBacktest(klines, effStop, effTarget, sp);
  if (strategyId === 'trend_pullback') {
    const p2: TrendPbParams = { ...tp, adxThreshold: overrides.adxThreshold ?? tp.adxThreshold, pullbackAtrMult: overrides.pullbackAtrMult ?? tp.pullbackAtrMult, ltfEma: overrides.ltfEma ?? tp.ltfEma };
    const rr = overrides.rrTarget ?? (effTarget / effStop);
    return runTrendPullback(klines, effStop, effStop * rr, p2);
  }
  const p3: SnrLqParams = { ...lp, adxThreshold: overrides.adxThreshold ?? lp.adxThreshold, snrStrength: overrides.snrStrength ?? lp.snrStrength, lqSweepLookback: overrides.lqSweepLookback ?? lp.lqSweepLookback, fvgFreshnessBars: overrides.fvgFreshnessBars ?? lp.fvgFreshnessBars };
  const rr = overrides.rrTarget ?? (effTarget / effStop);
  return runSnrLqTc(klines, effStop, effStop * rr, p3);
}

function scanHeatmapFlex(klines: Kline[], xDim: ScanDimDef, yDim: ScanDimDef, stopPct: number, targetPct: number, strategyId: StrategyId, sp: StochParams, tp: TrendPbParams, lp: SnrLqParams): FlexHeatCell[] {
  const cells: FlexHeatCell[] = [];
  for (const xVal of xDim.values) {
    for (const yVal of yDim.values) {
      const overrides: Partial<Record<ScanDimKey, number>> = { [xDim.key]: xVal, [yDim.key]: yVal };
      // skip invalid stop/target combos
      const effStop = overrides.stop ?? stopPct;
      const effTarget = overrides.target ?? targetPct;
      if (effTarget <= effStop) continue;
      const trades = runWithOverride(klines, stopPct, targetPct, strategyId, sp, tp, lp, overrides);
      if (!trades.length) continue;
      const wins = trades.filter(t => t.result === 'WIN').length;
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      const gp = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
      const gl = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
      cells.push({ x: xVal, y: yVal, winRate: wins / trades.length * 100, expectancy: totalPnl / trades.length, trades: trades.length, totalPnl, profitFactor: gl===0 ? gp : gp/gl });
    }
  }
  return cells;
}

// ─────────────────────────────────────────────────────────────────
// Fetch（with in-memory cache）
// ─────────────────────────────────────────────────────────────────
const klineMemCache = new Map<string, { data: Kline[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

async function fetchKlines(symbol: string, days: number): Promise<Kline[]> {
  const key = `${symbol}:${days}`;
  const cached = klineMemCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const endMs = Date.now(), startMs = endMs - days * 24 * 60 * 60 * 1000;
  let all: Kline[] = [], cursor = startMs;
  while (cursor < endMs) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&startTime=${cursor}&limit=1000`);
    if (!r.ok) break;
    const data: any[][] = await r.json();
    if (!data.length) break;
    data.forEach(d => all.push({ t: d[0], o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5] }));
    cursor = data[data.length - 1][0] + 1;
    if (data.length < 1000) break;
  }
  klineMemCache.set(key, { data: all, ts: Date.now() });
  return all;
}

// ─────────────────────────────────────────────────────────────────
// 統計
// ─────────────────────────────────────────────────────────────────
function calcStats(trades: Trade[]) {
  if (!trades.length) return null;
  const wins = trades.filter(t => t.result === 'WIN');
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = wins.length / trades.length * 100;
  const longs = trades.filter(t => t.dir === 'LONG'), shorts = trades.filter(t => t.dir === 'SHORT');
  let eq = 100, peak = 100, maxDD = 0;
  trades.forEach(t => { eq += t.pnl; if (eq > peak) peak = eq; const dd = (peak - eq) / peak * 100; if (dd > maxDD) maxDD = dd; });
  let maxCL = 0, cl = 0, clStart = 0, maxCLStart = 0, maxCLEnd = 0;
  trades.forEach((t, i) => { if (t.result === 'LOSS') { if (cl === 0) clStart = i; cl++; if (cl > maxCL) { maxCL = cl; maxCLStart = clStart; maxCLEnd = i; } } else cl = 0; });
  const mean = totalPnl / trades.length;
  const variance = trades.reduce((s, t) => s + Math.pow(t.pnl - mean, 2), 0) / trades.length;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(252 * 24 * 4) : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.result === 'LOSS').reduce((s, t) => s + t.pnl, 0));
  const profitFactor = gl === 0 ? gp : gp / gl;
  const expectancyR = trades.reduce((s, t) => s + t.pnlR, 0) / trades.length;
  const byMonth: Record<string, { wins: number; total: number; pnl: number }> = {};
  trades.forEach(t => { const m = new Date(t.entryTime).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit' }); if (!byMonth[m]) byMonth[m] = { wins: 0, total: 0, pnl: 0 }; byMonth[m].total++; byMonth[m].pnl += t.pnl; if (t.result === 'WIN') byMonth[m].wins++; });
  const setups = [...new Set(trades.map(t => t.setup))];
  const setupBreakdown = setups.map(s => {
    const st = trades.filter(t => t.setup === s), sw = st.filter(t => t.result === 'WIN');
    const sgp = sw.reduce((x, t) => x + t.pnl, 0), sgl = Math.abs(st.filter(t => t.result === 'LOSS').reduce((x, t) => x + t.pnl, 0));
    return { key: s, trades: st.length, winRate: st.length ? sw.length / st.length * 100 : 0, avgR: st.length ? st.reduce((x, t) => x + t.pnlR, 0) / st.length : 0, pf: sgl === 0 ? sgp : sgp / sgl };
  });
  const regimes = [...new Set(trades.map(t => t.regime))];
  const regimeBreakdown = regimes.map(r => { const rt = trades.filter(t => t.regime === r), rw = rt.filter(t => t.result === 'WIN'); return { key: r, trades: rt.length, winRate: rt.length ? rw.length / rt.length * 100 : 0 }; });
  return { totalPnl, winRate, maxDD, sharpe, profitFactor, expectancyR, wins: wins.length, losses: trades.length - wins.length, total: trades.length, avgHours: trades.reduce((s, t) => s + t.bars, 0) / trades.length * 15 / 60, longs: longs.length, shorts: shorts.length, longWr: longs.length ? longs.filter(t => t.result === 'WIN').length / longs.length * 100 : 0, shortWr: shorts.length ? shorts.filter(t => t.result === 'WIN').length / shorts.length * 100 : 0, maxCL, maxCLStart: trades[maxCLStart]?.entryTime, maxCLEnd: trades[maxCLEnd]?.entryTime, byMonth, expectancy: totalPnl / trades.length, setupBreakdown, regimeBreakdown };
}

function buildParamsBlock(strategyId: StrategyId, stopPct: number, targetPct: number, sp: StochParams, tp: TrendPbParams, lp: SnrLqParams): string[] {
  const base = [`Stop：${stopPct}%  Target：${targetPct}%  RR 1:${(targetPct/stopPct).toFixed(1)}`, `費用：${FEE_BPS}bps  滑點：${SLIPPAGE_BPS}bps`];
  if (strategyId === 'stoch_snr') return [...base, `StochRSI 多頭閾值：${sp.stochBull}  空頭閾值：${sp.stochBear}`, `SNR 距離：${sp.snrDist}%  FVG+SNR同時：${sp.requireBoth?'是':'否'}`, `做多：${sp.longEnabled?'開':'關'}  做空：${sp.shortEnabled?'開':'關'}  極端值：${sp.extremeEntry?'開':'關'}`];
  if (strategyId === 'trend_pullback') return [...base, `HTF 倍率：${tp.htfFactor}×15m  Fast EMA：${tp.htfFastEma}  Slow EMA：${tp.htfSlowEma}`, `LTF EMA：${tp.ltfEma}  ADX 門檻：${tp.adxThreshold}  ADX Length：${tp.adxLength}`, `Pullback ATR Mult：${tp.pullbackAtrMult}  Lookback Bars：${tp.lookbackBars}`];
  return [...base, `SNR Strength：${lp.snrStrength}  ADX 門檻：${lp.adxThreshold}`, `FVG Min Size：${lp.fvgMinSizePct}%  Volume 門檻：${lp.volumeThreshold}`, `Signal Gap：${lp.signalGap}  LQ Lookback：${lp.lqSweepLookback}  TC Tap Window：${lp.tcTapWindow}`, `FVG Freshness：${lp.fvgFreshnessBars} bars  Zone ATR Buffer：${lp.zoneAtrBuffer}`];
}

function buildAISuggestions(stats: NonNullable<ReturnType<typeof calcStats>>): string[] {
  const s: string[] = ['【建議 AI 分析方向】'];
  const regimes = stats.regimeBreakdown;
  if (regimes.length >= 2) {
    const sorted = [...regimes].sort((a,b) => b.winRate - a.winRate);
    if (sorted[0].winRate - sorted[sorted.length-1].winRate > 15)
      s.push(`- ${sorted[sorted.length-1].key} 勝率（${sorted[sorted.length-1].winRate.toFixed(0)}%）比 ${sorted[0].key}（${sorted[0].winRate.toFixed(0)}%）低很多，這個 regime 是否應該停止交易？`);
  }
  stats.setupBreakdown.forEach(su => {
    if (su.avgR < 0 && su.trades >= 5) s.push(`- ${su.key} 的 avgR 是 ${su.avgR.toFixed(2)}（負值），進場條件是否需要加強過濾？`);
  });
  if (stats.profitFactor < 1.3 && stats.total >= 10) s.push(`- Profit Factor 只有 ${stats.profitFactor.toFixed(2)}，建議嘗試提高 ADX 門檻或縮小 SNR 距離來過濾低品質訊號。`);
  if (stats.maxDD > Math.abs(stats.totalPnl) * 1.5 && stats.maxDD > 5) s.push(`- 最大回撤（${stats.maxDD.toFixed(1)}%）遠高於總損益（${stats.totalPnl.toFixed(1)}%），建議評估縮小每筆風險。`);
  if (Math.abs(stats.longWr - stats.shortWr) > 20 && stats.longs >= 5 && stats.shorts >= 5) s.push(`- 做多勝率（${stats.longWr.toFixed(0)}%）vs 做空（${stats.shortWr.toFixed(0)}%）差距明顯，目前市況是否只適合做單方向？`);
  if (stats.maxCL >= 5) s.push(`- 最大連續虧損 ${stats.maxCL} 筆，這段時間市況有何特徵？連虧開始時是否能提早停止？`);
  if (s.length === 1) { s.push('- 整體表現穩定，可嘗試縮小 Stop 並配合更嚴格的 ADX 門檻，看是否能提升 expectancyR。'); s.push('- 是否有特定月份績效特別好或差？分析這些月份的市場結構有何不同。'); }
  return s;
}

function generateReport(results: BacktestResult[], strategyId: StrategyId, stopPct: number, targetPct: number, days: number, sp: StochParams, tp: TrendPbParams, lp: SnrLqParams): string {
  const all = results.flatMap(r => r.trades), stats = calcStats(all);
  if (!stats) return '無交易數據';
  const stratLabel = strategyId === 'stoch_snr' ? 'StochRSI × SNR/FVG' : strategyId === 'trend_pullback' ? 'HTF Trend Pullback' : 'SNR + FVG + LQ / TC';
  const syms = results.filter(r => r.trades.length).map(r => r.sym).join(' / ');
  const end = new Date().toLocaleDateString('zh-TW'), start = new Date(Date.now() - days * 86400000).toLocaleDateString('zh-TW');
  const paramsBlock = buildParamsBlock(strategyId, stopPct, targetPct, sp, tp, lp);
  const aiBlock = buildAISuggestions(stats);
  return [
    '═══════════════════════════════', '  QuantView 策略診斷報告', '═══════════════════════════════', '',
    '【基本資訊】', `幣種：${syms}`, `時間框：15m`, `回測期間：${start} ~ ${end}`, `策略：${stratLabel}`, '',
    '【完整參數設定】', ...paramsBlock, '',
    '【整體績效】',
    `總交易筆數：${stats.total}`, `勝率：${stats.winRate.toFixed(1)}%`,
    `總損益：${stats.totalPnl>=0?'+':''}${stats.totalPnl.toFixed(2)}%`,
    `期望值/筆：${stats.expectancy>=0?'+':''}${stats.expectancy.toFixed(3)}%`,
    `期望值 R：${stats.expectancyR>=0?'+':''}${stats.expectancyR.toFixed(3)}R`,
    `Profit Factor：${stats.profitFactor.toFixed(2)}`, `最大回撤：-${stats.maxDD.toFixed(1)}%`,
    `Sharpe：${stats.sharpe.toFixed(2)}`, `平均持倉：${stats.avgHours.toFixed(1)} 小時`, '',
    '【Setup 分類】', ...stats.setupBreakdown.map(s => `  ${s.key}：${s.trades}筆 勝率${s.winRate.toFixed(0)}% PF${s.pf.toFixed(2)} avgR${s.avgR.toFixed(2)}`), '',
    '【Regime 分類】', ...stats.regimeBreakdown.map(r => `  ${r.key}：${r.trades}筆 勝率${r.winRate.toFixed(0)}%`), '',
    '【月份分佈】', ...Object.entries(stats.byMonth).sort().map(([m,v])=>`${m}  ${v.total}筆  勝率${(v.wins/v.total*100).toFixed(0)}%  ${v.pnl>=0?'+':''}${v.pnl.toFixed(1)}%`), '',
    '【連續虧損分析】', `最大連續虧損：${stats.maxCL} 筆`,
    stats.maxCLStart ? `發生時間：${new Date(stats.maxCLStart).toLocaleDateString('zh-TW')} ~ ${new Date(stats.maxCLEnd!).toLocaleDateString('zh-TW')}` : '', '',
    '【各幣種明細】', ...results.map(r => { if (!r.trades.length) return `${r.sym}：無訊號`; const s = calcStats(r.trades)!; return `${r.sym}：${r.trades.length}筆 勝率${s.winRate.toFixed(0)}% 損益${s.totalPnl>=0?'+':''}${s.totalPnl.toFixed(1)}% PF${s.profitFactor.toFixed(2)}`; }), '',
    ...aiBlock, '',
    '═══════════════════════════════', '注意：實際交易最大回撤預估為回測的 1.5~2 倍', '═══════════════════════════════',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────
// UI 元件
// ─────────────────────────────────────────────────────────────────
const C = { bg: '#0B0E14', surf: '#131722', brd: '#2A2E39', acc: '#2962FF', gr: '#089981', rd: '#F23645', yl: '#FFC107', txt: '#D1D4DC', mut: '#787B86' };
const inp = { width: '100%', background: C.surf, border: `1px solid ${C.brd}`, color: C.txt, padding: '7px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box' as const, outline: 'none' };

function EquityChart({ trades }: { trades: Trade[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || !trades.length) return;
    const cv = ref.current, ctx = cv.getContext('2d')!, dpr = window.devicePixelRatio || 1;
    cv.width = cv.offsetWidth * dpr; cv.height = 100 * dpr; ctx.scale(dpr, dpr);
    const w = cv.offsetWidth, h = 100;
    const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    let eq = 100; const pts = [{ x: 0, y: eq }];
    sorted.forEach((t, i) => { eq += t.pnl; pts.push({ x: (i + 1) / sorted.length, y: eq }); });
    const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y)), rng = maxY - minY || 1;
    const tx = (x: number) => x * w, ty = (y: number) => h - ((y - minY) / rng) * (h - 16) - 8;
    ctx.fillStyle = '#0B0E14'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2A2E39'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, ty(100)); ctx.lineTo(w, ty(100)); ctx.stroke(); ctx.setLineDash([]);
    const col = eq >= 100 ? '#089981' : '#F23645';
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, eq >= 100 ? 'rgba(8,153,129,0.2)' : 'rgba(242,54,69,0.2)'); grad.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.moveTo(tx(pts[0].x), ty(pts[0].y)); pts.forEach(p => ctx.lineTo(tx(p.x), ty(p.y)));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(tx(pts[0].x), ty(pts[0].y)); pts.forEach(p => ctx.lineTo(tx(p.x), ty(p.y)));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  }, [trades]);
  return <canvas ref={ref} style={{ width: '100%', height: 100, display: 'block' }} />;
}

function FlexHeatmapView({ cells, xDim, yDim, metric, onApply }: { cells: FlexHeatCell[]; xDim: ScanDimDef; yDim: ScanDimDef; metric: 'expectancy' | 'winRate' | 'totalPnl' | 'profitFactor'; onApply?: (x: number, y: number) => void }) {
  if (!cells.length) return null;
  const xVals = [...new Set(cells.map(c => c.x))].sort((a,b)=>a-b);
  const yVals = [...new Set(cells.map(c => c.y))].sort((a,b)=>a-b);
  const vals = cells.map(c => c[metric]), min = Math.min(...vals), max = Math.max(...vals), range = max-min||1;
  const getColor = (v: number, n: number) => { if (n<3) return '#1a1f2e'; const t=(v-min)/range; if(t>0.66) return `rgba(8,153,129,${0.4+t*0.6})`; if(t>0.33) return `rgba(255,196,0,${0.3+t*0.4})`; return `rgba(242,54,69,${0.4+(1-t)*0.4})`; };
  const fmt = (v: number) => metric==='winRate' ? `${v.toFixed(0)}%` : `${v>=0?'+':''}${v.toFixed(1)}${metric==='profitFactor'?'':'%'}`;
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `44px repeat(${yVals.length},1fr)`, gap: 3, minWidth: 280 }}>
        <div style={{ fontSize: 9, color: '#787B86', paddingBottom: 4 }}>{xDim.label}↓ {yDim.label}→</div>
        {yVals.map(y => <div key={y} style={{ fontSize: 9, color: '#787B86', textAlign: 'center', paddingBottom: 4 }}>{y}</div>)}
        {xVals.map(x => (
          <React.Fragment key={x}>
            <div style={{ fontSize: 9, color: '#787B86', display: 'flex', alignItems: 'center' }}>{x}</div>
            {yVals.map(y => {
              const cell = cells.find(c=>c.x===x&&c.y===y);
              if (!cell) return <div key={y} style={{ height: 38, background: '#1a1f2e', borderRadius: 4 }} />;
              const v = cell[metric];
              return (
                <div key={y} onClick={() => onApply?.(x, y)}
                  style={{ height: 38, background: getColor(v, cell.trades), borderRadius: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: onApply ? 'pointer' : 'default', border: '1px solid transparent', transition: 'border 0.15s' }}
                  title={`${xDim.label}=${x}  ${yDim.label}=${y}\n${cell.trades}筆 勝率${cell.winRate.toFixed(0)}%\n期望值${cell.expectancy.toFixed(2)}%  PF${cell.profitFactor.toFixed(2)}\n點擊套用參數`}
                  onMouseEnter={e=>(e.currentTarget.style.border='1px solid #fff')}
                  onMouseLeave={e=>(e.currentTarget.style.border='1px solid transparent')}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{fmt(v)}</span>
                  <span style={{ fontSize: 8, color: '#787B86' }}>{cell.trades}筆</span>
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      {onApply && <div style={{ fontSize: 10, color: '#787B86', marginTop: 6, textAlign: 'center' }}>點擊格子可直接套用參數 ↑</div>}
    </div>
  );
}

function SliderRow({ label, value, min, max, step, unit = '', onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: C.mut, marginBottom: 3 }}>{label} <span style={{ color: C.txt }}>{value}{unit}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} style={{ width: '100%', accentColor: C.acc }} />
    </div>
  );
}

function Tog({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return <button onClick={onClick} style={{ flex: 1, padding: '6px 4px', borderRadius: 6, border: `1px solid ${active ? color : C.brd}`, background: active ? `${color}20` : 'transparent', color: active ? color : C.mut, fontSize: 11, cursor: 'pointer', fontFamily: 'monospace', fontWeight: active ? 700 : 400 }}>{label}</button>;
}

// ─────────────────────────────────────────────────────────────────
// 主元件
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// Preset 系統
// ─────────────────────────────────────────────────────────────────
interface ParamPreset {
  id: string; name: string; createdAt: number; builtIn?: boolean;
  strategyId: StrategyId; stopPct: number; targetPct: number; days: number;
  stochP: StochParams; trendP: TrendPbParams; snrLqP: SnrLqParams;
}

const PRESET_KEY = 'qv_presets_v1';

const BUILT_IN_PRESETS: ParamPreset[] = [
  {
    id: 'builtin_snr_default', name: 'SNR+FVG 標準版', createdAt: 0, builtIn: true,
    strategyId: 'snr_fvg_lq_tc', stopPct: 1.5, targetPct: 3.0, days: 90,
    stochP: DEFAULT_STOCH,
    trendP: DEFAULT_TRENDPB,
    snrLqP: { ...DEFAULT_SNRLQ, snrStrength: 15, adxThreshold: 20 },
  },
  {
    id: 'builtin_snr_strict', name: 'SNR+FVG 嚴格版（ADX 25）', createdAt: 0, builtIn: true,
    strategyId: 'snr_fvg_lq_tc', stopPct: 1.5, targetPct: 3.0, days: 90,
    stochP: DEFAULT_STOCH,
    trendP: DEFAULT_TRENDPB,
    snrLqP: { ...DEFAULT_SNRLQ, snrStrength: 18, adxThreshold: 25, fvgFreshnessBars: 15 },
  },
  {
    id: 'builtin_trend_default', name: 'HTF Trend 標準版', createdAt: 0, builtIn: true,
    strategyId: 'trend_pullback', stopPct: 1.5, targetPct: 3.0, days: 90,
    stochP: DEFAULT_STOCH,
    trendP: { ...DEFAULT_TRENDPB, adxThreshold: 20, pullbackAtrMult: 0.6 },
    snrLqP: DEFAULT_SNRLQ,
  },
  {
    id: 'builtin_trend_aggressive', name: 'HTF Trend 積極版（RR 1:2.5）', createdAt: 0, builtIn: true,
    strategyId: 'trend_pullback', stopPct: 1.2, targetPct: 3.0, days: 90,
    stochP: DEFAULT_STOCH,
    trendP: { ...DEFAULT_TRENDPB, adxThreshold: 18, pullbackAtrMult: 0.5, ltfEma: 15 },
    snrLqP: DEFAULT_SNRLQ,
  },
];

function loadPresets(): ParamPreset[] {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch { return []; }
}
function savePresets(ps: ParamPreset[]) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(ps)); } catch {}
}


// ─────────────────────────────────────────────────────────────────
// Preset 系統
// ─────────────────────────────────────────────────────────────────
export default function BacktestPanel() {
  const [strategyId, setStrategyId] = useState<StrategyId>('stoch_snr');
  const [selectedSyms, setSelectedSyms] = useState(new Set(['BTCUSDT', 'ETHUSDT', 'ADAUSDT']));
  const [days, setDays] = useState(90);
  const [stopPct, setStop] = useState(1.5);
  const [targetPct, setTarget] = useState(3.0);
  const [stochP, setStochP] = useState<StochParams>(DEFAULT_STOCH);
  const [trendP, setTrendP] = useState<TrendPbParams>(DEFAULT_TRENDPB);
  const [snrLqP, setSnrLqP] = useState<SnrLqParams>(DEFAULT_SNRLQ);
  const [showParams, setShowParams] = useState(true);
  const [running, setRunning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [prog, setProg] = useState('');
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [heatCells, setHeatCells] = useState<FlexHeatCell[]>([]);
  const [heatMetric, setHeatMetric] = useState<'expectancy' | 'winRate' | 'totalPnl' | 'profitFactor'>('expectancy');
  const [heatXDimKey, setHeatXDimKey] = useState<ScanDimKey>('stop');
  const [heatYDimKey, setHeatYDimKey] = useState<ScanDimKey>('target');
  const [appliedHeat, setAppliedHeat] = useState<{x:number;y:number}|null>(null);
  const [showTrades, setShowTrades] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'result' | 'breakdown' | 'heatmap'>('result');
  const [klineCache, setKlineCache] = useState<Record<string, Kline[]>>({});
  const [presets, setPresets] = useState<ParamPreset[]>(() => loadPresets());
  const allPresets = [...BUILT_IN_PRESETS, ...presets];
  const [presetPanel, setPresetPanel] = useState<'save'|'load'|null>(null);
  const [presetName, setPresetName] = useState('');
  const [activePresetName, setActivePresetName] = useState<string | null>(null);
  const [chartApplied, setChartApplied] = useState(false);

  const toggleSym = (s: string) => setSelectedSyms(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const allTrades = results.flatMap(r => r.trades);
  const stats = calcStats(allTrades);

  const savePreset = () => {
    const name = presetName.trim() || `${strategyId} Stop${stopPct}/T${targetPct} ${new Date().toLocaleDateString('zh-TW')}`;
    const preset: ParamPreset = { id: Date.now().toString(), name, createdAt: Date.now(), builtIn: false, strategyId, stopPct, targetPct, days, stochP, trendP, snrLqP };
    const updated = [preset, ...presets];
    setPresets(updated); savePresets(updated); setPresetName(''); setPresetPanel(null);
  };

  const loadPreset = (p: ParamPreset) => {
    setStrategyId(p.strategyId); setStop(p.stopPct); setTarget(p.targetPct); setDays(p.days);
    setStochP(p.stochP); setTrendP(p.trendP); setSnrLqP(p.snrLqP);
    setActivePresetName(p.name);
    setPresetPanel(null);
  };

  // 把目前面板參數推給圖表（App.tsx 讀 localStorage 重算訊號）
  const CHART_PRESET_KEY = 'qv_chart_preset';
  const applyToChart = () => {
    try {
      localStorage.setItem(CHART_PRESET_KEY, JSON.stringify({
        name: activePresetName ?? '目前參數',
        strategyId, stopPct, targetPct,
        snrLqP, trendP, stochP,
        appliedAt: Date.now(),
      }));
      setChartApplied(true);
      setTimeout(() => setChartApplied(false), 2000);
    } catch {}
  };

  const deletePreset = (id: string) => {
    const updated = presets.filter(p => p.id !== id);
    setPresets(updated); savePresets(updated);
  };

  const fetchAll = async () => {
    const cache = { ...klineCache };
    for (const sym of [...selectedSyms]) { if (!cache[sym]) { setProg(`⏳ 拉取 ${sym}...`); cache[sym] = await fetchKlines(sym, days); } }
    setKlineCache(cache); return cache;
  };

  const run = async () => {
    if (!selectedSyms.size) return;
    setRunning(true); setResults([]);
    const cache = await fetchAll();
    const items: BacktestResult[] = [];
    for (const sym of [...selectedSyms]) {
      setProg(`⚙️ ${sym} 回測中...`);
      await new Promise(r => setTimeout(r, 10));
      try {
        const trades = strategyId === 'stoch_snr' ? runStochBacktest(cache[sym], stopPct, targetPct, stochP)
          : strategyId === 'trend_pullback' ? runTrendPullback(cache[sym], stopPct, targetPct, trendP)
          : runSnrLqTc(cache[sym], stopPct, targetPct, snrLqP);
        items.push({ sym, trades });
      } catch (e: any) { items.push({ sym, trades: [], error: e.message }); }
    }
    setProg(''); setRunning(false); setResults(items); setActiveTab('result');
  };

  const runHeatmap = async () => {
    if (!selectedSyms.size) return;
    const xDim = SCAN_DIMS.find(d=>d.key===heatXDimKey)!;
    const yDim = SCAN_DIMS.find(d=>d.key===heatYDimKey)!;
    if (xDim.key === yDim.key) { alert('X 和 Y 維度不能相同'); return; }
    setScanning(true); setHeatCells([]); setAppliedHeat(null);
    const cache = await fetchAll();
    const allCells: FlexHeatCell[] = [];
    for (const sym of [...selectedSyms]) {
      setProg(`🔍 掃描 ${sym}...`);
      await new Promise(r => setTimeout(r, 10));
      try {
        scanHeatmapFlex(cache[sym], xDim, yDim, stopPct, targetPct, strategyId, stochP, trendP, snrLqP).forEach(c => {
          const ex = allCells.find(e=>e.x===c.x&&e.y===c.y);
          if (ex) { ex.trades+=c.trades; ex.totalPnl+=c.totalPnl; ex.winRate=(ex.winRate+c.winRate)/2; ex.expectancy=ex.totalPnl/ex.trades; ex.profitFactor=(ex.profitFactor+c.profitFactor)/2; }
          else allCells.push({...c});
        });
      } catch(e) {}
    }
    setProg(''); setScanning(false); setHeatCells(allCells); setActiveTab('heatmap');
  };

  const applyHeatCell = (x: number, y: number) => {
    const xDim = SCAN_DIMS.find(d=>d.key===heatXDimKey)!;
    const yDim = SCAN_DIMS.find(d=>d.key===heatYDimKey)!;
    if (xDim.key==='stop') setStop(x); if (xDim.key==='target') setTarget(x);
    if (yDim.key==='stop') setStop(y); if (yDim.key==='target') setTarget(y);
    if (xDim.key==='adxThreshold') { setTrendP(p=>({...p,adxThreshold:x})); setSnrLqP(p=>({...p,adxThreshold:x})); }
    if (yDim.key==='adxThreshold') { setTrendP(p=>({...p,adxThreshold:y})); setSnrLqP(p=>({...p,adxThreshold:y})); }
    if (xDim.key==='snrStrength') setSnrLqP(p=>({...p,snrStrength:x}));
    if (yDim.key==='snrStrength') setSnrLqP(p=>({...p,snrStrength:y}));
    if (xDim.key==='pullbackAtrMult') setTrendP(p=>({...p,pullbackAtrMult:x}));
    if (yDim.key==='pullbackAtrMult') setTrendP(p=>({...p,pullbackAtrMult:y}));
    if (xDim.key==='ltfEma') setTrendP(p=>({...p,ltfEma:x}));
    if (yDim.key==='ltfEma') setTrendP(p=>({...p,ltfEma:y}));
    if (xDim.key==='lqSweepLookback') setSnrLqP(p=>({...p,lqSweepLookback:x}));
    if (yDim.key==='lqSweepLookback') setSnrLqP(p=>({...p,lqSweepLookback:y}));
    if (xDim.key==='fvgFreshnessBars') setSnrLqP(p=>({...p,fvgFreshnessBars:x}));
    if (yDim.key==='fvgFreshnessBars') setSnrLqP(p=>({...p,fvgFreshnessBars:y}));
    setAppliedHeat({x,y});
  };

  const copyReport = () => navigator.clipboard.writeText(generateReport(results, strategyId, stopPct, targetPct, days, stochP, trendP, snrLqP)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  const copyAllReports = () => {
    const parts: string[] = [];
    results.forEach(r => {
      if (!r.trades.length) return;
      const singleStats = calcStats(r.trades);
      if (!singleStats) return;
      const stratLabel = strategyId==='stoch_snr'?'StochRSI × SNR/FVG':strategyId==='trend_pullback'?'HTF Trend Pullback':'SNR + FVG + LQ / TC';
      const end = new Date().toLocaleDateString('zh-TW'), start = new Date(Date.now()-days*86400000).toLocaleDateString('zh-TW');
      const paramsBlock = buildParamsBlock(strategyId, stopPct, targetPct, stochP, trendP, snrLqP);
      parts.push([
        `══════ ${r.sym} ══════`, `策略：${stratLabel}  期間：${start}~${end}`, ...paramsBlock, '',
        `筆數：${singleStats.total}  勝率：${singleStats.winRate.toFixed(1)}%  PF：${singleStats.profitFactor.toFixed(2)}`,
        `總損益：${singleStats.totalPnl>=0?'+':''}${singleStats.totalPnl.toFixed(2)}%  期望R：${singleStats.expectancyR>=0?'+':''}${singleStats.expectancyR.toFixed(3)}R`,
        `最大回撤：-${singleStats.maxDD.toFixed(1)}%  Sharpe：${singleStats.sharpe.toFixed(2)}`,
        '', ...singleStats.setupBreakdown.map(s=>`  ${s.key}：${s.trades}筆 WR${s.winRate.toFixed(0)}% PF${s.pf.toFixed(2)} avgR${s.avgR.toFixed(2)}`),
      ].join('\n'));
    });
    const combined = generateReport(results, strategyId, stopPct, targetPct, days, stochP, trendP, snrLqP);
    const full = parts.join('\n\n') + '\n\n' + combined;
    navigator.clipboard.writeText(full).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2500); });
  };

  const STRAT_OPTIONS: { id: StrategyId; label: string; tag: string }[] = [
    { id: 'stoch_snr', label: 'StochRSI × SNR/FVG', tag: '原版' },
    { id: 'trend_pullback', label: 'HTF Trend Pullback', tag: '新' },
    { id: 'snr_fvg_lq_tc', label: 'SNR + FVG + LQ / TC', tag: '新' },
  ];

  return (
    <div style={{ background: C.bg, minHeight: '100vh', padding: '16px 14px', fontFamily: 'monospace', color: C.txt, maxWidth: 480, margin: '0 auto' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>策略回測</div>
        <div style={{ fontSize: 11, color: C.mut }}>三策略引擎 · 15m · 費用 {FEE_BPS}bps + 滑點 {SLIPPAGE_BPS}bps</div>
      </div>

      {/* ── Preset 列 ── */}
      {/* 目前使用中的參數名稱 */}
      <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: C.mut }}>使用中</span>
        <span style={{ fontSize: 12, color: '#fff', fontWeight: 700, fontFamily: 'monospace' }}>{activePresetName ?? '目前參數'}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {/* 載入：直接把目前面板參數推給 App.tsx 的即時策略 */}
        <button onClick={applyToChart}
          style={{ flex: 1, background: chartApplied ? '#08998130' : C.surf, border: `1px solid ${C.gr}`, color: C.gr, padding: '9px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace', transition: 'background 0.2s' }}>
          {chartApplied ? '✓ 已套用至圖表' : '⚡ 載入至圖表'}
        </button>
        {/* 儲存：展開儲存面板 */}
        <button onClick={() => setPresetPanel(v => v === 'save' ? null : 'save')}
          style={{ flex: 1, background: presetPanel === 'save' ? '#2962FF18' : C.surf, border: `1px solid ${presetPanel === 'save' ? C.acc : C.brd}`, color: presetPanel === 'save' ? C.acc : C.mut, padding: '9px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace' }}>
          💾 儲存
        </button>
      </div>

      {/* 儲存面板 — 存目前參數 + 列出之前存過的 */}
      {presetPanel === 'save' && (
        <div style={{ background: C.surf, border: `1px solid ${C.acc}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
          {/* 存目前 */}
          <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 6 }}>儲存目前參數</div>
          <div style={{ fontSize: 11, color: C.mut, marginBottom: 8, fontFamily: 'monospace' }}>
            {strategyId} · Stop {stopPct}% / Target {targetPct}% · ADX {strategyId === 'trend_pullback' ? trendP.adxThreshold : snrLqP.adxThreshold}
          </div>
          <input type="text" placeholder="幫這組參數命名（選填）"
            value={presetName} onChange={e => setPresetName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && savePreset()}
            style={{ ...inp, marginBottom: 8 }} />
          <button onClick={savePreset}
            style={{ width: '100%', background: C.acc, border: 'none', color: '#fff', padding: 9, borderRadius: 7, fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'monospace', marginBottom: 14 }}>
            ✓ 確認儲存
          </button>

          {/* 之前存過的 */}
          {allPresets.length > 0 && <>
            <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 8 }}>已儲存的參數</div>
            {allPresets.map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px solid ${C.brd}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: p.builtIn ? C.yl : '#fff', fontWeight: 700 }}>{p.builtIn ? '★ ' : ''}{p.name}</div>
                  <div style={{ fontSize: 10, color: C.mut, fontFamily: 'monospace' }}>{p.strategyId} · Stop {p.stopPct}% / T {p.targetPct}%</div>
                </div>
                <button onClick={() => loadPreset(p)}
                  style={{ background: 'transparent', border: `1px solid ${C.brd}`, color: C.txt, padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  套用
                </button>
                {!p.builtIn && (
                  <button onClick={() => deletePreset(p.id)}
                    style={{ background: 'transparent', border: 'none', color: C.mut, padding: '4px 6px', fontSize: 12, cursor: 'pointer' }}>✕</button>
                )}
              </div>
            ))}
          </>}
        </div>
      )}

      {/* 策略選擇 */}
      <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 6 }}>策略</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {STRAT_OPTIONS.map(s => (
          <button key={s.id} onClick={() => setStrategyId(s.id)} style={{ background: strategyId === s.id ? '#2962FF18' : C.surf, border: `1px solid ${strategyId === s.id ? C.acc : C.brd}`, color: strategyId === s.id ? C.acc : C.mut, padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', fontWeight: strategyId === s.id ? 700 : 400, textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}>
            <span>{s.label}</span>
            <span style={{ fontSize: 10, background: s.tag === '新' ? '#2962FF30' : 'transparent', color: s.tag === '新' ? C.acc : C.mut, padding: '1px 6px', borderRadius: 4 }}>{s.tag}</span>
          </button>
        ))}
      </div>

      {/* 幣種 */}
      <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 6 }}>幣種</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {SYMBOLS.map(s => (
          <button key={s} onClick={() => toggleSym(s)} style={{ flex: 1, background: selectedSyms.has(s) ? '#2962FF18' : C.surf, border: `1px solid ${selectedSyms.has(s) ? C.acc : C.brd}`, color: selectedSyms.has(s) ? C.acc : C.mut, padding: '6px 4px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: 'monospace', fontWeight: selectedSyms.has(s) ? 700 : 400 }}>
            {s.replace('USDT', '')}
          </button>
        ))}
      </div>

      {/* Stop / Target / 期間 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
        {[
          { l: '期間', el: <select style={inp} value={days} onChange={e => setDays(+e.target.value)}><option value={30}>1月</option><option value={90}>3月</option><option value={180}>6月</option></select> },
          { l: 'Stop %', el: <input style={inp} type="number" value={stopPct} step={0.5} min={0.5} max={5} onChange={e => setStop(+e.target.value)} /> },
          { l: 'Target %', el: <input style={inp} type="number" value={targetPct} step={0.5} min={1} max={10} onChange={e => setTarget(+e.target.value)} /> },
          { l: 'RR', el: <div style={{ ...inp, background: '#0a0a12', color: C.mut, textAlign: 'center' as const }}>1:{(targetPct / stopPct).toFixed(1)}</div> },
        ].map(({ l, el }) => <div key={l}><div style={{ fontSize: 9, color: C.mut, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 3 }}>{l}</div>{el}</div>)}
      </div>

      {/* 策略參數折疊 */}
      <button onClick={() => setShowParams(p => !p)} style={{ width: '100%', background: C.surf, border: `1px solid ${C.brd}`, color: C.txt, padding: '9px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span>⚙️ 策略參數</span>{showParams ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {showParams && (
        <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
          {strategyId === 'stoch_snr' && (
            <>
              <SliderRow label="StochRSI 多頭閾值（K <）" value={stochP.stochBull} min={10} max={45} step={5} onChange={v => setStochP(p => ({ ...p, stochBull: v }))} />
              <SliderRow label="StochRSI 空頭閾值（K >）" value={stochP.stochBear} min={55} max={90} step={5} onChange={v => setStochP(p => ({ ...p, stochBear: v }))} />
              <SliderRow label="SNR 距離" value={stochP.snrDist} min={0.5} max={5} step={0.5} unit="%" onChange={v => setStochP(p => ({ ...p, snrDist: v }))} />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <Tog label="做多" active={stochP.longEnabled} color={C.gr} onClick={() => setStochP(p => ({ ...p, longEnabled: !p.longEnabled }))} />
                <Tog label="做空" active={stochP.shortEnabled} color={C.rd} onClick={() => setStochP(p => ({ ...p, shortEnabled: !p.shortEnabled }))} />
                <Tog label="FVG+SNR同時" active={stochP.requireBoth} color="#FFC107" onClick={() => setStochP(p => ({ ...p, requireBoth: !p.requireBoth }))} />
                <Tog label="極端值進場" active={stochP.extremeEntry} color="#9C27B0" onClick={() => setStochP(p => ({ ...p, extremeEntry: !p.extremeEntry }))} />
              </div>
            </>
          )}
          {strategyId === 'trend_pullback' && (
            <>
              <SliderRow label="HTF 倍率（× 15m）" value={trendP.htfFactor} min={2} max={16} step={2} onChange={v => setTrendP(p => ({ ...p, htfFactor: v }))} />
              <SliderRow label="HTF Fast EMA" value={trendP.htfFastEma} min={10} max={100} step={5} onChange={v => setTrendP(p => ({ ...p, htfFastEma: v }))} />
              <SliderRow label="HTF Slow EMA" value={trendP.htfSlowEma} min={50} max={300} step={10} onChange={v => setTrendP(p => ({ ...p, htfSlowEma: v }))} />
              <SliderRow label="LTF EMA" value={trendP.ltfEma} min={5} max={50} step={5} onChange={v => setTrendP(p => ({ ...p, ltfEma: v }))} />
              <SliderRow label="ADX 門檻" value={trendP.adxThreshold} min={10} max={35} step={1} onChange={v => setTrendP(p => ({ ...p, adxThreshold: v }))} />
              <SliderRow label="Pullback ATR 倍率" value={trendP.pullbackAtrMult} min={0.2} max={2} step={0.1} onChange={v => setTrendP(p => ({ ...p, pullbackAtrMult: v }))} />
            </>
          )}
          {strategyId === 'snr_fvg_lq_tc' && (
            <>
              <SliderRow label="SNR Strength" value={snrLqP.snrStrength} min={5} max={25} step={1} onChange={v => setSnrLqP(p => ({ ...p, snrStrength: v }))} />
              <SliderRow label="ADX 門檻" value={snrLqP.adxThreshold} min={10} max={35} step={1} onChange={v => setSnrLqP(p => ({ ...p, adxThreshold: v }))} />
              <SliderRow label="FVG 最小尺寸" value={snrLqP.fvgMinSizePct} min={0.01} max={0.2} step={0.01} unit="%" onChange={v => setSnrLqP(p => ({ ...p, fvgMinSizePct: v }))} />
              <SliderRow label="Volume 門檻" value={snrLqP.volumeThreshold} min={0.8} max={2} step={0.1} onChange={v => setSnrLqP(p => ({ ...p, volumeThreshold: v }))} />
              <SliderRow label="LQ Sweep Lookback" value={snrLqP.lqSweepLookback} min={2} max={15} step={1} onChange={v => setSnrLqP(p => ({ ...p, lqSweepLookback: v }))} />
              <SliderRow label="TC Tap Window" value={snrLqP.tcTapWindow} min={1} max={10} step={1} onChange={v => setSnrLqP(p => ({ ...p, tcTapWindow: v }))} />
              <SliderRow label="FVG Freshness Bars" value={snrLqP.fvgFreshnessBars} min={5} max={50} step={5} onChange={v => setSnrLqP(p => ({ ...p, fvgFreshnessBars: v }))} />
            </>
          )}
          <button onClick={() => { setStochP(DEFAULT_STOCH); setTrendP(DEFAULT_TRENDPB); setSnrLqP(DEFAULT_SNRLQ); }} style={{ width: '100%', background: 'transparent', border: `1px solid ${C.brd}`, color: C.mut, padding: '5px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: 'monospace', marginTop: 10 }}>重置預設值</button>
        </div>
      )}

      {/* 執行按鈕 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        <button onClick={run} disabled={running || scanning} style={{ background: running ? '#1a2050' : C.acc, color: '#fff', border: 'none', padding: 11, borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: running ? 'not-allowed' : 'pointer', fontFamily: 'monospace' }}>{running ? '⏳ 回測中...' : '▶ 回測'}</button>
        <button onClick={runHeatmap} disabled={running || scanning} style={{ background: scanning ? '#1a3020' : '#089981', color: '#fff', border: 'none', padding: 11, borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: scanning ? 'not-allowed' : 'pointer', fontFamily: 'monospace' }}>{scanning ? '⏳ 掃描中...' : '🔥 Heatmap'}</button>
      </div>

      {prog && <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 7, padding: '8px 12px', fontSize: 11, color: C.mut, marginBottom: 12 }}>{prog}</div>}

      {/* Tab */}
      {(results.length > 0 || heatCells.length > 0) && (
        <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: C.surf, borderRadius: 8, padding: 3, border: `1px solid ${C.brd}` }}>
          {[{ k: 'result', l: '回測結果' }, { k: 'breakdown', l: 'Setup / Regime' }, { k: 'heatmap', l: 'Heatmap' }].map(({ k, l }) => (
            <button key={k} onClick={() => setActiveTab(k as any)} style={{ flex: 1, padding: 7, borderRadius: 6, border: 'none', background: activeTab === k ? C.acc : 'transparent', color: activeTab === k ? '#fff' : C.mut, fontSize: 11, fontWeight: activeTab === k ? 700 : 400, cursor: 'pointer', fontFamily: 'monospace' }}>{l}</button>
          ))}
        </div>
      )}

      {/* 回測結果 Tab */}
      {activeTab === 'result' && stats && (
        <div>
          <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 8 }}>整體結果</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 12 }}>
            {[
              { l: '總損益', v: `${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(1)}%`, c: stats.totalPnl >= 0 ? C.gr : C.rd },
              { l: '勝率', v: `${stats.winRate.toFixed(1)}%`, c: stats.winRate >= 50 ? C.gr : stats.winRate >= 40 ? C.yl : C.rd },
              { l: 'Profit Factor', v: stats.profitFactor.toFixed(2), c: stats.profitFactor >= 1.5 ? C.gr : stats.profitFactor >= 1 ? C.yl : C.rd },
              { l: '期望值 R', v: `${stats.expectancyR >= 0 ? '+' : ''}${stats.expectancyR.toFixed(3)}R`, c: stats.expectancyR >= 0 ? C.gr : C.rd },
              { l: '最大回撤', v: `-${stats.maxDD.toFixed(1)}%`, c: C.rd },
              { l: 'Sharpe', v: stats.sharpe.toFixed(2), c: stats.sharpe >= 1 ? C.gr : C.yl },
            ].map(({ l, v, c }) => (
              <div key={l} style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: C.mut, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 3 }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: c as string }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 4 }}>多空分析</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, color: C.mut }}>做多 {stats.longs}筆</div><div style={{ fontSize: 16, fontWeight: 700, color: C.gr }}>勝率 {stats.longWr.toFixed(0)}%</div></div>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, color: C.mut }}>做空 {stats.shorts}筆</div><div style={{ fontSize: 16, fontWeight: 700, color: C.rd }}>勝率 {stats.shortWr.toFixed(0)}%</div></div>
            </div>
          </div>
          <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>權益曲線</div>
            <EquityChart trades={allTrades} />
          </div>
          <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>月份分佈</div>
            {Object.entries(stats.byMonth).sort().map(([m, v]) => (
              <div key={m} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.brd}`, fontSize: 11 }}>
                <span>{m}</span><span style={{ color: C.mut }}>{v.total}筆</span>
                <span style={{ color: C.mut }}>{(v.wins / v.total * 100).toFixed(0)}%</span>
                <span style={{ color: v.pnl >= 0 ? C.gr : C.rd, fontWeight: 700 }}>{v.pnl >= 0 ? '+' : ''}{v.pnl.toFixed(1)}%</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 8 }}>各幣種明細</div>
          {results.map(({ sym, trades, error }) => {
            if (error || !trades.length) return <div key={sym} style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#fff', fontWeight: 700 }}>{sym}</span><span style={{ color: error ? C.rd : C.mut, fontSize: 11 }}>{error || '無訊號'}</span></div>;
            const s = calcStats(trades)!;
            return (
              <div key={sym} style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>{sym}</span><span style={{ color: s.totalPnl >= 0 ? C.gr : C.rd, fontWeight: 700 }}>{s.totalPnl >= 0 ? '+' : ''}{s.totalPnl.toFixed(1)}%</span></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 8 }}>
                  {[{ l: '勝率', v: `${s.winRate.toFixed(0)}%`, c: s.winRate >= 50 ? C.gr : s.winRate >= 40 ? C.yl : C.rd }, { l: '筆數', v: s.total, c: C.txt }, { l: '平均持倉', v: `${s.avgHours.toFixed(1)}h`, c: C.txt }].map(({ l, v, c }) => <div key={l} style={{ textAlign: 'center' }}><div style={{ fontSize: 9, color: C.mut, textTransform: 'uppercase' }}>{l}</div><div style={{ fontSize: 13, fontWeight: 700, color: c as string, marginTop: 2 }}>{v}</div></div>)}
                </div>
                <div style={{ height: 3, background: C.brd, borderRadius: 2, marginBottom: 8 }}><div style={{ height: '100%', width: `${Math.min(s.winRate, 100)}%`, background: s.winRate >= 50 ? C.gr : s.winRate >= 40 ? C.yl : C.rd, borderRadius: 2 }} /></div>
                <button onClick={() => setShowTrades(p => ({ ...p, [sym]: !p[sym] }))} style={{ background: 'none', border: `1px solid ${C.brd}`, color: C.mut, fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: 'monospace' }}>{showTrades[sym] ? '▲ 隱藏' : '▼ 交易記錄'}</button>
                {showTrades[sym] && (
                  <div style={{ marginTop: 8, maxHeight: 160, overflowY: 'auto' }}>
                    {trades.slice(-30).reverse().map((t, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.brd}`, fontSize: 10 }}>
                        <span style={{ background: t.dir === 'LONG' ? '#08998118' : '#F2364518', color: t.dir === 'LONG' ? C.gr : C.rd, padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>{t.dir}</span>
                        <span style={{ color: C.mut, fontSize: 9 }}>{t.setup}</span>
                        <span style={{ color: C.mut }}>{new Date(t.entryTime).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })}</span>
                        <span style={{ color: C.mut }}>{t.bars}根</span>
                        <span style={{ color: t.result === 'WIN' ? C.gr : C.rd, fontWeight: 700 }}>{t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
            <button onClick={copyReport} style={{ background: copied ? '#08998130' : C.surf, border: `1px solid ${copied ? C.gr : C.brd}`, color: copied ? C.gr : C.txt, padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              {copied ? <><Check size={13} />已複製</> : <><Copy size={13} />複製報告</>}
            </button>
            <button onClick={copyAllReports} style={{ background: copied ? '#08998130' : C.surf, border: `1px solid ${copied ? C.gr : C.brd}`, color: copied ? C.gr : C.acc, padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              {copied ? <><Check size={13} />已複製</> : <><Copy size={13} />全部幣種 + AI 建議</>}
            </button>
          </div>
        </div>
      )}

      {/* Setup / Regime Breakdown Tab */}
      {activeTab === 'breakdown' && stats && (
        <div>
          <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 10 }}>Setup 分類</div>
          <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
            {stats.setupBreakdown.length === 0
              ? <div style={{ color: C.mut, fontSize: 12 }}>無資料</div>
              : stats.setupBreakdown.map(s => (
                <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.brd}`, fontSize: 11 }}>
                  <span style={{ color: '#fff', fontWeight: 700, minWidth: 90 }}>{s.key}</span>
                  <span style={{ color: C.mut }}>{s.trades}筆</span>
                  <span style={{ color: s.winRate >= 50 ? C.gr : s.winRate >= 40 ? C.yl : C.rd }}>{s.winRate.toFixed(0)}%</span>
                  <span style={{ color: s.pf >= 1.5 ? C.gr : s.pf >= 1 ? C.yl : C.rd }}>PF {s.pf.toFixed(2)}</span>
                  <span style={{ color: s.avgR >= 0 ? C.gr : C.rd }}>{s.avgR >= 0 ? '+' : ''}{s.avgR.toFixed(2)}R</span>
                </div>
              ))}
          </div>
          <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 10 }}>Regime 分類</div>
          <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12 }}>
            {stats.regimeBreakdown.length === 0
              ? <div style={{ color: C.mut, fontSize: 12 }}>無資料（StochRSI 策略不追蹤 Regime）</div>
              : stats.regimeBreakdown.map(r => (
                <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.brd}`, fontSize: 11 }}>
                  <span style={{ color: r.key === 'trend_bull' ? C.gr : r.key === 'trend_bear' ? C.rd : C.yl, fontWeight: 700, minWidth: 90 }}>{r.key}</span>
                  <span style={{ color: C.mut }}>{r.trades}筆</span>
                  <span style={{ color: r.winRate >= 50 ? C.gr : r.winRate >= 40 ? C.yl : C.rd }}>{r.winRate.toFixed(0)}%</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Heatmap Tab */}
      {activeTab === 'heatmap' && (
        <div>
          {/* 維度選擇器 */}
          <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 8 }}>掃描維度</div>
            {(['X 軸（列）', 'Y 軸（欄）'] as const).map((label, li) => {
              const curKey = li === 0 ? heatXDimKey : heatYDimKey;
              const setter = li === 0 ? setHeatXDimKey : setHeatYDimKey;
              const availDims = SCAN_DIMS.filter(d => d.strategies.includes(strategyId));
              return (
                <div key={label} style={{ marginBottom: li===0?8:0 }}>
                  <div style={{ fontSize: 10, color: C.mut, marginBottom: 4 }}>{label}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {availDims.map(d => (
                      <button key={d.key} onClick={() => setter(d.key)}
                        style={{ padding: '4px 8px', borderRadius: 5, border: `1px solid ${curKey===d.key ? C.acc : C.brd}`, background: curKey===d.key ? '#2962FF18' : 'transparent', color: curKey===d.key ? C.acc : C.mut, fontSize: 10, cursor: 'pointer', fontFamily: 'monospace' }}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {appliedHeat && (
            <div style={{ background: '#08998120', border: `1px solid ${C.gr}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 11, color: C.gr }}>
              ✓ 已套用：{SCAN_DIMS.find(d=>d.key===heatXDimKey)?.label}={appliedHeat.x}  {SCAN_DIMS.find(d=>d.key===heatYDimKey)?.label}={appliedHeat.y}
            </div>
          )}

          {heatCells.length > 0 ? (
            <>
              <div style={{ fontSize: 10, color: C.mut, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 8 }}>結果</div>
              <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
                {([{ k: 'expectancy', l: '期望值' }, { k: 'winRate', l: '勝率' }, { k: 'totalPnl', l: '總損益' }, { k: 'profitFactor', l: 'PF' }] as const).map(({ k, l }) => (
                  <button key={k} onClick={() => setHeatMetric(k as any)} style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${heatMetric===k ? C.acc : C.brd}`, background: heatMetric===k ? '#2962FF18' : C.surf, color: heatMetric===k ? C.acc : C.mut, fontSize: 11, cursor: 'pointer', fontFamily: 'monospace' }}>{l}</button>
                ))}
              </div>
              <div style={{ background: C.surf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12 }}>
                <FlexHeatmapView
                  cells={heatCells}
                  xDim={SCAN_DIMS.find(d=>d.key===heatXDimKey)!}
                  yDim={SCAN_DIMS.find(d=>d.key===heatYDimKey)!}
                  metric={heatMetric}
                  onApply={applyHeatCell}
                />
              </div>
              <div style={{ fontSize: 10, color: C.mut, marginTop: 8, textAlign: 'center' }}>🟢 好　🟡 普通　🔴 差　灰色 = 樣本不足</div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: C.mut, padding: '30px 0', fontSize: 13 }}>選好維度後按「🔥 Heatmap」開始掃描</div>
          )}
        </div>
      )}

      {activeTab === 'result' && !stats && !running && (
        <div style={{ textAlign: 'center', color: C.mut, padding: '40px 0', fontSize: 13 }}>選好策略、幣種和參數後按「▶ 回測」開始</div>
      )}
    </div>
  );
}
