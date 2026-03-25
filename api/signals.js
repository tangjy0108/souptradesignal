import { clearSignals, listSignals, updateSignalStatuses, upsertSignalsWithMeta } from './_signalStore.js';
import { sendTelegram } from './_telegram.js';

const TG_NOTIFY_LIFECYCLE_STATES = new Set(['LIVE_SIGNAL', 'WAITING_CONFIRM']);

function readJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return '0';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

function formatStatusLabel(item) {
  if (!item) return '';
  if (item.status === 'OPEN') {
    return String(item.lifecycleState || 'LIVE_SIGNAL').split('_').join(' ');
  }
  return [item.closeReason, item.closeOutcome].filter(Boolean).join(' ');
}

function shouldNotifySignalChange(previous, current) {
  if (!current || current.status !== 'OPEN') return false;
  if (!TG_NOTIFY_LIFECYCLE_STATES.has(current.lifecycleState)) return false;

  // Killzone LIVE signals are already handled by backend cron; avoid double Telegram sends when the app is open.
  if (current.strategyId === 'ict_killzone_opt3' && current.lifecycleState === 'LIVE_SIGNAL') {
    return false;
  }

  if (!previous) return true;

  return previous.status !== current.status
    || previous.lifecycleState !== current.lifecycleState
    || previous.direction !== current.direction
    || previous.regime !== current.regime
    || previous.signalKey !== current.signalKey;
}

function buildSignalNotificationMessage(item) {
  const emoji = item.lifecycleState === 'WAITING_CONFIRM'
    ? '🟠'
    : item.direction === 'LONG'
      ? '🟢'
      : item.direction === 'SHORT'
        ? '🔴'
        : '🔵';
  const updatedTw = new Date(item.updatedAt || Date.now()).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const lines = [
    emoji + ' <b>' + item.symbol + ' ' + formatStatusLabel(item) + '</b>',
    'Strategy：<b>' + (item.strategyName || item.strategyId) + '</b>',
    '方向：<b>' + (item.direction || 'NEUTRAL') + '</b>',
  ];

  if (item.session) lines.push('Session：<b>' + item.session + '</b>');
  if (item.setupType) lines.push('Setup：<b>' + item.setupType + '</b>');
  if (item.bias) lines.push('Bias：<b>' + item.bias + '</b>');

  lines.push('');
  lines.push('📍 Entry：<code>' + formatPrice(item.entryHigh > 0 ? item.entryHigh : item.entryLow) + '</code>');
  lines.push('🛡️ Stop：<code>' + formatPrice(item.stop) + '</code>');
  lines.push('🎯 Target：<code>' + formatPrice(item.target) + '</code>');
  lines.push('⚖️ R/R：<code>' + Number(item.rr || 0).toFixed(2) + '</code>');
  lines.push('⏰ TW ' + updatedTw);

  return lines.join('\n');
}

async function notifySignalChanges(changes) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return [];
  }

  const errors = [];

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!shouldNotifySignalChange(change.previous, change.current)) continue;

    try {
      await sendTelegram(buildSignalNotificationMessage(change.current));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Signal notification failed:', message);
      errors.push(message);
    }
  }

  return errors;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const items = await listSignals(req.query?.limit);
      return res.status(200).json({ ok: true, items });
    }

    if (req.method === 'POST') {
      const body = readJsonBody(req);
      const payload = body.signals || body.signal || body;
      const notify = body.notify !== false;
      const { items, changes } = await upsertSignalsWithMeta(payload);
      const notifyErrors = notify ? await notifySignalChanges(changes) : [];
      return res.status(200).json({ ok: notifyErrors.length === 0, items, notifyErrors });
    }

    if (req.method === 'PATCH') {
      const body = readJsonBody(req);
      await updateSignalStatuses(body.updates);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await clearSignals();
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET,POST,PATCH,DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Signals API error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
}
