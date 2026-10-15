process.removeAllListeners('warning');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { normalisePhone } = require('../src/phone');
const { isWithinHours, nextOpening } = require('../src/hours');
const { verifyElevenSignature } = require('../src/elevenlabs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

test('SG phone normalisation', () => {
  assert.equal(normalisePhone('9123 4567'), '6591234567');
  assert.equal(normalisePhone('8123-4567'), '6581234567');
  assert.equal(normalisePhone('+65 9123 4567'), '6591234567');
  assert.equal(normalisePhone('6591234567'), '6591234567');
  assert.equal(normalisePhone('0065 9123 4567'), '6591234567');
  assert.equal(normalisePhone('6123 4567'), null);        // landline: no WhatsApp
  assert.equal(normalisePhone('+65 6123 4567'), null);
  assert.equal(normalisePhone('+60 12 345 6789'), '60123456789'); // Malaysian number passes through
  assert.equal(normalisePhone('12345'), null);
  assert.equal(normalisePhone(''), null);
  assert.equal(normalisePhone('0412 345 678', 'AU'), '61412345678');
});

test('call hours in Singapore', () => {
  const hours = { start: '09:00', end: '21:00', days: [1, 2, 3, 4, 5, 6] };
  const tz = 'Asia/Singapore';
  // Wed 14 Oct 2026 10:00 SGT = 02:00 UTC
  assert.ok(isWithinHours(new Date('2026-10-14T02:00:00Z'), hours, tz));
  // 23:00 SGT = 15:00 UTC -> closed; next opening Thu 09:00 SGT = Thu 01:00 UTC
  const late = new Date('2026-10-14T15:00:00Z');
  assert.ok(!isWithinHours(late, hours, tz));
  assert.equal(nextOpening(late, hours, tz).toISOString(), '2026-10-15T01:00:00.000Z');
  // Sat 23:00 SGT -> Mon 09:00 SGT (Sunday closed)
  assert.equal(nextOpening(new Date('2026-10-17T15:00:00Z'), hours, tz).toISOString(), '2026-10-19T01:00:00.000Z');
});

test('ElevenLabs signature check', () => {
  const body = '{"a":1}', secret = 's3cret', t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.ok(verifyElevenSignature(body, `t=${t},v0=${sig}`, secret));
  assert.ok(!verifyElevenSignature(body, `t=${t},v0=deadbeef`, secret));
});

// ---------- end-to-end with mocked Meta, ElevenLabs, Telegram ----------

function harness({ nowIso = '2026-10-14T02:00:00Z', elevenFails = false, phone = '9123 4567' } = {}) {
  const calls = { graph: [], eleven: [], telegram: [] };
  const fetchImpl = async (url, opts = {}) => {
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (url.startsWith('https://graph.facebook.com')) {
      calls.graph.push(url);
      return ok({ field_data: [
        { name: 'full_name', values: ['Sarah Nguyen'] },
        { name: 'phone_number', values: [phone] },
        { name: 'what_do_you_need_renovated?', values: ['2 toilets'] },
        { name: 'property_type', values: ['HDB 4-room, Tampines'] },
      ] });
    }
    if (url.includes('/v1/convai/whatsapp/outbound-call')) {
      calls.eleven.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      if (elevenFails) return { ok: false, status: 422, json: async () => ({ detail: [{ msg: 'template not approved' }] }) };
      return ok({ success: true, message: 'scheduled', conversation_id: 'conv_123' });
    }
    if (url.startsWith('https://api.telegram.org')) {
      calls.telegram.push(JSON.parse(opts.body));
      return ok({ ok: true });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const config = {
    dryRun: false, fbVerifyToken: 'vt', fbAppSecret: 'appsecret', fbPageAccessToken: 'pat', graphVersion: 'v23.0',
    elevenApiKey: 'xi', elevenBaseUrl: 'https://api.elevenlabs.io', elevenWebhookSecret: 'whsec',
    telegramBotToken: 'tg', adminTelegramChatId: 'admin', fallbackAfterMinutes: 10,
    clients: [{
      id: 'acme', business_name: 'Acme Renovation', service_area: 'all of Singapore', country: 'SG', timezone: 'Asia/Singapore',
      call_hours: { start: '09:00', end: '21:00', days: [1, 2, 3, 4, 5, 6] },
      facebook_page_id: '111', whatsapp_phone_number_id: 'pn_1', elevenlabs_agent_id: 'agent_1',
      permission_template_name: 'acme_tpl', permission_template_language: 'en', telegram_chat_id: 'client_chat',
    }],
  };
  const db = openDb(':memory:');
  const quiet = { info() {}, warn() {}, error() {} };
  const app = createApp({ config, db, fetchImpl, log: quiet, now: () => new Date(nowIso) });
  return { ...app, db, calls, config };
}

const leadEvent = { leadgen_id: 'L1', page_id: '111', form_id: 'F1', ad_id: null };

test('new lead in hours -> ElevenLabs WhatsApp call requested with lead context', async () => {
  const h = harness();
  await h.handleLeadEvent(leadEvent);
  assert.equal(h.calls.eleven.length, 1);
  const req = h.calls.eleven[0];
  assert.equal(req.headers['xi-api-key'], 'xi');
  assert.equal(req.body.whatsapp_user_id, '6591234567');
  assert.equal(req.body.whatsapp_phone_number_id, 'pn_1');
  assert.equal(req.body.whatsapp_call_permission_request_template_name, 'acme_tpl');
  assert.equal(req.body.agent_id, 'agent_1');
  const v = req.body.conversation_initiation_client_data.dynamic_variables;
  assert.equal(v.lead_first_name, 'Sarah');
  assert.equal(v.lead_id, 'L1');
  assert.match(v.form_answers, /2 toilets/);
  assert.doesNotMatch(v.form_answers, /9123/);
  assert.equal(h.db.get('L1').status, 'call_requested');
  assert.equal(h.db.get('L1').conversation_id, 'conv_123');
  // client + admin both alerted
  assert.deepEqual(h.calls.telegram.map(m => m.chat_id).sort(), ['admin', 'client_chat']);
});

test('duplicate webhook does not double-call', async () => {
  const h = harness();
  await h.handleLeadEvent(leadEvent);
  await h.handleLeadEvent(leadEvent);
  assert.equal(h.calls.eleven.length, 1);
});

test('lead at night is queued, then called by the sweeper', async () => {
  const h = harness({ nowIso: '2026-10-14T15:00:00Z' });
  await h.handleLeadEvent(leadEvent);
  assert.equal(h.calls.eleven.length, 0);
  assert.equal(h.db.get('L1').status, 'queued');
  assert.match(h.calls.telegram[0].text, /Outside call hours/);
  h.db.update('L1', { due_at: Date.now() - 1 });
  await h.sweep();
  assert.equal(h.calls.eleven.length, 1);
  assert.equal(h.db.get('L1').status, 'call_requested');
});

test('bad phone number -> manual-call alert, no AI call', async () => {
  const h = harness({ phone: '6123 4567' });
  await h.handleLeadEvent(leadEvent);
  assert.equal(h.calls.eleven.length, 0);
  assert.equal(h.db.get('L1').status, 'bad_phone');
  assert.match(h.calls.telegram[0].text, /Couldn't read a valid mobile/);
});

test('ElevenLabs error -> lead marked failed and remodeller told to call', async () => {
  const h = harness({ elevenFails: true });
  await h.handleLeadEvent(leadEvent);
  assert.equal(h.db.get('L1').status, 'failed');
  assert.ok(h.calls.telegram.some(m => /couldn't start a WhatsApp call/.test(m.text) && /template not approved/.test(m.text)));
});

test('no response after 10 min -> fallback alert once', async () => {
  const h = harness();
  await h.handleLeadEvent(leadEvent);
  h.db.raw.prepare('UPDATE leads SET updated_at = ? WHERE leadgen_id = ?').run(Date.now() - 11 * 60000, 'L1');
  const before = h.calls.telegram.length;
  await h.sweep();
  await h.sweep();
  const fallback = h.calls.telegram.slice(before).filter(m => m.chat_id === 'client_chat');
  assert.equal(fallback.length, 1);
  assert.match(fallback[0].text, /hasn't accepted the WhatsApp call/);
});

test('post-call webhook -> summary with collected data sent to remodeller', async () => {
  const h = harness();
  await h.handleLeadEvent(leadEvent);
  await h.handlePostCall({
    type: 'post_call_transcription',
    data: {
      conversation_id: 'conv_123', status: 'done', metadata: { call_duration_secs: 140 },
      conversation_initiation_client_data: { dynamic_variables: { lead_id: 'L1' } },
      analysis: {
        call_successful: 'success', transcript_summary: 'Sarah wants both toilets redone in her Tampines HDB within 2 months.',
        data_collection_results: { booking_time: { value: 'Sat 10am' }, property: { value: 'HDB, Tampines' } },
      },
    },
  });
  assert.equal(h.db.get('L1').status, 'called');
  const msg = h.calls.telegram.find(m => m.chat_id === 'client_chat' && /Qualified/.test(m.text));
  assert.ok(msg);
  assert.match(msg.text, /booking time: Sat 10am/);
  // Sweeper must not nag after a completed call
  h.db.raw.prepare('UPDATE leads SET updated_at = 0').run();
  const n = h.calls.telegram.length;
  await h.sweep();
  assert.equal(h.calls.telegram.length, n);
});

test('HTTP: Meta verification + signed lead webhook', async () => {
  const h = harness();
  const server = http.createServer(h.app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/webhooks/facebook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
    assert.equal(await r.text(), '42');

    const body = JSON.stringify({ object: 'page', entry: [{ id: '111', changes: [{ field: 'leadgen', value: { leadgen_id: 'L9', page_id: '111', form_id: 'F1' } }] }] });
    r = await fetch(`${base}/webhooks/facebook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body });
    assert.equal(r.status, 401);

    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex');
    r = await fetch(`${base}/webhooks/facebook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    assert.equal(r.status, 200);
    await new Promise(res => setTimeout(res, 50));
    assert.equal(h.db.get('L9').status, 'call_requested');
  } finally {
    server.close();
  }
});
