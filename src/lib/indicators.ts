import { Kline } from '../hooks/useKlines';

export function calculateSMA(data: number[], period: number): number[] {
  const sma = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma[i] = sum / period;
  }
  return sma;
}

export function calculateEMA(data: number[], period: number): number[] {
  const ema = new Array(data.length).fill(null);
  if (data.length < period) return ema;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

export function calculateRSI(data: number[], period: number = 14): number[] {
  const rsi = new Array(data.length).fill(null);
  if (data.length < period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

export function calculateMACD(data: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastEMA = calculateEMA(data, fastPeriod);
  const slowEMA = calculateEMA(data, slowPeriod);

  const macdLine = new Array(data.length).fill(null);
  for (let i = 0; i < data.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
  }

  // Calculate Signal Line (EMA of MACD Line)
  const validMacdLine = macdLine.filter(val => val !== null);
  const signalEMA = calculateEMA(validMacdLine, signalPeriod);
  
  const signalLine = new Array(data.length).fill(null);
  const offset = data.length - validMacdLine.length;
  for (let i = 0; i < signalEMA.length; i++) {
    signalLine[i + offset] = signalEMA[i];
  }

  const histogram = new Array(data.length).fill(null);
  for (let i = 0; i < data.length; i++) {
    if (macdLine[i] !== null && signalLine[i] !== null) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  return { macdLine, signalLine, histogram };
}

export function calculateBollingerBands(data: number[], period: number = 20, stdDev: number = 2) {
  const sma = calculateSMA(data, period);
  const upper = new Array(data.length).fill(null);
  const lower = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = sma[i];
    const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = mean + stdDev * std;
    lower[i] = mean - stdDev * std;
  }

  return { upper, lower, middle: sma };
}

export function calculateATR(high: number[], low: number[], close: number[], period: number = 14): number[] {
  const atr = new Array(close.length).fill(null);
  const tr = new Array(close.length).fill(0);
  
  for (let i = 1; i < close.length; i++) {
    tr[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;

  for (let i = period + 1; i < close.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  
  return atr;
}

export function calculateADX(high: number[], low: number[], close: number[], period: number = 14): number[] {
  const adx = new Array(close.length).fill(null);
  const plusDM = new Array(close.length).fill(0);
  const minusDM = new Array(close.length).fill(0);
  const tr = new Array(close.length).fill(0);

  for (let i = 1; i < close.length; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }

  const smooth = (data: number[], p: number) => {
    const res = new Array(data.length).fill(null);
    let sum = 0;
    for (let i = 1; i <= p; i++) sum += data[i];
    res[p] = sum;
    for (let i = p + 1; i < data.length; i++) {
      res[i] = res[i - 1] - (res[i - 1] / p) + data[i];
    }
    return res;
  };

  const smoothedTR = smooth(tr, period);
  const smoothedPlusDM = smooth(plusDM, period);
  const smoothedMinusDM = smooth(minusDM, period);

  const dx = new Array(close.length).fill(null);
  for (let i = period; i < close.length; i++) {
    const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    const diDiff = Math.abs(plusDI - minusDI);
    const diSum = plusDI + minusDI;
    dx[i] = diSum === 0 ? 0 : (diDiff / diSum) * 100;
  }

  let dxSum = 0;
  for (let i = period; i < period * 2; i++) dxSum += dx[i];
  adx[period * 2 - 1] = dxSum / period;

  for (let i = period * 2; i < close.length; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }

  return adx;
}
