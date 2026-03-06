import { useState, useEffect } from 'react';

export type Kline = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function fetchWithTimeout(url: string, timeout = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function fetchFutures(symbol: string, interval: string, limit: number): Promise<Kline[] | null> {
  try {
    const res = await fetchWithTimeout(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.map((d: any) => ({
      time: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]),
      low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5]),
    }));
  } catch (_) {
    return null;
  }
}

async function fetchSpot(symbol: string, interval: string, limit: number): Promise<Kline[] | null> {
  const urls = [
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api1.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, 3000);
      if (res.ok) {
        const json = await res.json();
        return json.map((d: any) => ({
          time: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]),
          low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5]),
        }));
      }
      if (res.status === 400) throw new Error(`Invalid symbol: ${symbol}`);
    } catch (e: any) {
      if (e.message?.includes('Invalid symbol')) throw e;
    }
  }
  return null;
}

export function useKlines(symbol: string, interval: string, limit = 150) {
  const [data, setData]       = useState<Kline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [isFutures, setIsFutures] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        // Try futures first
        let klines = await fetchFutures(symbol, interval, limit);
        let futures = false;
        if (klines) {
          futures = true;
        } else {
          // Fallback to spot
          klines = await fetchSpot(symbol, interval, limit);
        }
        if (!klines) throw new Error(`無法取得 ${symbol} 資料`);
        if (isMounted) { setData(klines); setIsFutures(futures); }
      } catch (e: any) {
        if (isMounted) setError(e.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    run();
    return () => { isMounted = false; };
  }, [symbol, interval, limit]);

  return { data, loading, error, isFutures };
}
