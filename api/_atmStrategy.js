// ATM Asia Strategy - Backend
// 台灣時間 Asia Kill Zone: 夏令 06:00-07:00 (1m), Tokyo 09:00-10:00 (5m)

const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';
export const ATM_SYMBOL = 'NCSINASDAQ1002USD-USDT';
const TICK = 0.25;

// Taiwan time helpers
function getTWParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const h = Number(map.hour || 0);
  const m = Number(map.minute || 0);
  return {
    hour: h, minute: m,
    minuteOfDay: h * 60 + m,
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

// Kill Zone windows (TW time, minutes of day). Winter time +60.
function getKZWindows() {
  const nowNY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).formatToParts(new Date());
  const nyHour = Number(nowNY.find(p => p.type === 'hour')?.value || 0);
  const utcHour = new Date().getUTCHours();
  const nyOffset = ((nyHour - utcHour + 24) % 24 > 12 ? ((nyHour - utcHour + 24) % 24) - 24 : (nyHour - utcHour + 24) % 24);
  const isWinter = nyOffset === -5;
  return {
    asiaStart:  isWinter ? 7 * 60 : 6 * 60,
    asiaEnd:    isWinter ? 8 * 60 : 7 * 60,
    tokyoStart: isWinter ? 10 * 60 : 9 * 60,
    tokyoEnd:   isWinter ? 11 * 60 : 10 * 60,
  };
}

export async function fetchBingxKlines(symbol, interval, limit = 200) {
  try {
    const url = `${BINGX_BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !Array.isArray(json.data)) return null;
    return json.data.map(d => ({
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

export async function fetchBingxPrice(symbol) {
  try {
    const url = `${BINGX_BASE}/price?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !json.data) return null;
    const price = parseFloat(json.data.price);
    return isFinite(price) && price > 0 ? price : null;
  } catch (_) {
    return null;
  }
}

function findOB(klines, bias, sweepIdx) {
  for (let i = sweepIdx; i >= Math.max(0, sweepIdx - 30); i--) {
    const k = klines[i];
    if (bias === 'LONG' && k.close < k.open) return { high: k.high, low: k.low, mid: (k.high + k.low) / 2 };
    if (bias === 'SHORT' && k.close > k.open) return { high: k.high, low: k.low, mid: (k.high + k.low) / 2 };
  }
  return null;
}

function obInvalidated(candle, ob, bias) {
  return bias === 'LONG' ? candle.close < ob.low : candle.close > ob.high;
}

function detectWickRejection(candle, ob, bias) {
  const bodySize = Math.abs(candle.close - candle.open);
  if (bodySize === 0) return false;
  if (bias === 'LONG') {
    return candle.low <= ob.mid &&
      candle.close > ob.low &&
      (Math.min(candle.open, candle.close) - candle.low) > bodySize * 0.5;
  }
  return candle.high >= ob.mid &&
    candle.close < ob.high &&
    (candle.high - Math.max(candle.open, candle.close)) > bodySize * 0.5;
}

// Stateless ATM scan: returns OB_FOUND signal for informational notification only.
// Final signal (entry/SL/TP) is handled by the Python signalbot.
export async function runATMScan(prevCtx = null) {
  const now = new Date();
  const tw = getTWParts(now);
  const { asiaStart, asiaEnd, tokyoStart, tokyoEnd } = getKZWindows();

  let ctx = prevCtx && prevCtx.dateKey === tw.dateKey ? { ...prevCtx } : {
    dateKey: tw.dateKey,
    state: 'IDLE',
    asiaHigh: null, asiaLow: null,
    tokyoHigh: null, tokyoLow: null,
    tokyoLocked: false,
    bias: null, interactionType: null, ob: null,
    displaced: false,
  };

  const inAsia  = tw.minuteOfDay >= asiaStart  && tw.minuteOfDay < asiaEnd;
  const inTokyo = tw.minuteOfDay >= tokyoStart && tw.minuteOfDay < tokyoEnd;
  const postTokyo = tw.minuteOfDay >= tokyoEnd;

  const klines = await fetchBingxKlines(ATM_SYMBOL, '1m', 300);
  if (!klines || klines.length < 10) return { ctx, signal: null };

  const todayKey = tw.dateKey;
  const todayKlines = klines.filter(k => getTWParts(new Date(k.time)).dateKey === todayKey);

  // Always derive Asia range from today's Asia candles
  const asiaCandles = todayKlines.filter(k => {
    const { minuteOfDay } = getTWParts(new Date(k.time));
    return minuteOfDay >= asiaStart && minuteOfDay < asiaEnd;
  });
  if (asiaCandles.length > 0) {
    ctx.asiaHigh = Math.max(...asiaCandles.map(k => k.high));
    ctx.asiaLow  = Math.min(...asiaCandles.map(k => k.low));
  }

  if (inAsia) {
    ctx.state = 'ASIA_RANGE_FORMING';
    return { ctx, signal: null };
  }

  if (!ctx.asiaHigh || !ctx.asiaLow) return { ctx, signal: null };
  if (ctx.state === 'IDLE') ctx.state = 'ASIA_RANGE_LOCKED';

  // Derive Tokyo range from today's Tokyo candles
  const tokyoCandles = todayKlines.filter(k => {
    const { minuteOfDay } = getTWParts(new Date(k.time));
    return minuteOfDay >= tokyoStart && minuteOfDay < tokyoEnd;
  });
  if (tokyoCandles.length > 0) {
    ctx.tokyoHigh = Math.max(...tokyoCandles.map(k => k.high));
    ctx.tokyoLow  = Math.min(...tokyoCandles.map(k => k.low));
  }
  if (postTokyo && ctx.tokyoHigh) {
    ctx.tokyoLocked = true;
  }

  // Active reference range: Tokyo (if locked) else Asia
  const refHigh = ctx.tokyoLocked ? ctx.tokyoHigh : ctx.asiaHigh;
  const refLow  = ctx.tokyoLocked ? ctx.tokyoLow  : ctx.asiaLow;
  const refName = ctx.tokyoLocked ? 'Tokyo' : 'Asia';

  // During Tokyo session (building range), pause interaction detection if no setup yet
  if (inTokyo && ctx.state === 'ASIA_RANGE_LOCKED') {
    return { ctx, signal: null };
  }

  // Process post-Asia candles
  const postAsiaCandles = todayKlines.filter(k => {
    const { minuteOfDay } = getTWParts(new Date(k.time));
    return minuteOfDay >= asiaEnd;
  });

  const allCandles = [...asiaCandles, ...postAsiaCandles];
  let signal = null;

  for (let i = asiaCandles.length; i < allCandles.length; i++) {
    const candle = allCandles[i];
    const candleTW = getTWParts(new Date(candle.time));

    // Use active range at the time of this candle
    const candleInTokyo = candleTW.minuteOfDay >= tokyoStart && candleTW.minuteOfDay < tokyoEnd;
    const candlePostTokyo = candleTW.minuteOfDay >= tokyoEnd;
    const candleTokyoLocked = candlePostTokyo && ctx.tokyoHigh;
    const candleRefHigh = candleTokyoLocked ? ctx.tokyoHigh : ctx.asiaHigh;
    const candleRefLow  = candleTokyoLocked ? ctx.tokyoLow  : ctx.asiaLow;
    const candleRefName = candleTokyoLocked ? 'Tokyo' : 'Asia';

    // Skip interaction detection during Tokyo build (state still ASIA_RANGE_LOCKED)
    if (candleInTokyo && ctx.state === 'ASIA_RANGE_LOCKED') continue;

    if (ctx.state === 'ASIA_RANGE_LOCKED') {
      let newBias = null, newInteraction = null;
      if (candle.high > candleRefHigh) {
        newBias = candle.close <= candleRefHigh ? 'SHORT' : 'LONG';
        newInteraction = candle.close <= candleRefHigh ? 'SWEEP' : 'BREAKOUT';
      } else if (candle.low < candleRefLow) {
        newBias = candle.close >= candleRefLow ? 'LONG' : 'SHORT';
        newInteraction = candle.close >= candleRefLow ? 'SWEEP' : 'BREAKOUT';
      }
      if (newBias) {
        const ob = findOB(allCandles, newBias, i);
        if (ob) {
          ctx.bias = newBias;
          ctx.interactionType = newInteraction;
          ctx.ob = ob;
          ctx.state = 'WAITING_RETEST';
          ctx.displaced = false;
          // Only return signal if the interaction candle is fresh (< 5 min old).
          // Prevents stateless replay from re-alerting on old detections every run.
          const candleAgeMs = Date.now() - candle.time;
          if (candleAgeMs < 5 * 60 * 1000) {
            signal = {
              type: 'OB_FOUND',
              bias: ctx.bias,
              interactionType: ctx.interactionType,
              refHigh: candleRefHigh,
              refLow: candleRefLow,
              refName: candleRefName,
              asiaHigh: ctx.asiaHigh,
              asiaLow: ctx.asiaLow,
              tokyoHigh: ctx.tokyoHigh,
              tokyoLow: ctx.tokyoLow,
              ob: ctx.ob,
            };
          }
        }
      }
    } else if (ctx.state === 'WAITING_RETEST' && ctx.ob) {
      if (obInvalidated(candle, ctx.ob, ctx.bias)) {
        ctx.state = 'ASIA_RANGE_LOCKED'; ctx.ob = null; ctx.displaced = false;
        signal = null; continue;
      }
      if (!ctx.displaced) {
        if ((ctx.bias === 'LONG' && candle.close > ctx.ob.high) || (ctx.bias === 'SHORT' && candle.close < ctx.ob.low)) {
          ctx.displaced = true;
        }
      } else if (candle.low <= ctx.ob.high && candle.high >= ctx.ob.low) {
        ctx.state = 'WAITING_WICK';
      }
    } else if (ctx.state === 'WAITING_WICK' && ctx.ob) {
      if (obInvalidated(candle, ctx.ob, ctx.bias)) {
        ctx.state = 'ASIA_RANGE_LOCKED'; ctx.ob = null; ctx.displaced = false;
        signal = null; continue;
      }
      // Wick rejection detected — Python bot handles final signal; just reset to watch for new OB
      if (detectWickRejection(candle, ctx.ob, ctx.bias)) {
        ctx.state = 'ASIA_RANGE_LOCKED'; ctx.ob = null; ctx.displaced = false;
        signal = null;
      }
    }
  }

  return { ctx, signal };
}

export function buildATMTelegramMessage(signal, twTime) {
  if (!signal || signal.type !== 'OB_FOUND') return null;
  const emoji = signal.bias === 'LONG' ? '🟢' : '🔴';
  const rangeEmoji = signal.refName === 'Tokyo' ? '🗼' : '🌏';
  const rangeLabel = signal.refName === 'Tokyo' ? '日盤' : '亞洲盤';
  const interactionLabel = signal.interactionType === 'SWEEP' ? '假突破 (Sweep)' : '突破 (Breakout)';
  return [
    `${emoji} <b>NASDAQ100USD ATM — OB 發現</b>`,
    `方向：<b>${signal.bias}</b> | ${interactionLabel}`,
    '',
    `${rangeEmoji} ${rangeLabel} High：<code>${signal.refHigh?.toFixed(2)}</code>`,
    `${rangeEmoji} ${rangeLabel} Low：<code>${signal.refLow?.toFixed(2)}</code>`,
    `📦 OB 區間：<code>${signal.ob?.low?.toFixed(2)} – ${signal.ob?.high?.toFixed(2)}</code>`,
    '',
    `⏰ TW ${twTime}`,
  ].join('\n');
}
