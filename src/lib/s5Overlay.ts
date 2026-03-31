export type S5Candle = {
  time: number;
  timeKey: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type S5BosMark = {
  timeKey: string;
  price: number;
  side: 'bull' | 'bear';
  breakoutLevel: number;
};

export type S5FvgZone = {
  id: string;
  side: 'bull' | 'bear';
  startTimeKey: string;
  endTimeKey: string;
  y1: number;
  y2: number;
  formedAt: number;
  expiresAt: number;
  ageBars: number;
};

export type S5OverlayResult = {
  bosMarks: S5BosMark[];
  fvgZones: S5FvgZone[];
  currentSwingHigh: number | null;
  currentSwingLow: number | null;
  activeBullFvgCount: number;
  activeBearFvgCount: number;
  lastBosMark: S5BosMark | null;
};

type RawZone = {
  side: 'bull' | 'bear';
  startIndex: number;
  expireIndex: number;
  y1: number;
  y2: number;
};

function isSwingHigh(data: S5Candle[], pivotIndex: number, lookback: number) {
  const pivotHigh = data[pivotIndex].high;
  for (let i = pivotIndex - lookback; i <= pivotIndex + lookback; i += 1) {
    if (i === pivotIndex) continue;
    if (data[i].high >= pivotHigh) return false;
  }
  return true;
}

function isSwingLow(data: S5Candle[], pivotIndex: number, lookback: number) {
  const pivotLow = data[pivotIndex].low;
  for (let i = pivotIndex - lookback; i <= pivotIndex + lookback; i += 1) {
    if (i === pivotIndex) continue;
    if (data[i].low <= pivotLow) return false;
  }
  return true;
}

export function computeS5Overlay(
  data: S5Candle[],
  lookback = 10,
  fvgWindow = 20,
  maxZones = 20,
  maxBosMarks = 30,
): S5OverlayResult {
  const n = data.length;
  if (n < lookback * 2 + 3) {
    return {
      bosMarks: [],
      fvgZones: [],
      currentSwingHigh: null,
      currentSwingLow: null,
      activeBullFvgCount: 0,
      activeBearFvgCount: 0,
      lastBosMark: null,
    };
  }

  const bosMarks: S5BosMark[] = [];
  const zones: RawZone[] = [];

  let currentSwingHigh: number | null = null;
  let currentSwingLow: number | null = null;

  for (let i = Math.max(lookback, 2); i < n; i += 1) {
    const pivotIndex = i - lookback;
    if (pivotIndex >= lookback && pivotIndex + lookback < n) {
      if (isSwingHigh(data, pivotIndex, lookback)) {
        currentSwingHigh = data[pivotIndex].high;
      }
      if (isSwingLow(data, pivotIndex, lookback)) {
        currentSwingLow = data[pivotIndex].low;
      }
    }

    if (i >= 2) {
      if (data[i - 2].high < data[i].low) {
        zones.push({
          side: 'bull',
          startIndex: i,
          expireIndex: Math.min(n - 1, i + fvgWindow),
          y1: data[i - 2].high,
          y2: data[i].low,
        });
      }

      if (data[i - 2].low > data[i].high) {
        zones.push({
          side: 'bear',
          startIndex: i,
          expireIndex: Math.min(n - 1, i + fvgWindow),
          y1: data[i].high,
          y2: data[i - 2].low,
        });
      }
    }

    const prevClose = i > 0 ? data[i - 1].close : NaN;
    const bosBull = currentSwingHigh !== null && prevClose <= currentSwingHigh && data[i].close > currentSwingHigh;
    const bosBear = currentSwingLow !== null && prevClose >= currentSwingLow && data[i].close < currentSwingLow;

    if (bosBull) {
      bosMarks.push({
        timeKey: data[i].timeKey,
        price: data[i].close,
        side: 'bull',
        breakoutLevel: currentSwingHigh!,
      });
    }

    if (bosBear) {
      bosMarks.push({
        timeKey: data[i].timeKey,
        price: data[i].close,
        side: 'bear',
        breakoutLevel: currentSwingLow!,
      });
    }
  }

  const latestIndex = n - 1;
  const activeZones = zones
    .filter(zone => latestIndex <= zone.expireIndex)
    .slice(-maxZones)
    .map((zone, index) => ({
      id: `s5-${zone.side}-${zone.startIndex}-${index}`,
      side: zone.side,
      startTimeKey: data[zone.startIndex].timeKey,
      endTimeKey: data[latestIndex].timeKey,
      y1: Math.min(zone.y1, zone.y2),
      y2: Math.max(zone.y1, zone.y2),
      formedAt: data[zone.startIndex].time,
      expiresAt: data[zone.expireIndex].time,
      ageBars: latestIndex - zone.startIndex,
    }));

  const trimmedBosMarks = bosMarks.slice(-maxBosMarks);

  return {
    bosMarks: trimmedBosMarks,
    fvgZones: activeZones,
    currentSwingHigh,
    currentSwingLow,
    activeBullFvgCount: activeZones.filter(zone => zone.side === 'bull').length,
    activeBearFvgCount: activeZones.filter(zone => zone.side === 'bear').length,
    lastBosMark: trimmedBosMarks[trimmedBosMarks.length - 1] || null,
  };
}
