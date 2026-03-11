import { useState, useEffect } from 'react';

export type FundingData = {
  fundingRate: number;
  nextFundingTime: number;
  longShortRatio: number | null;
};

export function useFundingRate(symbol: string, isFutures: boolean) {
  const [data, setData] = useState<FundingData | null>(null);

  useEffect(() => {
    if (!isFutures) { setData(null); return; }
    let isMounted = true;

    const fetch_ = async () => {
      try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        if (!res.ok) throw new Error('failed');
        const json = await res.json();
        const fundingRate = parseFloat(json.lastFundingRate) * 100;
        const nextFundingTime = json.nextFundingTime;

        let longShortRatio: number | null = null;
        try {
          const lsRes = await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`);
          if (lsRes.ok) {
            const lsJson = await lsRes.json();
            if (lsJson.length > 0) longShortRatio = parseFloat(lsJson[0].longShortRatio);
          }
        } catch (_) {}

        if (isMounted) setData({ fundingRate, nextFundingTime, longShortRatio });
      } catch (_) {
        if (isMounted) setData(null);
      }
    };

    fetch_();
    const id = setInterval(fetch_, 30000);
    return () => { isMounted = false; clearInterval(id); };
  }, [symbol, isFutures]);

  return data;
}
