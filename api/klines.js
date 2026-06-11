// Server-side proxy for BINGx klines — avoids browser CORS restrictions
const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';

// Display name → actual BINGx contract symbol
const SYMBOL_MAP = {
  'NASDAQ100USD': 'NCSINASDAQ1002USD-USDT',
};

function toBingxSymbol(symbol) {
  if (SYMBOL_MAP[symbol]) return SYMBOL_MAP[symbol];
  if (symbol.includes('-')) return symbol;
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4) + '-USDT';
  return symbol;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, interval = '15m', limit = '150' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const bingxSym = toBingxSymbol(symbol);
  const url = `${BINGX_BASE}/klines?symbol=${encodeURIComponent(bingxSym)}&interval=${interval}&limit=${limit}`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: `BINGx returned ${upstream.status}` });
    }
    const json = await upstream.json();
    if (json.code !== 0 || !Array.isArray(json.data)) {
      return res.status(502).json({ error: `BINGx error: ${json.msg || 'unknown'}`, code: json.code, symbol: bingxSym, url });
    }

    const klines = json.data
      .map(d => ({
        time:   Number(d.time),
        open:   parseFloat(d.open),
        high:   parseFloat(d.high),
        low:    parseFloat(d.low),
        close:  parseFloat(d.close),
        volume: parseFloat(d.volume || 0),
      }))
      .sort((a, b) => a.time - b.time);

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    return res.status(200).json({ klines });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
