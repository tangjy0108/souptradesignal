// Server-side proxy for BINGx contracts list — avoids browser CORS restrictions
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const upstream = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/contracts');
    if (!upstream.ok) return res.status(502).json({ error: `BINGx returned ${upstream.status}` });
    const json = await upstream.json();
    if (json.code !== 0 || !Array.isArray(json.data)) {
      return res.status(502).json({ error: 'BINGx invalid response' });
    }
    // BINGx symbols: BTC-USDT → BTCUSDT for display compat, keep NASDAQ100-USDT as-is
    const symbols = json.data
      .map((s) => s.symbol)
      .filter((s) => typeof s === 'string' && s.endsWith('-USDT'))
      .map((s) => s === 'NASDAQ100-USDT' ? s : s.replace('-USDT', 'USDT'));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ symbols });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
