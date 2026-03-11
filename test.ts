async function test() {
  const res = await fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=1', {
    headers: { 'Origin': 'https://example.vercel.app' }
  });
  console.log('Status:', res.status);
  console.log('CORS:', res.headers.get('access-control-allow-origin'));
  const json = await res.json();
  console.log(json);
}
test();
