// Debug endpoint: search BINGx contracts list for NASDAQ / NQ / index symbols
const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const r = await fetch(`${BINGX_BASE}/contracts`);
    const json = await r.json();
    if (json.code !== 0 || !Array.isArray(json.data)) {
      return res.status(200).json({ error: json.msg, code: json.code });
    }

    const keywords = ['NASD', 'NQ', 'US10', 'NDX', 'DOW', 'SP5', 'GOLD', 'OIL', 'XAU'];
    const matches = json.data
      .filter(s => keywords.some(k => s.symbol?.toUpperCase().includes(k)))
      .map(s => s.symbol);

    const allSymbols = json.data.map(s => s.symbol);

    return res.status(200).json({ matches, total: allSymbols.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
