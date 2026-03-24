import { clearSignals, listSignals, updateSignalStatuses, upsertSignals } from './_signalStore.js';

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

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const items = await listSignals(req.query?.limit);
      return res.status(200).json({ ok: true, items });
    }

    if (req.method === 'POST') {
      const body = readJsonBody(req);
      const payload = body.signals || body.signal || body;
      const items = await upsertSignals(payload);
      return res.status(200).json({ ok: true, items });
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
