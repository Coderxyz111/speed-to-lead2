const express = require('express');
const { verifyMetaSignature, extractLeadEvents, fetchLead, parseLeadFields } = require('./facebook');
const { requestWhatsAppCall, verifyElevenSignature, parsePostCall } = require('./elevenlabs');
const { normalisePhone } = require('./phone');
const { isWithinHours, nextOpening } = require('./hours');
const { makeNotifier, esc, phoneLink } = require('./notify');

function createApp({ config, db, fetchImpl = fetch, log = console, now = () => new Date() }) {
  const notify = makeNotifier({ botToken: config.telegramBotToken, adminChatId: config.adminTelegramChatId, fetchImpl, log });
  const clientById = id => config.clients.find(c => c.id === id);

  function findClient(ev) {
    return config.clients.find(c =>
      String(c.facebook_page_id) === ev.page_id &&
      (!c.facebook_form_ids?.length || (ev.form_id && c.facebook_form_ids.map(String).includes(ev.form_id))));
  }

  // ---------- core pipeline ----------

  async function handleLeadEvent(ev) {
    log.info('Processing lead', ev.leadgen_id, 'page', ev.page_id, 'form', ev.form_id);
    const client = findClient(ev);
    if (!client) {
      log.warn('No client configured for page/form', JSON.stringify(ev));
      await notify(null, `⚠️ Lead ${esc(ev.leadgen_id)} came in for page ${esc(ev.page_id)} / form ${esc(ev.form_id)}, but no client in clients.json matches it.`);
      return;
    }

    let leadData;
    try {
      leadData = config.dryRun
        ? { field_data: [{ name: 'full_name', values: ['Test Lead'] }, { name: 'phone_number', values: ['9123 4567'] }] }
        : await fetchLead(ev.leadgen_id, { graphVersion: config.graphVersion, accessToken: client.facebook_page_access_token || config.fbPageAccessToken, fetchImpl });
    } catch (e) {
      log.error('Could not read lead from Facebook', ev.leadgen_id, e.message);
      if (db.insertLead({ leadgen_id: ev.leadgen_id, client_id: client.id, status: 'fetch_failed' })) {
        db.update(ev.leadgen_id, { error: e.message, fallback_sent: 1 });
        await notify(client, `❗ New lead ${esc(ev.leadgen_id)} for ${esc(client.business_name)}, but the server couldn't read it from Facebook.\nReason: ${esc(e.message)}\n\nCheck the lead in Meta Business Suite and contact them manually.`);
      }
      return;
    }

    const { name, firstName, phone, answers } = parseLeadFields(leadData);
    const whatsapp_id = normalisePhone(phone, client.country);
    const isNew = db.insertLead({ leadgen_id: ev.leadgen_id, client_id: client.id, name, phone_raw: phone, whatsapp_id, answers, status: 'received' });
    if (!isNew) { log.info('Duplicate webhook for lead', ev.leadgen_id); return; }

    const answerLines = Object.entries(answers)
      .filter(([k]) => !/full_name|first_name|last_name/i.test(k))
      .map(([k, v]) => `• ${esc(k.replace(/_/g, ' '))}: ${esc(v)}`).join('\n');
    const header = `🔔 <b>New lead for ${esc(client.business_name)}</b>\n${esc(name || 'No name')} — ${phoneLink({ whatsapp_id, phone_raw: phone })}\n${answerLines}`;

    if (!whatsapp_id) {
      db.update(ev.leadgen_id, { status: 'bad_phone', fallback_sent: 1 });
      await notify(client, `${header}\n\n❗ Couldn't read a valid mobile number, so the AI can't WhatsApp them. Please call or email manually.`);
      return;
    }

    const at = now();
    if (!isWithinHours(at, client.call_hours, client.timezone)) {
      const due = nextOpening(at, client.call_hours, client.timezone);
      db.update(ev.leadgen_id, { status: 'queued', due_at: due.getTime() });
      const when = due.toLocaleString('en-SG', { timeZone: client.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
      await notify(client, `${header}\n\n🌙 Outside call hours. The AI will reach out at ${esc(when)}.`);
      return;
    }

    await notify(client, `${header}\n\n📲 AI is reaching out on WhatsApp now.`);
    await triggerCall(db.get(ev.leadgen_id), client);
  }

  async function triggerCall(row, client = clientById(row.client_id)) {
    const lead = {
      leadgen_id: row.leadgen_id, name: row.name, whatsapp_id: row.whatsapp_id,
      firstName: (row.name || '').split(' ')[0], answers: JSON.parse(row.answers_json || '{}'),
    };
    if (config.dryRun) {
      log.info('[DRY_RUN] would request WhatsApp call', lead.whatsapp_id);
      db.update(row.leadgen_id, { status: 'call_requested', conversation_id: `dry_${row.leadgen_id}` });
      return;
    }
    try {
      const res = await requestWhatsAppCall({ client, lead, apiKey: config.elevenApiKey, baseUrl: config.elevenBaseUrl, fetchImpl });
      db.update(row.leadgen_id, { status: 'call_requested', conversation_id: res.conversation_id || null });
      log.info('Call requested', row.leadgen_id, res.conversation_id);
    } catch (e) {
      log.error('Call request failed', row.leadgen_id, e.message);
      db.update(row.leadgen_id, { status: 'failed', error: e.message, fallback_sent: 1 });
      await notify(client, `❗ AI couldn't start a WhatsApp call to ${esc(row.name || 'lead')} (${phoneLink(row)}).\nReason: ${esc(e.message)}\n\nPlease call them directly.`);
    }
  }

  async function handlePostCall(payload) {
    const r = parsePostCall(payload);
    if (!['post_call_transcription', 'call_initiation_failure'].includes(r.type)) return;
    const row = (r.lead_id && db.get(r.lead_id)) || (r.conversation_id && db.getByConversation(r.conversation_id));
    if (!row) { log.warn('Post-call webhook for unknown lead', r.lead_id, r.conversation_id); return; }
    const client = clientById(row.client_id);

    const failed = r.type === 'call_initiation_failure' || r.status === 'failed' || (r.duration_secs !== undefined && r.duration_secs < 5);
    db.update(row.leadgen_id, {
      status: failed ? 'failed' : 'called',
      conversation_id: r.conversation_id || row.conversation_id,
      outcome_json: JSON.stringify(r),
      fallback_sent: 1,
    });

    if (failed) {
      await notify(client, `📵 AI couldn't connect with ${esc(row.name || 'lead')} (${phoneLink(row)}).${r.failure_reason ? `\nReason: ${esc(r.failure_reason)}` : ''}\n\nGive them a normal phone call.`);
      return;
    }
    const collected = Object.entries(r.collected)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `• ${esc(k.replace(/_/g, ' '))}: ${esc(v)}`).join('\n');
    const verdict = { success: '✅ Qualified / booked', failure: '❌ Not a fit', unknown: '❔ Unclear' }[r.call_successful] || '📞 Call finished';
    await notify(client, `${verdict} — <b>${esc(row.name || 'Lead')}</b> (${phoneLink(row)})\n\n${esc(r.summary)}${collected ? `\n\n${collected}` : ''}${r.duration_secs ? `\n\n⏱ ${Math.round(r.duration_secs / 60 * 10) / 10} min call` : ''}`);
  }

  // Runs every minute: start queued calls, and flag leads the AI hasn't reached.
  async function sweep() {
    for (const row of db.dueQueued()) await triggerCall(row);
    for (const row of db.staleUncalled(config.fallbackAfterMinutes * 60000)) {
      db.update(row.leadgen_id, { fallback_sent: 1 });
      await notify(clientById(row.client_id), `⏰ ${esc(row.name || 'Lead')} (${phoneLink(row)}) hasn't accepted the WhatsApp call after ${config.fallbackAfterMinutes} min. Worth a normal phone call now while they're still warm.`);
    }
  }

  // ---------- HTTP ----------

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Public privacy policy + data deletion page (Meta requires a URL before an app can be published).
  app.get(['/privacy', '/data-deletion'], (_req, res) => {
    const names = config.clients.map(c => esc(c.business_name)).join(', ') || 'our clients';
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222;background:#fff}h1{font-size:1.6em}h2{font-size:1.15em;margin-top:1.6em}</style></head><body>
<h1>Privacy Policy</h1>
<p>This service handles enquiries submitted through Facebook lead forms on behalf of ${names} (Singapore).</p>
<h2>What we collect</h2>
<p>The details you enter in the enquiry form, such as your name, phone number and answers about your project, plus notes and a summary of any follow-up call.</p>
<h2>How we use it</h2>
<p>Only to respond to your enquiry: to contact you on WhatsApp (including a call from an AI assistant, with your permission), understand your project, and arrange a site visit or quotation. We do not sell your data or use it for unrelated marketing.</p>
<h2>Who we share it with</h2>
<p>Only the service providers needed to contact you: Meta (Facebook and WhatsApp), our voice AI provider, our hosting provider, and the business you enquired with.</p>
<h2>How long we keep it</h2>
<p>For as long as needed to handle your enquiry and any resulting job, then it is deleted.</p>
<h2>Your rights and data deletion</h2>
<p>You can ask to see, correct or delete your data at any time, or stop being contacted. Reply "STOP" on WhatsApp, or message the business you enquired with through its Facebook page, and we will delete your data within 30 days.</p>
<p>This policy follows Singapore's Personal Data Protection Act (PDPA).</p>
</body></html>`);
  });

  // Meta's one-time subscription check
  app.get('/webhooks/facebook', (req, res) => {
    if (config.fbVerifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.fbVerifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/webhooks/facebook', (req, res) => {
    const events = extractLeadEvents(req.body);
    log.info(`Facebook webhook received: object=${req.body?.object} leads=${events.map(e => e.leadgen_id).join(',') || 'none'}`);
    if (!config.dryRun && !verifyMetaSignature(req.rawBody || '', req.get('x-hub-signature-256'), config.fbAppSecret)) {
      log.error('Facebook webhook REJECTED: signature mismatch. Check FB_APP_SECRET is the App Secret of the app that owns this webhook.');
      return res.sendStatus(401);
    }
    res.sendStatus(200); // ack fast; Meta retries slow responses
    for (const ev of events) {
      handleLeadEvent(ev).catch(e => log.error('Lead handling failed', ev.leadgen_id, e.message));
    }
  });

  app.post('/webhooks/elevenlabs', (req, res) => {
    if (!verifyElevenSignature(req.rawBody || '', req.get('elevenlabs-signature'), config.elevenWebhookSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    handlePostCall(req.body).catch(e => log.error('Post-call handling failed', e));
  });

  // Simple lead log for you: GET /leads?token=ADMIN_TOKEN
  app.get('/leads', (req, res) => {
    if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) return res.sendStatus(403);
    res.json(db.recent(Number(req.query.limit) || 50).map(r => ({ ...r, answers: JSON.parse(r.answers_json || '{}'), outcome: r.outcome_json ? JSON.parse(r.outcome_json) : null, answers_json: undefined, outcome_json: undefined })));
  });

  return { app, handleLeadEvent, triggerCall, handlePostCall, sweep };
}

module.exports = { createApp };
