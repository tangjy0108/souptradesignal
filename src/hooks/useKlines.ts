import { useState, useEffect } from 'react';

export type Kline = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function fetchBingxKlines(symbol: string, interval: string, limit: number): Promise<Kline[] | null> {
  try {
    const url = `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json.klines)) return null;
    return json.klines;
  } catch (_) {
    return null;
  }
}

export function useKlines(symbol: string, interval: string, limit = 150) {
  const [data, setData]       = useState<Kline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const isFutures = true; // BINGx is always perpetual

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const klines = await fetchBingxKlines(symbol, interval, limit);
        if (!klines || klines.length === 0) throw new Error(`無法取得 ${symbol} 資料`);
        if (isMounted) setData(klines);
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
