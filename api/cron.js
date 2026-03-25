import { fetchKlines, SCAN_SYMBOLS } from './_strategy.js';
import { listTrackableSignals, updateSignalStatuses, upsertSignalsWithMeta } from './_signalStore.js';
import { sendTelegram } from './_telegram.js';

const recentlySentSessionLiquidity = new Set();

const FIVE_MINUTE_MS = 5 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const KILLZONE_STRATEGY_ID = 'ict_killzone_opt3';
const KILLZONE_STRATEGY_NAME = 'ICT Killzone Opt3';

function getTimePartsInZone(date, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(map.hour || 0);
  const minute = Number(map.minute || 0);

  return {
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    weekday: weekdayMap[map.weekday] ?? 0,
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

function inSession(minuteOfDay, startMinute, endMinute) {
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function getSignalDateKey(input) {
  return getTimePartsInZone(new Date(input || Date.now()), 'America/New_York').dateKey;
}

function getCronContext(now = new Date()) {
  const et = getTimePartsInZone(now, 'America/New_York');
  const isWeekday = et.weekday >= 1 && et.weekday <= 5;
  const inAsiaSession = inSession(et.minuteOfDay, 20 * 60, 0);
  const inLondonKillzone = isWeekday && inSession(et.minuteOfDay, 2 * 60, 5 * 60);
  const inNyKillzone = isWeekday && inSession(et.minuteOfDay, 8 * 60 + 30, 11 * 60);
  const inNyOpeningRange = isWeekday && inSession(et.minuteOfDay, 9 * 60 + 30, 10 * 60);
  const activeKillzoneSession = inAsiaSession ? 'Asia' : inLondonKillzone ? 'London' : inNyKillzone ? 'New York' : 'Off-Hours';

  return {
    et,
    isWeekday,
    inAsiaSession,
    inLondonKillzone,
    inNyKillzone,
    inNyOpeningRange,
    activeKillzoneSession,
    afterOpeningRange: inNyKillzone && et.minuteOfDay >= 10 * 60,
  };
}

function getScanReference(now = new Date()) {
  return new Date(now.getTime() - ONE_MINUTE_MS);
}

function calcEMA(values, period) {
  const ema = new Array(values.length).fill(null);
  if (values.length < period) return ema;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcATRFromKlines(klines, period = 14) {
  const trs = klines.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = klines[i - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose)
    );
  });
  const atr = new Array(klines.length).fill(null);
  if (klines.length <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < trs.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function findLatestIndexAtOrBefore(klines, time) {
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].time <= time) return i;
  }
  return -1;
}

function getLastClosedBarIndex(klines, intervalMs, nowTime = Date.now()) {
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].time + intervalMs <= nowTime) return i;
  }
  return -1;
}

function getClosedBars(klines, intervalMs, now = new Date()) {
  const closedIndex = getLastClosedBarIndex(klines, intervalMs, now.getTime());
  if (closedIndex < 2) return null;

  const bars = klines.slice(0, closedIndex + 1);
  return {
    bars,
    current: bars[bars.length - 1],
    prev: bars[bars.length - 2],
    prev2: bars[bars.length - 3],
  };
}

function getKillzoneSession(time) {
  const et = getTimePartsInZone(new Date(time), 'America/New_York');
  const isWeekday = et.weekday >= 1 && et.weekday <= 5;
  if (inSession(et.minuteOfDay, 20 * 60, 0)) return 'Asia';
  if (isWeekday && inSession(et.minuteOfDay, 2 * 60, 5 * 60)) return 'London';
  if (isWeekday && inSession(et.minuteOfDay, 8 * 60 + 30, 11 * 60)) return 'New York';
  return 'Off-Hours';
}

function getRollingTargetSession(currentSession) {
  if (currentSession === 'Asia') return 'New York';
  if (currentSession === 'London') return 'Asia';
  if (currentSession === 'New York') return 'London';
  return null;
}

function buildKillzoneRanges(klines) {
  const ranges = [];
  let active = null;

  for (const bar of klines) {
    const session = getKillzoneSession(bar.time);
    if (session === 'Off-Hours') {
      if (active) {
        ranges.push(active);
        active = null;
      }
      continue;
    }

    const et = getTimePartsInZone(new Date(bar.time), 'America/New_York');
    const sessionKey = `${session}_${et.dateKey}`;

    if (!active || active.sessionKey !== sessionKey) {
      if (active) ranges.push(active);
      active = {
        session,
        dateKey: et.dateKey,
        sessionKey,
        startTime: bar.time,
        endTime: bar.time,
        high: bar.high,
        low: bar.low,
      };
    } else {
      active.high = Math.max(active.high, bar.high);
      active.low = Math.min(active.low, bar.low);
      active.endTime = bar.time;
    }
  }

  if (active) ranges.push(active);
  return ranges;
}

function buildKillzoneSignalKey(signal) {
  const dateKey = getSignalDateKey(signal.candleTime || signal.updatedAt || Date.now());
  return [
    KILLZONE_STRATEGY_ID,
    signal.sym,
    signal.currentSession || 'Off-Hours',
    dateKey,
    signal.setupType || 'SETUP',
    signal.sweepSide || signal.direction || 'NEUTRAL',
  ].join('|');
}

async function safeSendTelegram(message, sendErrors, tag) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    const error = 'Telegram env vars not set';
    if (!sendErrors.includes(error)) sendErrors.push(error);
    return false;
  }
  try {
    await sendTelegram(message);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Telegram send failed [${tag}]`, msg);
    sendErrors.push(`[${tag}] ${msg}`);
    return false;
  }
}

function fmt(price) {
  if (!price) return '0';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

function getTrackableSignalOutcome(item, price) {
  if (!Number.isFinite(price) || price <= 0) return item.status;
  if (item.status !== 'LIVE_SIGNAL' && item.status !== 'ACTIVE_TRADE') return item.status;
  if (item.stop <= 0 || item.target <= 0) return item.status;

  if (item.direction === 'LONG') {
    if (price >= item.target) return 'TP_HIT';
    if (price <= item.stop) return 'SL_HIT';
  }
  if (item.direction === 'SHORT') {
    if (price <= item.target) return 'TP_HIT';
    if (price >= item.stop) return 'SL_HIT';
  }
  return item.status;
}

function toPersistedKillzoneSignal(signal, updatedAt = new Date().toISOString()) {
  const signalKey = signal.signalKey || buildKillzoneSignalKey(signal);
  const entry = Number(signal.entry) || Number(signal.price) || 0;

  return {
    signalKey,
    fingerprint: `${signalKey}|LIVE_SIGNAL`,
    symbol: signal.sym,
    strategyId: KILLZONE_STRATEGY_ID,
    strategyName: KILLZONE_STRATEGY_NAME,
    direction: signal.direction,
    regime: `${signal.setupType}_${signal.bias || 'NEUTRAL'}_${signal.currentSession}`,
    status: 'LIVE_SIGNAL',
    session: signal.currentSession,
    setupType: signal.setupType,
    bias: signal.bias,
    entryLow: entry,
    entryHigh: entry,
    stop: signal.stop,
    target: signal.target,
    rr: signal.rr,
    updatedAt,
  };
}

async function persistKillzoneSignals(signals, updatedAt = new Date().toISOString()) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return { saved: [], existingSignalKeys: new Set(), changes: [] };
  }

  const rows = signals.map(signal => toPersistedKillzoneSignal(signal, updatedAt));
  const { items: saved, changes } = await upsertSignalsWithMeta(rows);
  const existingSignalKeys = new Set(
    changes
      .filter(change => change.previous)
      .map(change => change.current.signalKey)
  );

  return { saved, existingSignalKeys, changes };
}

async function fetchLatestPrice(symbol) {
  const endpoints = [
    `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) continue;
      const json = await response.json();
      const price = Number(json?.price);
      if (Number.isFinite(price) && price > 0) {
        return price;
      }
    } catch (_) {}
  }

  return null;
}

async function syncTrackableSignalStatuses(now = new Date()) {
  const trackableSignals = await listTrackableSignals(200);
  if (!trackableSignals.length) return [];

  const symbols = [...new Set(trackableSignals.map(item => item.symbol).filter(Boolean))];
  const priceResults = await Promise.all(
    symbols.map(async symbol => [symbol, await fetchLatestPrice(symbol)])
  );
  const priceMap = new Map(
    priceResults.filter(([, price]) => Number.isFinite(price) && price > 0)
  );

  const updatedAt = now.toISOString();
  const updates = [];
  const events = [];

  for (const item of trackableSignals) {
    const price = priceMap.get(item.symbol);
    const nextStatus = getTrackableSignalOutcome(item, price);
    if (nextStatus === item.status) continue;

    updates.push({
      signalKey: item.signalKey,
      status: nextStatus,
      updatedAt,
    });

    events.push({
      ...item,
      status: nextStatus,
      price,
      updatedAt,
    });
  }

  if (updates.length > 0) {
    await updateSignalStatuses(updates);
  }

  return events;
}

function shouldRunSignalScans(now = new Date()) {
  return now.getUTCMinutes() % 5 === 0;
}

async function runICTKillzoneOpt3Scan(now = new Date()) {
  const ctx = getCronContext(getScanReference(now));
  if (!ctx.inLondonKillzone && !ctx.inNyKillzone) return [];

  const signals = [];

  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const [k5, k1h, k1d] = await Promise.all([
        fetchKlines(sym, '5m', 320),
        fetchKlines(sym, '1h', 120),
        fetchKlines(sym, '1d', 10),
      ]);

      if (!k5 || !k1h || !k1d || k1h.length < 60 || k1d.length < 2) return;

      const closed5 = getClosedBars(k5, FIVE_MINUTE_MS, now);
      if (!closed5 || closed5.bars.length < 80) return;

      const scanK5 = closed5.bars;
      const { current, prev, prev2 } = closed5;
      if (!current || !prev || !prev2) return;

      const currentSession = getKillzoneSession(current.time);
      if (currentSession !== 'London' && currentSession !== 'New York') return;

      const et = getTimePartsInZone(new Date(current.time), 'America/New_York');
      const inLondon = currentSession === 'London';
      const inNyWindow = currentSession === 'New York';
      const afterOpeningRange = inNyWindow && et.minuteOfDay >= 10 * 60;

      const atrSeries = calcATRFromKlines(scanK5, 14);
      const atr = atrSeries[scanK5.length - 1];
      if (!atr) return;

      const emaFastSeries = calcEMA(k1h.map(bar => bar.close), 20);
      const emaSlowSeries = calcEMA(k1h.map(bar => bar.close), 50);
      const h1Idx = findLatestIndexAtOrBefore(k1h, current.time);
      const d1Idx = findLatestIndexAtOrBefore(k1d, current.time);
      const h1Fast = h1Idx >= 0 ? emaFastSeries[h1Idx] : null;
      const h1Slow = h1Idx >= 0 ? emaSlowSeries[h1Idx] : null;
      const dailyOpen = d1Idx >= 0 ? k1d[d1Idx].open : current.open;

      const bullBias = !!(h1Fast && h1Slow && h1Fast > h1Slow);
      const bearBias = !!(h1Fast && h1Slow && h1Fast < h1Slow);

      let asiaHigh = 0;
      let asiaLow = 0;
      let orHigh = 0;
      let orLow = 0;
      let prevInAsia = false;
      let prevNyWindow = false;

      for (const bar of scanK5) {
        const barEt = getTimePartsInZone(new Date(bar.time), 'America/New_York');
        const barIsWeekday = barEt.weekday >= 1 && barEt.weekday <= 5;
        const barInAsia = inSession(barEt.minuteOfDay, 20 * 60, 0);
        const barInNyWindow = barIsWeekday && inSession(barEt.minuteOfDay, 8 * 60 + 30, 11 * 60);
        const barInOpeningRange = barIsWeekday && inSession(barEt.minuteOfDay, 9 * 60 + 30, 10 * 60);

        if (barInAsia && !prevInAsia) {
          asiaHigh = bar.high;
          asiaLow = bar.low;
        } else if (barInAsia) {
          asiaHigh = Math.max(asiaHigh, bar.high);
          asiaLow = Math.min(asiaLow, bar.low);
        }

        if (barInNyWindow && !prevNyWindow) {
          orHigh = 0;
          orLow = 0;
        }
        if (barInOpeningRange) {
          orHigh = orHigh === 0 ? bar.high : Math.max(orHigh, bar.high);
          orLow = orLow === 0 ? bar.low : Math.min(orLow, bar.low);
        }

        prevInAsia = barInAsia;
        prevNyWindow = barInNyWindow;
      }

      const currentClose = current.close;
      const bodySize = Math.abs(current.close - current.open);
      const sweepBuffer = atr * 0.10;
      const stopBuffer = atr * 0.20;
      const highs = scanK5.map(bar => bar.high);
      const lows = scanK5.map(bar => bar.low);
      const bullMssLevel = Math.max(...highs.slice(Math.max(0, scanK5.length - 4), scanK5.length - 1));
      const bearMssLevel = Math.min(...lows.slice(Math.max(0, scanK5.length - 4), scanK5.length - 1));
      const bullMss = currentClose > bullMssLevel;
      const bearMss = currentClose < bearMssLevel;
      const bullDisplacement = current.close > current.open && bodySize >= atr * 0.5;
      const bearDisplacement = current.close < current.open && bodySize >= atr * 0.5;
      const bullFvg = current.low > prev2.high;
      const bearFvg = current.high < prev2.low;
      const bullConfirm = bullDisplacement && bullMss;
      const bearConfirm = bearDisplacement && bearMss;
      const recent = scanK5.slice(-11);

      const londonBullSweeps = inLondon && asiaLow > 0 ? recent.filter(bar => bar.low < asiaLow - sweepBuffer) : [];
      const londonBearSweeps = inLondon && asiaHigh > 0 ? recent.filter(bar => bar.high > asiaHigh + sweepBuffer) : [];
      const nyBullReversalSweeps = afterOpeningRange && orLow > 0 ? recent.filter(bar => bar.low < orLow - sweepBuffer) : [];
      const nyBearReversalSweeps = afterOpeningRange && orHigh > 0 ? recent.filter(bar => bar.high > orHigh + sweepBuffer) : [];

      let signal = null;

      if (inLondon && bullBias && bullConfirm && londonBullSweeps.length > 0) {
        const extreme = Math.min(...londonBullSweeps.map(bar => bar.low));
        const entry = currentClose;
        const stop = extreme - stopBuffer;
        const target = entry + (entry - stop) * 2.0;
        signal = {
          sym,
          direction: 'LONG',
          setupType: 'LONDON_REVERSAL',
          currentSession,
          bias: 'BULLISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'ASIA_LOW',
          sweepLevel: asiaLow,
          sweepExtreme: extreme,
          mssLevel: bullMssLevel,
          fvgLow: bullFvg ? prev2.high : 0,
          fvgHigh: bullFvg ? current.low : 0,
          dailyOpen,
        };
      } else if (inLondon && bearBias && bearConfirm && londonBearSweeps.length > 0) {
        const extreme = Math.max(...londonBearSweeps.map(bar => bar.high));
        const entry = currentClose;
        const stop = extreme + stopBuffer;
        const target = entry - (stop - entry) * 2.0;
        signal = {
          sym,
          direction: 'SHORT',
          setupType: 'LONDON_REVERSAL',
          currentSession,
          bias: 'BEARISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(entry - target) / Math.max(Math.abs(stop - entry), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'ASIA_HIGH',
          sweepLevel: asiaHigh,
          sweepExtreme: extreme,
          mssLevel: bearMssLevel,
          fvgLow: bearFvg ? current.high : 0,
          fvgHigh: bearFvg ? prev2.low : 0,
          dailyOpen,
        };
      } else if (afterOpeningRange && bullBias && bullConfirm && bullFvg && nyBullReversalSweeps.length > 0 && currentClose > orLow) {
        const extreme = Math.min(...nyBullReversalSweeps.map(bar => bar.low));
        const entry = currentClose;
        const stop = extreme - stopBuffer;
        const target = entry + (entry - stop) * 2.0;
        signal = {
          sym,
          direction: 'LONG',
          setupType: 'NY_REVERSAL',
          currentSession,
          bias: 'BULLISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_LOW',
          sweepLevel: orLow,
          sweepExtreme: extreme,
          mssLevel: bullMssLevel,
          fvgLow: prev2.high,
          fvgHigh: current.low,
          dailyOpen,
        };
      } else if (afterOpeningRange && bearBias && bearConfirm && nyBearReversalSweeps.length > 0 && currentClose < orHigh) {
        const extreme = Math.max(...nyBearReversalSweeps.map(bar => bar.high));
        const entry = currentClose;
        const stop = extreme + stopBuffer;
        const target = entry - (stop - entry) * 2.0;
        signal = {
          sym,
          direction: 'SHORT',
          setupType: 'NY_REVERSAL',
          currentSession,
          bias: 'BEARISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(entry - target) / Math.max(Math.abs(stop - entry), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_HIGH',
          sweepLevel: orHigh,
          sweepExtreme: extreme,
          mssLevel: bearMssLevel,
          fvgLow: bearFvg ? current.high : 0,
          fvgHigh: bearFvg ? prev2.low : 0,
          dailyOpen,
        };
      } else if (afterOpeningRange && bullBias && bullConfirm && bullFvg && orHigh > 0 && currentClose > orHigh && prev.close <= orHigh) {
        const entry = currentClose;
        const stop = Math.min(orLow || current.low, prev.low, prev2.low) - stopBuffer;
        const target = entry + (entry - stop) * 2.0;
        signal = {
          sym,
          direction: 'LONG',
          setupType: 'NY_CONTINUATION',
          currentSession,
          bias: 'BULLISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_HIGH',
          sweepLevel: orHigh,
          sweepExtreme: current.high,
          mssLevel: bullMssLevel,
          fvgLow: prev2.high,
          fvgHigh: current.low,
          dailyOpen,
        };
      } else if (afterOpeningRange && bearBias && bearConfirm && orLow > 0 && currentClose < orLow && prev.close >= orLow) {
        const entry = currentClose;
        const stop = Math.max(orHigh || current.high, prev.high, prev2.high) + stopBuffer;
        const target = entry - (stop - entry) * 2.0;
        signal = {
          sym,
          direction: 'SHORT',
          setupType: 'NY_CONTINUATION',
          currentSession,
          bias: 'BEARISH',
          price: currentClose,
          entry,
          stop,
          target,
          rr: Math.abs(entry - target) / Math.max(Math.abs(stop - entry), 0.0000001),
          asiaHigh,
          asiaLow,
          orHigh,
          orLow,
          sweepSide: 'OR_LOW',
          sweepLevel: orLow,
          sweepExtreme: current.low,
          mssLevel: bearMssLevel,
          fvgLow: bearFvg ? current.high : 0,
          fvgHigh: bearFvg ? prev2.low : 0,
          dailyOpen,
        };
      }

      if (!signal) return;

      const persistedSignal = {
        ...signal,
        candleTime: current.time,
      };

      signals.push({
        ...persistedSignal,
        signalKey: buildKillzoneSignalKey(persistedSignal),
      });
    } catch (_) {}
  }));

  return signals;
}

async function runSessionLiquidityScan(now = new Date()) {
  const scanReference = getScanReference(now);
  const currentSession = getKillzoneSession(scanReference.getTime());
  const targetSession = getRollingTargetSession(currentSession);
  if (!targetSession) return [];

  const alerts = [];

  await Promise.all(SCAN_SYMBOLS.map(async sym => {
    try {
      const k5 = await fetchKlines(sym, '5m', 420);
      if (!k5) return;

      const closed5 = getClosedBars(k5, FIVE_MINUTE_MS, now);
      if (!closed5 || closed5.bars.length < 80) return;

      const scanK5 = closed5.bars;
      const current = closed5.current;
      const prev = closed5.prev;
      if (!current || !prev) return;

      const barSession = getKillzoneSession(current.time);
      if (barSession !== currentSession) return;

      const ranges = buildKillzoneRanges(scanK5);
      const targetRange = [...ranges]
        .reverse()
        .find(range => range.session === targetSession && range.endTime < current.time);

      if (!targetRange) return;

      let event = null;

      if (current.high > targetRange.high && current.close <= targetRange.high && prev.high <= targetRange.high) {
        event = {
          side: 'HIGH',
          type: 'SWEEP_HIGH',
          level: targetRange.high,
          extreme: current.high,
        };
      } else if (current.close > targetRange.high && prev.close <= targetRange.high) {
        event = {
          side: 'HIGH',
          type: 'BREAKOUT_HIGH',
          level: targetRange.high,
          extreme: current.high,
        };
      } else if (current.low < targetRange.low && current.close >= targetRange.low && prev.low >= targetRange.low) {
        event = {
          side: 'LOW',
          type: 'SWEEP_LOW',
          level: targetRange.low,
          extreme: current.low,
        };
      } else if (current.close < targetRange.low && prev.close >= targetRange.low) {
        event = {
          side: 'LOW',
          type: 'BREAKDOWN_LOW',
          level: targetRange.low,
          extreme: current.low,
        };
      }

      if (!event) return;

      const dedupeKey = `${sym}_${targetRange.sessionKey}_${event.side}`;
      if (recentlySentSessionLiquidity.has(dedupeKey)) return;

      recentlySentSessionLiquidity.add(dedupeKey);
      setTimeout(() => recentlySentSessionLiquidity.delete(dedupeKey), 36 * 60 * 60 * 1000);

      alerts.push({
        sym,
        currentSession,
        targetSession: targetRange.session,
        targetSessionKey: targetRange.sessionKey,
        targetHigh: targetRange.high,
        targetLow: targetRange.low,
        price: current.close,
        ...event,
      });
    } catch (_) {}
  }));

  return alerts;
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const ctx = getCronContext(now);
  const scanReference = getScanReference(now);
  const scanCtx = getCronContext(scanReference);
  const twTime = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const etTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const scanReferenceEt = scanReference.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const sendErrors = [];

  try {
    const shouldRunFiveMinuteScans = shouldRunSignalScans(now);
    const tpslEvents = await syncTrackableSignalStatuses(now);

    for (const event of tpslEvents) {
      const emoji = event.status === 'TP_HIT' ? '🎯' : '🛑';
      const statusLabel = event.status === 'TP_HIT' ? 'TP Hit' : 'SL Hit';
      const entry = event.entryHigh > 0 ? event.entryHigh : event.entryLow;
      const msg = [
        `${emoji} <b>${event.symbol} ${statusLabel}</b>`,
        `方向：<b>${event.direction}</b> | Strategy：<b>${event.strategyName || event.strategyId}</b>`,
        '',
        `💰 現價：<code>${fmt(event.price)}</code>`,
        `📍 Entry：<code>${fmt(entry)}</code>`,
        `🛡️ Stop：<code>${fmt(event.stop)}</code>`,
        `🎯 Target：<code>${fmt(event.target)}</code>`,
        `⏰ TW ${twTime}`,
        `⏰ ET ${etTime}`,
      ].join('\n');
      await safeSendTelegram(msg, sendErrors, 'tpsl');
    }

    let killzoneSignals = [];
    let persistedKillzoneSignals = [];
    let sessionLiquiditySignals = [];
    let killzoneDuplicatesSkipped = 0;

    if (shouldRunFiveMinuteScans && (scanCtx.inLondonKillzone || scanCtx.inNyKillzone)) {
      killzoneSignals = await runICTKillzoneOpt3Scan(now);
      const { saved, existingSignalKeys, changes } = await persistKillzoneSignals(killzoneSignals, now.toISOString());
      persistedKillzoneSignals = saved;
      killzoneDuplicatesSkipped = changes.filter(change => change.previous).length;

      for (const s of killzoneSignals) {
        if (existingSignalKeys.has(s.signalKey)) continue;

        const emoji = s.direction === 'LONG' ? '🟢' : '🔴';
        const fvgText = s.fvgLow > 0 && s.fvgHigh > 0
          ? `📦 FVG：<code>${fmt(s.fvgLow)} – ${fmt(s.fvgHigh)}</code>`
          : `📦 FVG：<code>無</code>`;
        const msg = [
          `${emoji} <b>${s.sym} ICT Killzone Opt3</b>`,
          `Session：<b>${s.currentSession}</b> | Setup：<b>${s.setupType}</b>`,
          `Bias：<b>${s.bias}</b>`,
          '',
          `💰 現價：<code>${fmt(s.price)}</code>`,
          `📍 Entry：<code>${fmt(s.entry)}</code>`,
          `🛡️ Stop：<code>${fmt(s.stop)}</code>`,
          `🎯 Target：<code>${fmt(s.target)}</code>`,
          `⚖️ R/R：<code>${s.rr.toFixed(2)}</code>`,
          '',
          `🌏 Asia：<code>${fmt(s.asiaLow)} – ${fmt(s.asiaHigh)}</code>`,
          s.orHigh > 0 && s.orLow > 0 ? `🗽 OR：<code>${fmt(s.orLow)} – ${fmt(s.orHigh)}</code>` : '',
          `🪤 Sweep：<code>${s.sweepSide}</code> @ <code>${fmt(s.sweepLevel)}</code>`,
          `📉 MSS：<code>${fmt(s.mssLevel)}</code>`,
          fvgText,
          `⏰ TW ${twTime}`,
          `⏰ ET ${etTime}`,
        ].filter(Boolean).join('\n');
        await safeSendTelegram(msg, sendErrors, 'killzone');
      }
    }

    if (shouldRunFiveMinuteScans && scanCtx.activeKillzoneSession !== 'Off-Hours') {
      const killzonePlanBySymbol = new Map(killzoneSignals.map(signal => [signal.sym, signal]));
      sessionLiquiditySignals = await runSessionLiquidityScan(now);
      for (const s of sessionLiquiditySignals) {
        const isBullishEvent = s.type === 'BREAKOUT_HIGH' || s.type === 'SWEEP_LOW';
        const emoji = isBullishEvent ? '🟢' : '🔴';
        const linkedKillzonePlan = killzonePlanBySymbol.get(s.sym);
        const eventLabel =
          s.type === 'BREAKOUT_HIGH' ? '突破前高' :
          s.type === 'BREAKDOWN_LOW' ? '跌破前低' :
          s.type === 'SWEEP_HIGH' ? '掃前高後收回' :
          '掃前低後收回';
        const tradePlanLines = linkedKillzonePlan
          ? [
              '',
              `📌 同輪 Killzone Setup：<b>${linkedKillzonePlan.setupType}</b>`,
              `📍 Entry：<code>${fmt(linkedKillzonePlan.entry)}</code>`,
              `🛡️ Stop：<code>${fmt(linkedKillzonePlan.stop)}</code>`,
              `🎯 Target：<code>${fmt(linkedKillzonePlan.target)}</code>`,
              `⚖️ R/R：<code>${linkedKillzonePlan.rr.toFixed(2)}</code>`,
            ]
          : [];
        const msg = [
          `${emoji} <b>${s.sym} Session Liquidity</b>`,
          `當前時段：<b>${s.currentSession}</b> | 目標：<b>${s.targetSession}</b>`,
          `事件：<b>${eventLabel}</b>`,
          '',
          `📍 ${s.targetSession} High：<code>${fmt(s.targetHigh)}</code>`,
          `📍 ${s.targetSession} Low：<code>${fmt(s.targetLow)}</code>`,
          `🎯 觸發位：<code>${fmt(s.level)}</code>`,
          `🪤 Extreme：<code>${fmt(s.extreme)}</code>`,
          `💰 現價：<code>${fmt(s.price)}</code>`,
          ...tradePlanLines,
          '',
          `🔁 同一個 ${s.targetSession} 區間的 ${s.side} 只提醒一次`,
          `⏰ TW ${twTime}`,
          `⏰ ET ${etTime}`,
        ].join('\n');
        await safeSendTelegram(msg, sendErrors, 'session_liquidity');
      }
    }

    res.status(200).json({
      ok: sendErrors.length === 0,
      nowTw: twTime,
      nowEt: etTime,
      scanReferenceEt,
      windows: {
        inAsiaSession: ctx.inAsiaSession,
        inLondonKillzone: ctx.inLondonKillzone,
        inNyKillzone: ctx.inNyKillzone,
        inNyOpeningRange: ctx.inNyOpeningRange,
        activeKillzoneSession: ctx.activeKillzoneSession,
        scanSession: scanCtx.activeKillzoneSession,
      },
      ran: {
        fiveMinuteSignalScan: shouldRunFiveMinuteScans,
        killzone: shouldRunFiveMinuteScans && (scanCtx.inLondonKillzone || scanCtx.inNyKillzone),
        sessionLiquidity: shouldRunFiveMinuteScans && scanCtx.activeKillzoneSession !== 'Off-Hours',
        tpslTracking: true,
      },
      counts: {
        killzone: killzoneSignals.length,
        killzoneStored: persistedKillzoneSignals.length,
        killzoneDuplicatesSkipped,
        sessionLiquidity: sessionLiquiditySignals.length,
        tpslUpdated: tpslEvents.length,
      },
      updatedSignals: tpslEvents.map(event => ({
        signalKey: event.signalKey,
        symbol: event.symbol,
        status: event.status,
      })),
      sendErrors,
    });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
}
