const LEGACY_TERMINAL_SIGNAL_STATUSES = new Set(['TP_HIT', 'SL_HIT']);
const OPEN_SIGNAL_LIFECYCLE_STATES = ['WAITING_CONFIRM', 'WAITING_RETEST', 'ACTIVE_TRADE', 'LIVE_SIGNAL'];
const OPEN_SIGNAL_LIFECYCLE_STATE_SET = new Set(OPEN_SIGNAL_LIFECYCLE_STATES);
const TRACKABLE_SIGNAL_LIFECYCLE_STATES = ['LIVE_SIGNAL', 'ACTIVE_TRADE'];

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('Missing SUPABASE_URL');
  }
  if (!key) {
    throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  }

  return { url, key };
}

async function parseSupabaseError(response) {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;

  try {
    const json = JSON.parse(text);
    return json.message || json.error_description || json.error || text;
  } catch {
    return text;
  }
}

async function supabaseRequest(path, init = {}) {
  const { url, key } = getSupabaseConfig();
  const headers = new Headers(init.headers || {});

  headers.set('apikey', key);
  headers.set('Authorization', `Bearer ${key}`);

  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const message = await parseSupabaseError(response);
    throw new Error(`Supabase request failed: ${message}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteFilterValue(value) {
  const normalized = normalizeText(value);
  return `"${normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSignalFingerprint(signal) {
  return [
    normalizeText(signal?.signalKey || signal?.signal_key || signal?.id, 'signal'),
    normalizeText(signal?.status, 'OPEN'),
    normalizeText(signal?.lifecycleState || signal?.lifecycle_state, 'LIVE_SIGNAL'),
    normalizeText(signal?.closeReason || signal?.close_reason, 'OPEN'),
    normalizeText(signal?.closeOutcome || signal?.close_outcome, 'OPEN'),
  ].join('|');
}

function isClosedSignalStatus(status) {
  const normalized = normalizeText(status);
  return normalized === 'CLOSED' || LEGACY_TERMINAL_SIGNAL_STATUSES.has(normalized);
}

function isOpenSignalStatus(status) {
  const normalized = normalizeText(status);
  return normalized === 'OPEN' || OPEN_SIGNAL_LIFECYCLE_STATE_SET.has(normalized);
}

function isFilledSignalLifecycleState(lifecycleState) {
  const normalized = normalizeText(lifecycleState);
  return normalized === 'LIVE_SIGNAL' || normalized === 'ACTIVE_TRADE';
}

function getSignalDateKey(input) {
  const date = input instanceof Date ? input : new Date(input || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year || '0000'}-${map.month || '00'}-${map.day || '00'}`;
}

function buildSignalConflictKey(signal) {
  const strategyId = normalizeText(signal?.strategyId || signal?.strategy_id, 'unknown');
  const symbol = normalizeText(signal?.symbol, 'UNKNOWN');
  const session = normalizeText(signal?.session);
  const dateKey = getSignalDateKey(signal?.createdAt || signal?.created_at || signal?.updatedAt || signal?.updated_at);

  if (strategyId === 'ict_killzone_opt3') {
    return [strategyId, symbol, session || 'Off-Hours', dateKey].join('|');
  }

  if (strategyId === 'smc_session') {
    return [strategyId, symbol, session || 'Session', dateKey].join('|');
  }

  return [strategyId, symbol, dateKey].join('|');
}

function buildSignalRolloverKey(signal) {
  return [
    normalizeText(signal?.strategyId || signal?.strategy_id, 'unknown'),
    normalizeText(signal?.symbol, 'UNKNOWN'),
  ].join('|');
}

function normalizeSignalLifecycle(signal) {
  const rawStatus = normalizeText(signal?.status);
  const rawLifecycleState = normalizeText(signal?.lifecycleState || signal?.lifecycle_state);
  const rawCloseReason = normalizeText(signal?.closeReason || signal?.close_reason);
  const rawCloseOutcome = normalizeText(signal?.closeOutcome || signal?.close_outcome);

  if (rawStatus === 'TP_HIT') {
    return {
      status: 'CLOSED',
      lifecycleState: rawLifecycleState || 'ACTIVE_TRADE',
      closeReason: 'TP',
      closeOutcome: 'PROFIT',
    };
  }

  if (rawStatus === 'SL_HIT') {
    return {
      status: 'CLOSED',
      lifecycleState: rawLifecycleState || 'ACTIVE_TRADE',
      closeReason: 'SL',
      closeOutcome: 'LOSS',
    };
  }

  if (OPEN_SIGNAL_LIFECYCLE_STATE_SET.has(rawStatus)) {
    return {
      status: 'OPEN',
      lifecycleState: rawStatus,
      closeReason: undefined,
      closeOutcome: undefined,
    };
  }

  if (rawStatus === 'CLOSED') {
    return {
      status: 'CLOSED',
      lifecycleState: rawLifecycleState || (rawCloseReason === 'TP' || rawCloseReason === 'SL' ? 'ACTIVE_TRADE' : 'LIVE_SIGNAL'),
      closeReason: rawCloseReason || undefined,
      closeOutcome: rawCloseOutcome || undefined,
    };
  }

  if (rawStatus === 'OPEN') {
    return {
      status: 'OPEN',
      lifecycleState: OPEN_SIGNAL_LIFECYCLE_STATE_SET.has(rawLifecycleState) ? rawLifecycleState : 'LIVE_SIGNAL',
      closeReason: undefined,
      closeOutcome: undefined,
    };
  }

  if (rawCloseReason || rawCloseOutcome) {
    return {
      status: 'CLOSED',
      lifecycleState: OPEN_SIGNAL_LIFECYCLE_STATE_SET.has(rawLifecycleState) ? rawLifecycleState : 'LIVE_SIGNAL',
      closeReason: rawCloseReason || undefined,
      closeOutcome: rawCloseOutcome || undefined,
    };
  }

  return {
    status: 'OPEN',
    lifecycleState: OPEN_SIGNAL_LIFECYCLE_STATE_SET.has(rawLifecycleState) ? rawLifecycleState : 'LIVE_SIGNAL',
    closeReason: undefined,
    closeOutcome: undefined,
  };
}

function getReferenceEntryPrice(signal) {
  const entryLow = normalizeNumber(signal?.entryLow ?? signal?.entry_low);
  const entryHigh = normalizeNumber(signal?.entryHigh ?? signal?.entry_high);
  const entryMin = entryLow > 0 && entryHigh > 0 ? Math.min(entryLow, entryHigh) : (entryLow || entryHigh);
  const entryMax = entryLow > 0 && entryHigh > 0 ? Math.max(entryLow, entryHigh) : (entryHigh || entryLow);
  const direction = normalizeText(signal?.direction, 'NEUTRAL');

  if (direction === 'SHORT') return entryMin;
  if (direction === 'LONG') return entryMax;
  return entryHigh || entryLow;
}

function resolveClosedSignalOutcome(signal, price) {
  if (!isFilledSignalLifecycleState(signal?.lifecycleState)) {
    return 'NOT_FILLED';
  }

  const normalizedPrice = normalizeNumber(price);
  const entryPrice = getReferenceEntryPrice(signal);
  if (!(normalizedPrice > 0) || !(entryPrice > 0)) {
    return null;
  }

  const direction = normalizeText(signal?.direction, 'NEUTRAL');
  if (direction === 'LONG') {
    if (normalizedPrice > entryPrice) return 'PROFIT';
    if (normalizedPrice < entryPrice) return 'LOSS';
    return 'FLAT';
  }

  if (direction === 'SHORT') {
    if (normalizedPrice < entryPrice) return 'PROFIT';
    if (normalizedPrice > entryPrice) return 'LOSS';
    return 'FLAT';
  }

  return 'FLAT';
}

function buildClosedSignal(signal, closeReason, updatedAt = new Date().toISOString(), price) {
  const item = normalizeSignalItem(signal);
  let closeOutcome;

  if (closeReason === 'TP') {
    closeOutcome = 'PROFIT';
  } else if (closeReason === 'SL') {
    closeOutcome = 'LOSS';
  } else {
    closeOutcome = resolveClosedSignalOutcome(item, price);
  }

  if (!closeOutcome) {
    return null;
  }

  const nextItem = {
    ...item,
    status: 'CLOSED',
    closeReason,
    closeOutcome,
    updatedAt: normalizeText(updatedAt, new Date().toISOString()),
  };

  return {
    ...nextItem,
    fingerprint: buildSignalFingerprint(nextItem),
  };
}

function normalizeSignalItem(signal) {
  const strategyId = normalizeText(signal?.strategyId || signal?.strategy_id, 'unknown');
  const strategyName = normalizeText(signal?.strategyName || signal?.strategy_name, strategyId);
  const updatedAt = normalizeText(signal?.updatedAt || signal?.updated_at, new Date().toISOString());
  const createdAt = normalizeText(signal?.createdAt || signal?.created_at, updatedAt);
  const signalKey = normalizeText(signal?.signalKey || signal?.signal_key || signal?.fingerprint || signal?.id);

  if (!signalKey) {
    throw new Error('signalKey is required');
  }

  const lifecycle = normalizeSignalLifecycle(signal);
  const item = {
    id: signalKey,
    signalKey,
    symbol: normalizeText(signal?.symbol),
    strategyId,
    strategyName,
    direction: normalizeText(signal?.direction, 'NEUTRAL'),
    regime: normalizeText(signal?.regime),
    status: lifecycle.status,
    lifecycleState: lifecycle.lifecycleState,
    closeReason: lifecycle.closeReason,
    closeOutcome: lifecycle.closeOutcome,
    session: signal?.session ?? undefined,
    setupType: signal?.setupType ?? signal?.setup_type ?? undefined,
    bias: signal?.bias ?? undefined,
    entryLow: normalizeNumber(signal?.entryLow ?? signal?.entry_low),
    entryHigh: normalizeNumber(signal?.entryHigh ?? signal?.entry_high),
    stop: normalizeNumber(signal?.stop),
    target: normalizeNumber(signal?.target),
    rr: normalizeNumber(signal?.rr),
    marketPrice: normalizeNumber(signal?.marketPrice ?? signal?.market_price ?? signal?.price),
    createdAt,
    updatedAt,
  };

  return {
    ...item,
    fingerprint: normalizeText(signal?.fingerprint, buildSignalFingerprint(item)),
    conflictKey: normalizeText(signal?.conflictKey, buildSignalConflictKey(item)),
  };
}

function toSignalRow(signal) {
  const item = normalizeSignalItem(signal);

  return {
    signal_key: item.signalKey,
    fingerprint: buildSignalFingerprint(item),
    symbol: item.symbol,
    strategy_id: item.strategyId,
    strategy_name: item.strategyName,
    direction: item.direction,
    regime: item.regime,
    status: item.status,
    lifecycle_state: item.lifecycleState,
    close_reason: item.closeReason ?? null,
    close_outcome: item.closeOutcome ?? null,
    session: item.session ?? null,
    setup_type: item.setupType ?? null,
    bias: item.bias ?? null,
    entry_low: item.entryLow,
    entry_high: item.entryHigh,
    stop: item.stop,
    target: item.target,
    rr: item.rr,
    updated_at: item.updatedAt,
  };
}

function toSignalFeedItem(row) {
  const item = {
    id: row.signal_key,
    signalKey: row.signal_key,
    symbol: row.symbol,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    direction: row.direction,
    regime: row.regime,
    status: row.status,
    lifecycleState: row.lifecycle_state || 'LIVE_SIGNAL',
    closeReason: row.close_reason || undefined,
    closeOutcome: row.close_outcome || undefined,
    session: row.session || undefined,
    setupType: row.setup_type || undefined,
    bias: row.bias || undefined,
    entryLow: normalizeNumber(row.entry_low),
    entryHigh: normalizeNumber(row.entry_high),
    stop: normalizeNumber(row.stop),
    target: normalizeNumber(row.target),
    rr: normalizeNumber(row.rr),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  return {
    ...item,
    fingerprint: row.fingerprint || buildSignalFingerprint(item),
    conflictKey: buildSignalConflictKey(item),
  };
}

function compareSignalItemsByUpdatedAt(a, b) {
  const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();

  if (aTime !== bTime) return aTime - bTime;
  return String(a.signalKey).localeCompare(String(b.signalKey));
}

function upsertSignalCollection(prev, nextSignal) {
  const nextItem = normalizeSignalItem(nextSignal);
  const existing = prev.find(item => item.signalKey === nextItem.signalKey);
  const nextConflictKey = nextItem.conflictKey || buildSignalConflictKey(nextItem);

  const remaining = prev.filter(item => {
    if (item.signalKey === nextItem.signalKey) return false;
    const itemConflictKey = item.conflictKey || buildSignalConflictKey(item);
    if (itemConflictKey !== nextConflictKey) return true;
    return isClosedSignalStatus(item.status);
  });

  const merged = existing
    ? (() => {
        const base = {
          ...existing,
          ...nextItem,
          conflictKey: nextConflictKey,
          createdAt: existing.createdAt,
          updatedAt: nextItem.updatedAt,
        };

        if (isClosedSignalStatus(existing.status)) {
          base.status = 'CLOSED';
          base.lifecycleState = existing.lifecycleState;
          base.closeReason = existing.closeReason;
          base.closeOutcome = existing.closeOutcome;
        }

        base.fingerprint = buildSignalFingerprint(base);
        return base;
      })()
    : {
        ...nextItem,
        conflictKey: nextConflictKey,
        fingerprint: buildSignalFingerprint(nextItem),
      };

  return [merged, ...remaining];
}

function normalizeSignalItems(items, limit = Infinity) {
  const normalized = (Array.isArray(items) ? items : [items])
    .filter(Boolean)
    .map(item => normalizeSignalItem(item))
    .sort(compareSignalItemsByUpdatedAt);

  const merged = normalized.reduce((acc, item) => upsertSignalCollection(acc, item), []);
  return Number.isFinite(limit) ? merged.slice(0, limit) : merged;
}

function buildSignalQuery(limitOrOptions = 30, dedupe = true) {
  const options = typeof limitOrOptions === 'number'
    ? { limit: limitOrOptions }
    : (limitOrOptions || {});

  const safeLimit = Math.min(Math.max(Number(options.limit) || 30, 1), dedupe ? 200 : 400);
  const requestLimit = dedupe
    ? Math.min(Math.max(safeLimit * 4, safeLimit), 400)
    : safeLimit;
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'updated_at.desc');
  params.set('limit', String(requestLimit));

  if (Array.isArray(options.statuses) && options.statuses.length > 0) {
    params.set('status', `in.(${options.statuses.map(quoteFilterValue).join(',')})`);
  }

  if (Array.isArray(options.lifecycleStates) && options.lifecycleStates.length > 0) {
    params.set('lifecycle_state', `in.(${options.lifecycleStates.map(quoteFilterValue).join(',')})`);
  }

  if (Array.isArray(options.signalKeys) && options.signalKeys.length > 0) {
    params.set('signal_key', `in.(${options.signalKeys.map(quoteFilterValue).join(',')})`);
  }

  if (Array.isArray(options.symbols) && options.symbols.length > 0) {
    params.set('symbol', `in.(${options.symbols.map(quoteFilterValue).join(',')})`);
  }

  if (Array.isArray(options.strategyIds) && options.strategyIds.length > 0) {
    params.set('strategy_id', `in.(${options.strategyIds.map(quoteFilterValue).join(',')})`);
  }

  return { safeLimit, params };
}

async function fetchSignals(limitOrOptions = 30, dedupe = true) {
  const { safeLimit, params } = buildSignalQuery(limitOrOptions, dedupe);
  const rows = await supabaseRequest(`/signals?${params.toString()}`, {
    method: 'GET',
  });
  const items = Array.isArray(rows) ? rows.map(toSignalFeedItem) : [];
  return dedupe ? normalizeSignalItems(items, safeLimit) : items;
}

async function listRawSignals(limitOrOptions = 30) {
  return fetchSignals(limitOrOptions, false);
}

export async function listSignals(limitOrOptions = 30) {
  return fetchSignals(limitOrOptions, true);
}

export async function listSignalsByKeys(signalKeys) {
  const normalized = [...new Set((Array.isArray(signalKeys) ? signalKeys : []).filter(Boolean))];
  if (normalized.length === 0) return [];

  return listRawSignals({
    limit: Math.min(Math.max(normalized.length, 1), 400),
    signalKeys: normalized,
  });
}

export async function listOpenSignals(limitOrOptions = 100) {
  const options = typeof limitOrOptions === 'number'
    ? { limit: limitOrOptions }
    : (limitOrOptions || {});

  return listSignals({
    ...options,
    statuses: ['OPEN'],
  });
}

export async function listTrackableSignals(limit = 100) {
  return listSignals({
    limit,
    statuses: ['OPEN'],
    lifecycleStates: TRACKABLE_SIGNAL_LIFECYCLE_STATES,
  });
}

export async function upsertSignalsWithMeta(input) {
  const normalizedIncoming = normalizeSignalItems(Array.isArray(input) ? input : [input], 500);
  const incomingByRollover = new Map();
  const incomingClosed = [];

  [...normalizedIncoming]
    .sort(compareSignalItemsByUpdatedAt)
    .forEach(item => {
      if (isOpenSignalStatus(item.status)) {
        incomingByRollover.set(buildSignalRolloverKey(item), item);
      } else {
        incomingClosed.push(item);
      }
    });

  const incoming = [...incomingClosed, ...incomingByRollover.values()];
  if (incoming.length === 0) {
    return { items: [], changes: [] };
  }

  const signalKeys = incoming.map(item => item.signalKey);
  const symbols = [...new Set(incoming.map(item => item.symbol).filter(Boolean))];
  const strategyIds = [...new Set(incoming.map(item => item.strategyId).filter(Boolean))];
  const rolloverKeysToReplace = new Set(
    incoming
      .filter(item => isOpenSignalStatus(item.status))
      .map(item => buildSignalRolloverKey(item))
  );

  const [existingExact, activeCandidates] = await Promise.all([
    listSignalsByKeys(signalKeys),
    rolloverKeysToReplace.size > 0
      ? listRawSignals({
          limit: Math.min(Math.max(incoming.length * 12, 100), 400),
          statuses: ['OPEN'],
          symbols,
          strategyIds,
        })
      : Promise.resolve([]),
  ]);

  const exactByKey = new Map(existingExact.map(item => [item.signalKey, item]));
  const desiredIncoming = incoming.map(item => {
    const existing = exactByKey.get(item.signalKey);
    if (existing && isClosedSignalStatus(existing.status)) {
      return {
        ...existing,
        ...item,
        status: 'CLOSED',
        lifecycleState: existing.lifecycleState,
        closeReason: existing.closeReason,
        closeOutcome: existing.closeOutcome,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        fingerprint: existing.fingerprint,
      };
    }
    return item;
  });

  const desiredIncomingByRollover = new Map(
    desiredIncoming
      .filter(item => isOpenSignalStatus(item.status))
      .map(item => [buildSignalRolloverKey(item), item])
  );

  const supersededSignals = activeCandidates
    .map(item => {
      if (!isOpenSignalStatus(item.status)) return null;
      const nextIncoming = desiredIncomingByRollover.get(buildSignalRolloverKey(item));
      if (!nextIncoming || nextIncoming.signalKey === item.signalKey) return null;
      return buildClosedSignal(item, 'SUPERSEDED', nextIncoming.updatedAt, nextIncoming.marketPrice);
    })
    .filter(Boolean);

  const rows = [...supersededSignals, ...desiredIncoming].map(toSignalRow);
  const savedRows = await supabaseRequest('/signals?on_conflict=signal_key', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });

  const savedItems = Array.isArray(savedRows)
    ? normalizeSignalItems(savedRows.map(toSignalFeedItem), desiredIncoming.length + supersededSignals.length)
    : [];
  const savedByKey = new Map(savedItems.map(item => [item.signalKey, item]));

  const changes = desiredIncoming.map(item => ({
    previous: exactByKey.get(item.signalKey) || null,
    current: savedByKey.get(item.signalKey) || item,
  }));

  const affectedItems = normalizeSignalItems([
    ...desiredIncoming.map(item => savedByKey.get(item.signalKey) || item),
    ...supersededSignals.map(item => savedByKey.get(item.signalKey) || item),
  ], desiredIncoming.length + supersededSignals.length);

  return { items: affectedItems, changes };
}

export async function upsertSignals(input) {
  const { items } = await upsertSignalsWithMeta(input);
  return items;
}

export async function updateSignalStatuses(updates) {
  const normalized = Array.isArray(updates) ? updates : [];

  await Promise.all(
    normalized
      .filter(update => update?.signalKey && update?.status)
      .map(update =>
        supabaseRequest(`/signals?signal_key=eq.${encodeURIComponent(update.signalKey)}`, {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            status: normalizeText(update.status, 'OPEN'),
            lifecycle_state: normalizeText(update.lifecycleState, 'LIVE_SIGNAL'),
            close_reason: update.closeReason ?? null,
            close_outcome: update.closeOutcome ?? null,
            updated_at: normalizeText(update.updatedAt, new Date().toISOString()),
          }),
        })
      )
  );
}

export async function clearSignals() {
  await supabaseRequest('/signals?signal_key=not.is.null', {
    method: 'DELETE',
    headers: {
      Prefer: 'return=minimal',
    },
  });
}
