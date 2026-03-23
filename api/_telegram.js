const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    throw new Error('Telegram env vars not set');
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Telegram API ${res.status}: ${text}`);
  }
  return text;
}
