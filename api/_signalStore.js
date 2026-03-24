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
  return Number.isFinite(value) ? value : 0;
}

function toSignalRow(signal) {
  const signalKey = normalizeText(signal?.signalKey || signal?.signal_key || signal?.fingerprint || signal?.id);
  if (!signalKey) {
    throw new Error('signalKey is required');
  }

  const updatedAt = normalizeText(signal?.updatedAt || signal?.updated_at, new Date().toISOString());

  return {
    signal_key: signalKey,
    fingerprint: normalizeText(signal?.fingerprint, signalKey),
    symbol: normalizeText(signal?.symbol),
    strategy_id: normalizeText(signal?.strategyId || signal?.strategy_id),
    strategy_name: normalizeText(signal?.strategyName || signal?.strategy_name),
    direction: normalizeText(signal?.direction, 'NEUTRAL'),
    regime: normalizeText(signal?.regime),
    status: normalizeText(signal?.status, 'LIVE_SIGNAL'),
    session: signal?.session ?? null,
    setup_type: signal?.setupType ?? signal?.setup_type ?? null,
    bias: signal?.bias ?? null,
    entry_low: normalizeNumber(signal?.entryLow ?? signal?.entry_low),
    entry_high: normalizeNumber(signal?.entryHigh ?? signal?.entry_high),
    stop: normalizeNumber(signal?.stop),
    target: normalizeNumber(signal?.target),
    rr: normalizeNumber(signal?.rr),
    updated_at: updatedAt,
  };
}

function toSignalFeedItem(row) {
  return {
    id: row.signal_key,
    signalKey: row.signal_key,
    fingerprint: row.fingerprint || row.signal_key,
    symbol: row.symbol,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    direction: row.direction,
    regime: row.regime,
    status: row.status,
    session: row.session || undefined,
    setupType: row.setup_type || undefined,
    bias: row.bias || undefined,
    entryLow: Number(row.entry_low) || 0,
    entryHigh: Number(row.entry_high) || 0,
    stop: Number(row.stop) || 0,
    target: Number(row.target) || 0,
    rr: Number(row.rr) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSignals(limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = await supabaseRequest(`/signals?select=*&order=updated_at.desc&limit=${safeLimit}`, {
    method: 'GET',
  });
  return Array.isArray(rows) ? rows.map(toSignalFeedItem) : [];
}

export async function upsertSignals(input) {
  const signals = Array.isArray(input) ? input : [input];
  const rows = signals.filter(Boolean).map(toSignalRow);
  if (rows.length === 0) return [];

  const saved = await supabaseRequest('/signals?on_conflict=signal_key', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });

  return Array.isArray(saved) ? saved.map(toSignalFeedItem) : [];
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
            status: update.status,
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
