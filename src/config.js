const fs = require('fs');
const path = require('path');

function required(name) {
  const v = process.env[name];
  if (!v && process.env.DRY_RUN !== 'true') throw new Error(`Missing env var ${name}`);
  return v || '';
}

function loadClients(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clients = raw.clients || [];
  for (const c of clients) {
    for (const k of ['id', 'business_name', 'facebook_page_id', 'whatsapp_phone_number_id', 'elevenlabs_agent_id', 'permission_template_name']) {
      if (!c[k]) throw new Error(`Client "${c.id || '?'}" in ${file} is missing "${k}"`);
    }
    c.permission_template_language = c.permission_template_language || 'en';
    c.country = c.country || 'SG';
    c.timezone = c.timezone || 'Asia/Singapore';
    c.call_hours = c.call_hours || { start: '09:00', end: '21:00', days: [1, 2, 3, 4, 5, 6] };
  }
  return clients;
}

function loadConfig() {
  const clientsFile = process.env.CLIENTS_FILE || path.join(__dirname, '..', 'clients.json');
  return {
    port: Number(process.env.PORT || 3000),
    dryRun: process.env.DRY_RUN === 'true',
    fbVerifyToken: required('FB_VERIFY_TOKEN'),
    fbAppSecret: required('FB_APP_SECRET'),
    fbPageAccessToken: required('FB_PAGE_ACCESS_TOKEN'),
    graphVersion: process.env.GRAPH_API_VERSION || 'v23.0',
    elevenApiKey: required('ELEVENLABS_API_KEY'),
    elevenBaseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io',
    elevenWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || '',
    fallbackAfterMinutes: Number(process.env.FALLBACK_AFTER_MINUTES || 10),
    dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leads.db'),
    clients: loadClients(clientsFile),
  };
}

module.exports = { loadConfig, loadClients };
