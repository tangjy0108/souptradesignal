// SNR+FVG 流動性獵取策略
// 完全對應 Pine Script "SNR+有效FVG策略 v40.0"

export type SNRLevel = {
  wickY: number;       // 影線水平（ta.pivothigh/low 的值）
  bodyY: number;       // 實體水平（open/close 的邊緣）
  isRes: boolean;      // true=壓力, false=支撐
  startBar: number;    // 形成位置
  bodyEnd: number;     // 實體線延伸到這根
  bodyActive: boolean; // 實體線還有效
  wickActive: boolean; // 影線還有效
};

export type FVGZone = {
  top: number;
  bottom: number;
  isBull: boolean;
  startBar: number;
  active: boolean;
};

export type LQSignal = {
  direction: 'LONG' | 'SHORT';
  entry: number;       // 收盤價
  stop: number;        // K棒極值
  target: number;      // 1:1 RR
  rr: number;          // 永遠接近 1.0
  source: 'SNR' | 'FVG' | 'SNR+FVG';
  barIndex: number;
};

export type SNRFVGResult = {
  signal: LQSignal | null;
  snrLevels: SNRLevel[];
  fvgZones: FVGZone[];
  inBull: boolean;
  inBear: boolean;
};

interface Kline {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Pine Script: ta.pivothigh(high, str, str)
// 找左右各 str 根都比它低的高點
function findPivotHighs(klines: Kline[], str: number): number[] {
  const result: number[] = [];
  for (let i = str; i < klines.length - str; i++) {
    let isPivot = true;
    for (let k = i - str; k <= i + str; k++) {
      if (k !== i && klines[k].high >= klines[i].high) { isPivot = false; break; }
    }
    if (isPivot) result.push(i);
  }
  return result;
}

// Pine Script: ta.pivotlow(low, str, str)
function findPivotLows(klines: Kline[], str: number): number[] {
  const result: number[] = [];
  for (let i = str; i < klines.length - str; i++) {
    let isPivot = true;
    for (let k = i - str; k <= i + str; k++) {
      if (k !== i && klines[k].low <= klines[i].low) { isPivot = false; break; }
    }
    if (isPivot) result.push(i);
  }
  return result;
}

// 計算 SMA
function sma(arr: number[], period: number): number[] {
  return arr.map((_, i) => {
    if (i < period - 1) return 0;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

export function detectSNRFVG(
  klines: Kline[],
  snrStr = 15,
  fvgMinPct = 0.05,
  volThr = 1.1,
  sigGap = 3,
  gracePeriod = 5,
): SNRFVGResult {
  const n = klines.length;
  if (n < snrStr * 2 + 10) return { signal: null, snrLevels: [], fvgZones: [], inBull: false, inBear: false };

  const volumes = klines.map(k => k.volume);
  const volMA = sma(volumes, 20);

  // ── 建立 SNR 區域 ──
  const snrLevels: SNRLevel[] = [];
  const pivotHighs = findPivotHighs(klines, snrStr);
  const pivotLows  = findPivotLows(klines, snrStr);

  for (const pi of pivotHighs) {
    const ph = klines[pi].high;
    // bodyY = max(open, close) 在 pivot 那根
    const bt = Math.max(klines[pi].open, klines[pi].close);
    let bodyEnd = n - 1;
    let bodyActive = true;
    // 防穿透：往右掃描看有沒有K棒穿過 bodyY
    if (snrStr > 3) {
      for (let k = pi + 1; k < Math.min(pi + snrStr * 3, n); k++) {
        if (klines[k].high >= bt && klines[k].low <= bt) {
          bodyEnd = k; bodyActive = false; break;
        }
      }
    }
    snrLevels.push({
      wickY: ph, bodyY: bt, isRes: true,
      startBar: pi, bodyEnd, bodyActive, wickActive: true,
    });
  }

  for (const pi of pivotLows) {
    const pl = klines[pi].low;
    const bb = Math.min(klines[pi].open, klines[pi].close);
    let bodyEnd = n - 1;
    let bodyActive = true;
    if (snrStr > 3) {
      for (let k = pi + 1; k < Math.min(pi + snrStr * 3, n); k++) {
        if (klines[k].high >= bb && klines[k].low <= bb) {
          bodyEnd = k; bodyActive = false; break;
        }
      }
    }
    snrLevels.push({
      wickY: pl, bodyY: bb, isRes: false,
      startBar: pi, bodyEnd, bodyActive, wickActive: true,
    });
  }

  // ── 建立 FVG 區域 ──
  const fvgZones: FVGZone[] = [];
  for (let i = 2; i < n; i++) {
    const curr = klines[i], prev2 = klines[i - 2];
    const vol1 = klines[i - 1].volume;
    const vma  = volMA[i - 1];

    // 多頭 FVG: 當根低點 > 兩根前高點
    if (curr.low > prev2.high) {
      const gap = curr.low - prev2.high;
      if (gap > curr.close * fvgMinPct / 100 && vol1 > vma * volThr) {
        fvgZones.push({ top: curr.low, bottom: prev2.high, isBull: true, startBar: i, active: true });
      }
    }
    // 空頭 FVG: 當根高點 < 兩根前低點
    if (curr.high < prev2.low) {
      const gap = prev2.low - curr.high;
      if (gap > curr.close * fvgMinPct / 100 && vol1 > vma * volThr) {
        fvgZones.push({ top: prev2.low, bottom: curr.high, isBull: false, startBar: i, active: true });
      }
    }
  }

  // ── 逐根模擬過濾（對應 Pine Script section 4）──
  // 找當下有效的 SNR 和 FVG
  const last = klines[n - 1];
  let inBull = false, inBear = false;

  // SNR 過濾
  const activeSNR: SNRLevel[] = [];
  for (const s of snrLevels) {
    if (s.bodyY === 0) continue;
    const bHit = last.high >= s.bodyY && last.low <= s.bodyY;
    const bBrk = s.isRes ? last.close > s.bodyY : last.close < s.bodyY;
    if (bHit && !bBrk) {
      if (s.isRes) inBear = true; else inBull = true;
    }
    if (!bHit && !bBrk) activeSNR.push(s);
  }

  // FVG 過濾
  const activeFVG: FVGZone[] = [];
  for (const f of fvgZones) {
    if (!f.active) continue;
    const fHit = last.high >= f.bottom && last.low <= f.top;
    const fBrk = f.isBull ? last.close < f.bottom : last.close > f.top;
    if (fHit && !fBrk) {
      if (f.isBull) inBull = true; else inBear = true;
    }
    if (!fHit && !fBrk) activeFVG.push(f);
  }

  // ── LQ 獵取訊號（對應 Pine Script section 5）──
  // 找最後 sigGap 根內有沒有訊號
  let signal: LQSignal | null = null;

  for (let i = n - 1; i >= Math.max(1, n - sigGap - 1); i--) {
    const curr2 = klines[i];
    const prev  = klines[i - 1];

    // 做多：前一根陰線，當根陽線，且在多頭 SNR/FVG 區域
    const lqBull = inBull &&
      prev.close < prev.open &&           // 前一根陰線（假跌破）
      curr2.close > curr2.open &&         // 當根陽線（反轉）
      curr2.low < prev.low;               // 有獵取低點流動性

    // 做空：前一根陽線，當根陰線，且在空頭 SNR/FVG 區域
    const lqBear = inBear &&
      prev.close > prev.open &&           // 前一根陽線（假突破）
      curr2.close < curr2.open &&         // 當根陰線（反轉）
      curr2.high > prev.high;             // 有獵取高點流動性

    if (lqBull && i === n - 1) {
      const entry = curr2.close;
      const stop  = curr2.low;
      const risk  = entry - stop;
      const source: LQSignal['source'] = (inBull && activeFVG.some(f => f.isBull)) ? 'SNR+FVG' : activeFVG.some(f => f.isBull) ? 'FVG' : 'SNR';
      signal = { direction: 'LONG', entry, stop, target: entry + risk, rr: 1.0, source, barIndex: i };
      break;
    }
    if (lqBear && i === n - 1) {
      const entry = curr2.close;
      const stop  = curr2.high;
      const risk  = stop - entry;
      const source: LQSignal['source'] = (inBear && activeFVG.some(f => !f.isBull)) ? 'SNR+FVG' : activeFVG.some(f => !f.isBull) ? 'FVG' : 'SNR';
      signal = { direction: 'SHORT', entry, stop, target: entry - risk, rr: 1.0, source, barIndex: i };
      break;
    }
  }

  return {
    signal,
    snrLevels: activeSNR,
    fvgZones: activeFVG,
    inBull,
    inBear,
  };
}
