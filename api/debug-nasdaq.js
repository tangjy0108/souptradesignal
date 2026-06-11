// Debug endpoint: try multiple NASDAQ100 symbol formats and report what BINGx returns
const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';

const CANDIDATES = [
  'NASDAQ100-USD',
  'NASDAQ100-USDT',
  'NASDAQ100USD',
  'NASDAQ100USDT',
  'US100-USDT',
  'NDX-USDT',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = [];

  for (const sym of CANDIDATES) {
    try {
      const url = `${BINGX_BASE}/klines?symbol=${encodeURIComponent(sym)}&interval=15m&limit=3`;
      const r = await fetch(url);
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      results.push({
        symbol: sym,
        httpStatus: r.status,
        bingxCode: json?.code ?? 'parse_error',
        bingxMsg: json?.msg ?? null,
        hasData: Array.isArray(json?.data) && json.data.length > 0,
        firstClose: Array.isArray(json?.data) && json.data[0] ? json.data[0].close : null,
      });
    } catch (err) {
      results.push({ symbol: sym, error: err.message });
    }
  }

  return res.status(200).json({ results });
}
