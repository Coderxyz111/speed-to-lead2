// Telegram alerts to the remodeller (and a copy to you as admin).

function makeNotifier({ botToken, adminChatId, fetchImpl = fetch, log = console }) {
  async function send(chatId, text) {
    if (!botToken || !chatId) return;
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (!res.ok) log.error('Telegram send failed', res.status, await res.text());
    } catch (e) {
      log.error('Telegram send error', e.message);
    }
  }
  return async function notify(client, text) {
    const targets = new Set([client?.telegram_chat_id, adminChatId].filter(Boolean));
    await Promise.all([...targets].map(id => send(id, text)));
  };
}

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function phoneLink(lead) {
  return lead.whatsapp_id ? `+${lead.whatsapp_id}` : esc(lead.phone_raw || 'no number');
}

module.exports = { makeNotifier, esc, phoneLink };
