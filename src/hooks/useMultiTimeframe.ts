import { useState, useEffect } from 'react';
import { calculateEMA } from '../lib/indicators';

export type DivergenceState = 'CONFIRMED_BULL' | 'CONFIRMED_BEAR' | 'WARNING_BULL' | 'WARNING_BEAR' | null;

export type TFSignal = {
  tf: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  ema20: number;
  ema50: number;
  price: number;
  divergence: DivergenceState;
};

const BINANCE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];

async function fetchKlines(symbol: string, interval: string, limit = 100) {
  for (const base of BINANCE_URLS) {
    try {
      const res = await fetch(`${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const json = await res.json();
        return json.map((d: any) => ({
          close: parseFloat(d[4]),
          high:  parseFloat(d[2]),
          low:   parseFloat(d[3]),
        }));
      }
    } catch (_) {}
  }
  return null;
}

function calcRSI(closes: number[], period = 14): number[] {
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
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function detectDivergence(klines: { close: number; high: number; low: number }[]): DivergenceState {
  if (klines.length < 30) return null;
  const closes = klines.map(k => k.close);
  const highs  = klines.map(k => k.high);
  const lows   = klines.map(k => k.low);
  const rsi    = calcRSI(closes, 14);
  const n      = klines.length;

  // 看多背離
  const swingLows: number[] = [];
  for (let i = 3; i < n - 3; i++)
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      swingLows.push(i);

  if (swingLows.length >= 2) {
    const i1 = swingLows[swingLows.length - 2];
    const i2 = swingLows[swingLows.length - 1];
    if (lows[i2] < lows[i1] && rsi[i2] !== null && rsi[i1] !== null && rsi[i2] > rsi[i1]) {
      const hooked = rsi[n-1] !== null && rsi[n-2] !== null && rsi[n-1] > rsi[n-2];
      return hooked ? 'CONFIRMED_BULL' : 'WARNING_BULL';
    }
  }

  // 看空背離
  const swingHighs: number[] = [];
  for (let i = 3; i < n - 3; i++)
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      swingHighs.push(i);

  if (swingHighs.length >= 2) {
    const i1 = swingHighs[swingHighs.length - 2];
    const i2 = swingHighs[swingHighs.length - 1];
    if (highs[i2] > highs[i1] && rsi[i2] !== null && rsi[i1] !== null && rsi[i2] < rsi[i1]) {
      const hooked = rsi[n-1] !== null && rsi[n-2] !== null && rsi[n-1] < rsi[n-2];
      return hooked ? 'CONFIRMED_BEAR' : 'WARNING_BEAR';
    }
  }

  return null;
}

export function useMultiTimeframe(symbol: string) {
  const [signals, setSignals] = useState<TFSignal[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      setLoading(true);
      const tfs = ['15m', '1h', '4h'];
      const results: TFSignal[] = [];

      for (const tf of tfs) {
        const klines = await fetchKlines(symbol, tf, 100);
        if (!klines || klines.length < 50) {
          results.push({ tf, direction: 'NEUTRAL', ema20: 0, ema50: 0, price: 0, divergence: null });
          continue;
        }
        const closes = klines.map((k: any) => k.close);
        const ema20arr = calculateEMA(closes, 20);
        const ema50arr = calculateEMA(closes, 50);
        const price = closes[closes.length - 1];
        const ema20 = ema20arr[ema20arr.length - 1];
        const ema50 = ema50arr[ema50arr.length - 1];
        const direction: 'LONG' | 'SHORT' | 'NEUTRAL' =
          price > ema20 && ema20 > ema50 ? 'LONG' :
          price < ema20 && ema20 < ema50 ? 'SHORT' : 'NEUTRAL';
        const divergence = detectDivergence(klines);
        results.push({ tf, direction, ema20, ema50, price, divergence });
      }

      if (isMounted) { setSignals(results); setLoading(false); }
    };

    run();
    const id = setInterval(run, 60000);
    return () => { isMounted = false; clearInterval(id); };
  }, [symbol]);

  return { signals, loading };
}
