// Debug endpoint: test which NASDAQ100 symbol actually returns klines
const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';

const CANDIDATES = [
  'NCSINASDAQ1002USD-USDT',
  'NCSI724NASDAQ1002USD-USDT',
  'NCSKIONQ2USD-USDT',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = [];

  for (const sym of CANDIDATES) {
    try {
      const url = `${BINGX_BASE}/klines?symbol=${encodeURIComponent(sym)}&interval=15m&limit=3`;
      const r = await fetch(url);
      const json = await r.json();
      results.push({
        symbol: sym,
        code: json.code,
        msg: json.msg ?? null,
        hasData: Array.isArray(json.data) && json.data.length > 0,
        sample: Array.isArray(json.data) ? json.data[0] : null,
      });
    } catch (err) {
      results.push({ symbol: sym, error: err.message });
    }
  }

  return res.status(200).json({ results });
}
