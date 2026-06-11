// ATM Asia Strategy - Backend
// 台灣時間 Asia Kill Zone: 夏令 06:00-07:00 (1m), Tokyo 09:00-10:00 (5m)

const BINGX_BASE = 'https://open-api.bingx.com/openApi/swap/v2/quote';
export const ATM_SYMBOL = 'NASDAQ100-USD'; // BINGx API symbol format
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
  // Detect winter time: Nov–Mar Taipei doesn't change clocks but NY does.
  // Simple approximation: if UTC offset of America/New_York is -5 (winter), use winter windows.
  const nowNY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).formatToParts(new Date());
  const nyHour = Number(nowNY.find(p => p.type === 'hour')?.value || 0);
  const utcHour = new Date().getUTCHours();
  // NY UTC offset: -4 (summer) or -5 (winter)
  const nyOffset = ((nyHour - utcHour + 24) % 24 > 12 ? ((nyHour - utcHour + 24) % 24) - 24 : (nyHour - utcHour + 24) % 24);
  const isWinter = nyOffset === -5;
  return {
    asiaStart: isWinter ? 7 * 60 : 6 * 60,
    asiaEnd:   isWinter ? 8 * 60 : 7 * 60,
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

// Stateless ATM scan: processes all klines for today and returns current ctx + any new signal
export async function runATMScan(prevCtx = null) {
  const now = new Date();
  const tw = getTWParts(now);
  const { asiaStart, asiaEnd } = getKZWindows();

  // Build initial context
  let ctx = prevCtx && prevCtx.dateKey === tw.dateKey ? { ...prevCtx } : {
    dateKey: tw.dateKey,
    state: 'IDLE',
    asiaHigh: null,
    asiaLow: null,
    bias: null,
    interactionType: null,
    ob: null,
    displaced: false,
    checklist: { rangeFormed: false, sweepOrBreakout: false, obFound: false, displaced: false, retest: false, wickRejection: false },
  };

  const inAsia = tw.minuteOfDay >= asiaStart && tw.minuteOfDay < asiaEnd;

  // Fetch 1m klines (enough to cover today's Asia session + post-Asia)
  const klines = await fetchBingxKlines(ATM_SYMBOL, '1m', 300);
  if (!klines || klines.length < 10) return { ctx, signal: null };

  const todayMs = new Date(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })).getTime();
  const asiaStartMs = todayMs + asiaStart * 60 * 1000 - 8 * 60 * 60 * 1000; // TW is UTC+8

  // Build today's candles in TW time
  const todayKey = tw.dateKey;
  const todayKlines = klines.filter(k => getTWParts(new Date(k.time)).dateKey === todayKey);

  if (inAsia) {
    // Update Asia Range
    const asiaCandles = todayKlines.filter(k => {
      const { minuteOfDay } = getTWParts(new Date(k.time));
      return minuteOfDay >= asiaStart && minuteOfDay < asiaEnd;
    });
    if (asiaCandles.length > 0) {
      ctx.asiaHigh = Math.max(...asiaCandles.map(k => k.high));
      ctx.asiaLow = Math.min(...asiaCandles.map(k => k.low));
      ctx.state = 'ASIA_RANGE_FORMING';
    }
    return { ctx, signal: null };
  }

  // After Asia session ends
  const asiaCandles = todayKlines.filter(k => {
    const { minuteOfDay } = getTWParts(new Date(k.time));
    return minuteOfDay >= asiaStart && minuteOfDay < asiaEnd;
  });

  if (asiaCandles.length > 0 && !ctx.asiaHigh) {
    ctx.asiaHigh = Math.max(...asiaCandles.map(k => k.high));
    ctx.asiaLow = Math.min(...asiaCandles.map(k => k.low));
    ctx.checklist.rangeFormed = true;
    ctx.state = 'ASIA_RANGE_LOCKED';
  }

  if (!ctx.asiaHigh || !ctx.asiaLow) return { ctx, signal: null };
  if (ctx.state === 'SIGNAL_FIRED') return { ctx, signal: null }; // already done today

  // Process post-Asia candles through state machine
  const postAsiaCandles = todayKlines.filter(k => {
    const { minuteOfDay } = getTWParts(new Date(k.time));
    return minuteOfDay >= asiaEnd;
  });

  const allCandles = [...asiaCandles, ...postAsiaCandles];
  let signal = null;

  for (let i = asiaCandles.length; i < allCandles.length; i++) {
    const candle = allCandles[i];

    if (ctx.state === 'ASIA_RANGE_LOCKED') {
      let newBias = null, newInteraction = null;
      if (candle.high > ctx.asiaHigh) {
        newBias = candle.close <= ctx.asiaHigh ? 'SHORT' : 'LONG';
        newInteraction = candle.close <= ctx.asiaHigh ? 'SWEEP' : 'BREAKOUT';
      } else if (candle.low < ctx.asiaLow) {
        newBias = candle.close >= ctx.asiaLow ? 'LONG' : 'SHORT';
        newInteraction = candle.close >= ctx.asiaLow ? 'SWEEP' : 'BREAKOUT';
      }
      if (newBias) {
        const ob = findOB(allCandles, newBias, i);
        if (ob) {
          ctx.bias = newBias;
          ctx.interactionType = newInteraction;
          ctx.ob = ob;
          ctx.state = 'WAITING_RETEST';
          ctx.displaced = false;
          ctx.checklist.sweepOrBreakout = true;
          ctx.checklist.obFound = true;
          signal = { stage: 2, type: 'OB_FOUND', bias: ctx.bias, interactionType: ctx.interactionType, asiaHigh: ctx.asiaHigh, asiaLow: ctx.asiaLow, ob: ctx.ob, checklist: { ...ctx.checklist } };
        }
      }
    } else if (ctx.state === 'WAITING_RETEST' && ctx.ob) {
      if (obInvalidated(candle, ctx.ob, ctx.bias)) {
        ctx.state = 'ASIA_RANGE_LOCKED'; ctx.ob = null; ctx.displaced = false;
        ctx.checklist.obFound = false; ctx.checklist.displaced = false; ctx.checklist.retest = false;
        signal = null; continue;
      }
      if (!ctx.displaced) {
        if ((ctx.bias === 'LONG' && candle.close > ctx.ob.high) || (ctx.bias === 'SHORT' && candle.close < ctx.ob.low)) {
          ctx.displaced = true; ctx.checklist.displaced = true;
        }
      } else if (candle.low <= ctx.ob.high && candle.high >= ctx.ob.low) {
        ctx.state = 'WAITING_WICK'; ctx.checklist.retest = true;
      }
    } else if (ctx.state === 'WAITING_WICK' && ctx.ob) {
      if (obInvalidated(candle, ctx.ob, ctx.bias)) {
        ctx.state = 'ASIA_RANGE_LOCKED'; ctx.ob = null; ctx.displaced = false;
        ctx.checklist.obFound = false; ctx.checklist.displaced = false; ctx.checklist.retest = false; ctx.checklist.wickRejection = false;
        signal = null; continue;
      }
      if (detectWickRejection(candle, ctx.ob, ctx.bias)) {
        ctx.checklist.wickRejection = true;
        ctx.state = 'SIGNAL_FIRED';
        const entry = candle.close;
        const sl = ctx.bias === 'LONG' ? ctx.ob.low - TICK : ctx.ob.high + TICK;
        const tp1 = ctx.bias === 'LONG' ? ctx.asiaHigh : ctx.asiaLow;
        const tp2 = ctx.bias === 'LONG' ? entry + 2 * (entry - sl) : entry - 2 * (sl - entry);
        signal = {
          stage: 3, type: 'FINAL_SIGNAL',
          bias: ctx.bias, interactionType: ctx.interactionType,
          asiaHigh: ctx.asiaHigh, asiaLow: ctx.asiaLow, ob: ctx.ob,
          entry, sl, tp1, tp2,
          rr: Math.abs(tp2 - entry) / Math.abs(entry - sl),
          checklist: { ...ctx.checklist },
        };
        break;
      }
    }
  }

  return { ctx, signal };
}

export function buildATMTelegramMessage(signal, twTime) {
  if (!signal) return null;
  if (signal.stage === 2) {
    const emoji = signal.bias === 'LONG' ? '🟢' : '🔴';
    return [
      `${emoji} <b>NASDAQ100USD ATM — OB 發現</b>`,
      `方向：<b>${signal.bias}</b> | ${signal.interactionType === 'SWEEP' ? '假突破 (Sweep)' : '突破 (Breakout)'}`,
      '',
      `🌏 Asia High：<code>${signal.asiaHigh?.toFixed(2)}</code>`,
      `🌏 Asia Low：<code>${signal.asiaLow?.toFixed(2)}</code>`,
      `📦 OB 區間：<code>${signal.ob?.low?.toFixed(2)} – ${signal.ob?.high?.toFixed(2)}</code>`,
      '',
      `☑️ 區間鎖定  ☑️ ${signal.interactionType}  ☑️ OB 識別  ⬜ 位移  ⬜ 回踩  ⬜ 影線拒絕`,
      `⏰ TW ${twTime}`,
    ].join('\n');
  }
  if (signal.stage === 3) {
    const emoji = signal.bias === 'LONG' ? '🚀' : '🔻';
    return [
      `${emoji} <b>NASDAQ100USD ATM — 最終訊號</b>`,
      `方向：<b>${signal.bias}</b> | ${signal.interactionType}`,
      '',
      `📍 Entry：<code>${signal.entry?.toFixed(2)}</code>`,
      `🛡️ SL：<code>${signal.sl?.toFixed(2)}</code>`,
      `🎯 TP1 (Asia ${signal.bias === 'LONG' ? 'High' : 'Low'})：<code>${signal.tp1?.toFixed(2)}</code>`,
      `🎯 TP2 (1:2 R/R)：<code>${signal.tp2?.toFixed(2)}</code>`,
      `⚖️ R/R：<code>${signal.rr?.toFixed(2)}</code>`,
      '',
      `🌏 Asia Range：<code>${signal.asiaLow?.toFixed(2)} – ${signal.asiaHigh?.toFixed(2)}</code>`,
      `📦 OB：<code>${signal.ob?.low?.toFixed(2)} – ${signal.ob?.high?.toFixed(2)}</code>`,
      '',
      `☑️ 區間鎖定  ☑️ ${signal.interactionType}  ☑️ OB  ☑️ 位移  ☑️ 回踩  ☑️ 影線拒絕`,
      `⏰ TW ${twTime}`,
    ].join('\n');
  }
  return null;
}
