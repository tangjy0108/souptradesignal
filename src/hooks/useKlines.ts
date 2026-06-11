import { useState, useEffect } from 'react';

export type Kline = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';

// Convert symbol to BINGx format: BTCUSDT → BTC-USDT, NQ-USDT stays as-is
function toBingxSymbol(symbol: string): string {
  if (symbol.includes('-')) return symbol;
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4) + '-USDT';
  return symbol;
}

async function fetchBingxKlines(symbol: string, interval: string, limit: number): Promise<Kline[] | null> {
  const bingxSym = toBingxSymbol(symbol);
  try {
    const url = `${BINGX_BASE}/klines?symbol=${encodeURIComponent(bingxSym)}&interval=${interval}&limit=${limit}`;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !Array.isArray(json.data)) return null;
    return (json.data as any[]).map(d => ({
      time: Number(d.time),
      open: parseFloat(d.open),
      high: parseFloat(d.high),
      low: parseFloat(d.low),
      close: parseFloat(d.close),
      volume: parseFloat(d.volume || 0),
    })).sort((a, b) => a.time - b.time);
  } catch (_) {
    return null;
  }
}

export function useKlines(symbol: string, interval: string, limit = 150) {
  const [data, setData]       = useState<Kline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [isFutures, setIsFutures] = useState(true); // BINGx is always perpetual

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const klines = await fetchBingxKlines(symbol, interval, limit);
        if (!klines || klines.length === 0) throw new Error(`無法取得 ${symbol} 資料`);
        if (isMounted) { setData(klines); setIsFutures(true); }
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
