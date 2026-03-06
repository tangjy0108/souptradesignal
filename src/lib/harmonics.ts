// ── 諧波形態偵測 v2 ──
// 10種形態、多形態輸出、生命週期、綜合評分

export type PatternStatus = 'NEW' | 'ACTIVE' | 'PRZ_TOUCHED' | 'CONFIRMED';

export type HarmonicPattern = {
  name: string;
  direction: 'LONG' | 'SHORT';
  X: { index: number; price: number };
  A: { index: number; price: number };
  B: { index: number; price: number };
  C: { index: number; price: number };
  D: { index: number; price: number };
  prz_low: number;
  prz_high: number;
  invalidation: number;
  target1: number;
  target2: number;
  target3: number;
  stop: number;
  rr: number;
  quality: number;
  status: PatternStatus;
  rsiBull?: boolean;
  rsiBear?: boolean;
  reversalCandle?: boolean;
  score: number;
};

type Point = { index: number; price: number };

const RANGE_BUFFER = 0.10;
const SINGLE_TOL   = 0.10;

function inRange(val: number, min: number, max: number): boolean {
  if (min === max) return val >= min * (1 - SINGLE_TOL) && val <= max * (1 + SINGLE_TOL);
  return val >= min * (1 - RANGE_BUFFER) && val <= max * (1 + RANGE_BUFFER);
}

function qualityScore(val: number, ideal: number): number {
  const diff = Math.abs(val - ideal) / ideal;
  return Math.max(0, 100 - diff * 200);
}

const PATTERNS = [
  { name: 'Gartley',    AB_XA: { min: 0.618, max: 0.618, ideal: 0.618 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.618 }, CD_BC: { min: 1.272, max: 1.618, ideal: 1.272 }, AD_XA: { min: 0.786, max: 0.786, ideal: 0.786 }, usesXC: false },
  { name: 'Deep Gartley', AB_XA: { min: 0.618, max: 0.786, ideal: 0.786 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.618 }, CD_BC: { min: 1.272, max: 1.618, ideal: 1.272 }, AD_XA: { min: 0.886, max: 0.886, ideal: 0.886 }, usesXC: false },
  { name: 'Bat',        AB_XA: { min: 0.382, max: 0.500, ideal: 0.382 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.500 }, CD_BC: { min: 1.618, max: 2.618, ideal: 2.000 }, AD_XA: { min: 0.886, max: 0.886, ideal: 0.886 }, usesXC: false },
  { name: 'Alt Bat',    AB_XA: { min: 0.382, max: 0.382, ideal: 0.382 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.618 }, CD_BC: { min: 2.000, max: 3.618, ideal: 2.618 }, AD_XA: { min: 1.130, max: 1.130, ideal: 1.130 }, usesXC: false },
  { name: 'Butterfly',  AB_XA: { min: 0.786, max: 0.786, ideal: 0.786 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.618 }, CD_BC: { min: 1.618, max: 2.618, ideal: 1.618 }, AD_XA: { min: 1.272, max: 1.618, ideal: 1.272 }, usesXC: false },
  { name: 'Crab',       AB_XA: { min: 0.382, max: 0.618, ideal: 0.382 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.618 }, CD_BC: { min: 2.240, max: 3.618, ideal: 3.618 }, AD_XA: { min: 1.618, max: 1.618, ideal: 1.618 }, usesXC: false },
  { name: 'Deep Crab',  AB_XA: { min: 0.886, max: 0.886, ideal: 0.886 }, BC_AB: { min: 0.382, max: 0.886, ideal: 0.618 }, CD_BC: { min: 2.000, max: 3.618, ideal: 2.618 }, AD_XA: { min: 1.618, max: 1.618, ideal: 1.618 }, usesXC: false },
  { name: 'Cypher',     AB_XA: { min: 0.382, max: 0.618, ideal: 0.500 }, BC_AB: { min: 1.130, max: 1.414, ideal: 1.272 }, CD_BC: { min: 0.786, max: 0.786, ideal: 0.786 }, AD_XA: { min: 0.786, max: 0.786, ideal: 0.786 }, usesXC: true },
  { name: 'Shark 886',  AB_XA: { min: 0.446, max: 0.618, ideal: 0.500 }, BC_AB: { min: 1.130, max: 1.618, ideal: 1.272 }, CD_BC: { min: 0.886, max: 0.886, ideal: 0.886 }, AD_XA: { min: 0.886, max: 0.886, ideal: 0.886 }, usesXC: true },
  { name: 'Shark 113',  AB_XA: { min: 0.446, max: 0.618, ideal: 0.500 }, BC_AB: { min: 1.130, max: 1.618, ideal: 1.272 }, CD_BC: { min: 1.130, max: 1.130, ideal: 1.130 }, AD_XA: { min: 1.130, max: 1.130, ideal: 1.130 }, usesXC: true },
];

function checkPattern(pattern: typeof PATTERNS[0], X: Point, A: Point, B: Point, C: Point, D: Point): number | null {
  const XA = Math.abs(A.price - X.price);
  const AB = Math.abs(B.price - A.price);
  const BC = Math.abs(C.price - B.price);
  const CD = Math.abs(D.price - C.price);
  const AD = Math.abs(D.price - A.price);
  const XC = Math.abs(C.price - X.price);
  if (XA === 0 || AB === 0 || BC === 0 || XC === 0) return null;
  const ab_xa    = AB / XA;
  const bc_ab    = BC / AB;
  const ad_xa    = AD / XA;
  const cd_ratio = pattern.usesXC ? CD / XC : CD / BC;
  if (!inRange(ab_xa,    pattern.AB_XA.min, pattern.AB_XA.max)) return null;
  if (!inRange(bc_ab,    pattern.BC_AB.min, pattern.BC_AB.max)) return null;
  if (!inRange(cd_ratio, pattern.CD_BC.min, pattern.CD_BC.max)) return null;
  if (!inRange(ad_xa,    pattern.AD_XA.min, pattern.AD_XA.max)) return null;
  return (qualityScore(ab_xa, pattern.AB_XA.ideal) + qualityScore(bc_ab, pattern.BC_AB.ideal) +
          qualityScore(cd_ratio, pattern.CD_BC.ideal) + qualityScore(ad_xa, pattern.AD_XA.ideal)) / 4;
}

function findSwingPoints(klines: { high: number; low: number }[], lookback = 3): { highs: Point[]; lows: Point[] } {
  const highs: Point[] = [], lows: Point[] = [];
  for (let i = lookback; i < klines.length - lookback; i++) {
    const s = klines.slice(i - lookback, i + lookback + 1);
    if (s.every((k, idx) => idx === lookback || k.high <= klines[i].high)) highs.push({ index: i, price: klines[i].high });
    if (s.every((k, idx) => idx === lookback || k.low  >= klines[i].low))  lows.push({ index: i, price: klines[i].low  });
  }
  return { highs, lows };
}

function detectRsiDivergence(klines: { high: number; low: number }[], rsi: number[], direction: 'LONG' | 'SHORT', lookback = 20): boolean {
  const n = klines.length;
  if (rsi.length < n || n < lookback + 2) return false;
  const rK = klines.slice(n - lookback), rR = rsi.slice(n - lookback);
  const mid = Math.floor(lookback / 2);
  if (direction === 'LONG') {
    let p1 = Infinity, p2 = Infinity, r1 = Infinity, r2 = Infinity;
    for (let i = 0; i < mid; i++)      if (rK[i].low < p1) { p1 = rK[i].low; r1 = rR[i]; }
    for (let i = mid; i < lookback; i++) if (rK[i].low < p2) { p2 = rK[i].low; r2 = rR[i]; }
    return p2 < p1 && r2 > r1;
  } else {
    let p1 = -Infinity, p2 = -Infinity, r1 = -Infinity, r2 = -Infinity;
    for (let i = 0; i < mid; i++)      if (rK[i].high > p1) { p1 = rK[i].high; r1 = rR[i]; }
    for (let i = mid; i < lookback; i++) if (rK[i].high > p2) { p2 = rK[i].high; r2 = rR[i]; }
    return p2 > p1 && r2 < r1;
  }
}

function detectReversalCandle(klines: { open: number; high: number; low: number; close: number }[], direction: 'LONG' | 'SHORT'): boolean {
  const n = klines.length;
  if (n < 2) return false;
  const k = klines[n - 1], k1 = klines[n - 2];
  const body = Math.abs(k.close - k.open), range = k.high - k.low;
  if (range === 0) return false;
  const lo = Math.min(k.close, k.open) - k.low;
  const hi = k.high - Math.max(k.close, k.open);
  if (direction === 'LONG') {
    const hammer  = lo >= body * 2 && hi <= body * 0.5;
    const engulf  = k.close > k.open && k1.close < k1.open && k.close > k1.open && k.open < k1.close;
    const pinBar  = lo / range >= 0.6 && k.close > k.open;
    return hammer || engulf || pinBar;
  } else {
    const star   = hi >= body * 2 && lo <= body * 0.5;
    const engulf = k.close < k.open && k1.close > k1.open && k.close < k1.open && k.open > k1.close;
    const pinBar = hi / range >= 0.6 && k.close < k.open;
    return star || engulf || pinBar;
  }
}

function calcStatus(hp: Omit<HarmonicPattern, 'status' | 'score'>, currentPrice: number): PatternStatus {
  const { prz_low, prz_high, C, direction } = hp;
  const przMid = (prz_low + prz_high) / 2;
  const activationDist = Math.abs(C.price - przMid) * 0.5;
  const inPrz   = currentPrice >= prz_low && currentPrice <= prz_high;
  const nearPrz = direction === 'LONG' ? currentPrice <= przMid + activationDist : currentPrice >= przMid - activationDist;
  if (inPrz) return (hp.rsiBull || hp.rsiBear || hp.reversalCandle) ? 'CONFIRMED' : 'PRZ_TOUCHED';
  if (nearPrz) return 'ACTIVE';
  return 'NEW';
}

function calcScore(hp: Omit<HarmonicPattern, 'score' | 'status'>, status: PatternStatus): number {
  let s = hp.quality * 0.30;
  if (status === 'ACTIVE')      s += 15;
  if (status === 'PRZ_TOUCHED') s += 25;
  if (status === 'CONFIRMED')   s += 30;
  if (hp.rsiBull || hp.rsiBear) s += 25;
  if (hp.reversalCandle)        s += 15;
  return Math.min(Math.round(s), 100);
}

export function detectHarmonics(
  klines: { open: number; high: number; low: number; close: number }[],
  rsi?: number[]
): HarmonicPattern[] {
  if (klines.length < 50) return [];
  const { highs, lows } = findSwingPoints(klines, 3);
  const currentPrice = klines[klines.length - 1].close;
  const results: HarmonicPattern[] = [];

  const build = (pattern: typeof PATTERNS[0], X: Point, A: Point, B: Point, C: Point, D: Point, dir: 'LONG' | 'SHORT', quality: number): HarmonicPattern => {
    const DA = Math.abs(A.price - D.price);
    const CD = Math.abs(D.price - C.price);
    // PRZ：D 點附近的入場確認區（上下各 5%）
    const przRange = CD * 0.1;
    const prz_low  = D.price - przRange;
    const prz_high = D.price + przRange;
    const invalidation = C.price;
    // Stop 必須在 Entry（D點）的不利方向
    // LONG: stop < D.price；SHORT: stop > D.price
    const stopBuffer = CD * 0.15;
    const rawStop = dir === 'LONG' ? D.price - stopBuffer : D.price + stopBuffer;
    // Target 必須在 Entry 的有利方向
    const rawT1 = dir === 'LONG' ? D.price + DA * 0.382 : D.price - DA * 0.382;
    const rawT2 = dir === 'LONG' ? D.price + DA * 0.618 : D.price - DA * 0.618;
    // 方向驗證：如果算出來方向反了，跳過這個形態（返回 null 表示無效）
    const stopOk  = dir === 'LONG' ? rawStop < D.price : rawStop > D.price;
    const targetOk = dir === 'LONG' ? rawT1 > D.price && rawT2 > D.price : rawT1 < D.price && rawT2 < D.price;
    const stop   = stopOk  ? rawStop : (dir === 'LONG' ? D.price - Math.abs(DA) * 0.1 : D.price + Math.abs(DA) * 0.1);
    const target1 = targetOk ? rawT1 : (dir === 'LONG' ? D.price + Math.abs(DA) * 0.382 : D.price - Math.abs(DA) * 0.382);
    const target2 = targetOk ? rawT2 : (dir === 'LONG' ? D.price + Math.abs(DA) * 0.618 : D.price - Math.abs(DA) * 0.618);
    const target3 = B.price;
    const rr = Math.abs(target2 - D.price) / Math.max(Math.abs(D.price - stop), 0.001);
    const rsiBull        = dir === 'LONG'  && !!rsi && detectRsiDivergence(klines, rsi, 'LONG');
    const rsiBear        = dir === 'SHORT' && !!rsi && detectRsiDivergence(klines, rsi, 'SHORT');
    const reversalCandle = detectReversalCandle(klines, dir);
    const base = { name: pattern.name, direction: dir, X, A, B, C, D, prz_low, prz_high, invalidation, target1, target2, target3, stop, rr: Math.max(rr, 0), quality, rsiBull, rsiBear, reversalCandle };
    const status = calcStatus(base, currentPrice);
    const score  = calcScore(base, status);
    return { ...base, status, score };
  };

  // 看多
  for (let xi = 0; xi < highs.length - 1; xi++) {
    for (let ai = 0; ai < lows.length; ai++) {
      const X = highs[xi], A = lows[ai];
      if (A.index <= X.index || A.price >= X.price) continue;
      for (let bi = xi + 1; bi < highs.length; bi++) {
        const B = highs[bi];
        if (B.index <= A.index || B.price >= X.price || B.price <= A.price) continue;
        for (let ci = ai + 1; ci < lows.length; ci++) {
          const C = lows[ci];
          if (C.index <= B.index || C.price >= B.price || C.price <= A.price) continue;
          for (let di = ci + 1; di < lows.length; di++) {
            const D = lows[di];
            if (D.index <= C.index || D.price >= C.price || di < lows.length - 5) continue;
            for (const p of PATTERNS) {
              const q = checkPattern(p, X, A, B, C, D);
              if (q !== null && q >= 55) results.push(build(p, X, A, B, C, D, 'LONG', q));
            }
          }
        }
      }
    }
  }

  // 看空
  for (let xi = 0; xi < lows.length - 1; xi++) {
    for (let ai = 0; ai < highs.length; ai++) {
      const X = lows[xi], A = highs[ai];
      if (A.index <= X.index || A.price <= X.price) continue;
      for (let bi = xi + 1; bi < lows.length; bi++) {
        const B = lows[bi];
        if (B.index <= A.index || B.price <= X.price || B.price >= A.price) continue;
        for (let ci = ai + 1; ci < highs.length; ci++) {
          const C = highs[ci];
          if (C.index <= B.index || C.price <= B.price || C.price >= A.price) continue;
          for (let di = ci + 1; di < highs.length; di++) {
            const D = highs[di];
            if (D.index <= C.index || D.price <= C.price || di < highs.length - 5) continue;
            for (const p of PATTERNS) {
              const q = checkPattern(p, X, A, B, C, D);
              if (q !== null && q >= 55) results.push(build(p, X, A, B, C, D, 'SHORT', q));
            }
          }
        }
      }
    }
  }

  // 去重 + 排序
  const deduped = new Map<string, HarmonicPattern>();
  for (const hp of results) {
    const key = `${hp.name}_${hp.direction}`;
    if (!deduped.has(key) || hp.score > deduped.get(key)!.score) deduped.set(key, hp);
  }
  return Array.from(deduped.values()).sort((a, b) => b.score - a.score).slice(0, 3);
}
