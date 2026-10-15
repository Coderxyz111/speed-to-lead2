const crypto = require('crypto');

// Ask ElevenLabs to call the lead on WhatsApp.
// ElevenLabs checks the lead's call permission: if none, it sends our approved
// permission-request template and places the call as soon as they tap "Allow".
async function requestWhatsAppCall({ client, lead, apiKey, baseUrl, fetchImpl = fetch }) {
  const body = {
    whatsapp_phone_number_id: client.whatsapp_phone_number_id,
    whatsapp_user_id: lead.whatsapp_id,
    whatsapp_call_permission_request_template_name: client.permission_template_name,
    whatsapp_call_permission_request_template_language_code: client.permission_template_language,
    agent_id: client.elevenlabs_agent_id,
    conversation_initiation_client_data: {
      user_id: lead.leadgen_id,
      dynamic_variables: {
        lead_id: lead.leadgen_id,
        client_id: client.id,
        business_name: client.business_name,
        service_area: client.service_area || '',
        lead_first_name: lead.firstName || 'there',
        lead_full_name: lead.name || '',
        // Every form answer, so the agent doesn't re-ask what they already told us.
        form_answers: Object.entries(lead.answers || {})
          .filter(([k]) => !/phone|email/i.test(k))
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; '),
      },
    },
  };

  const res = await fetchImpl(`${baseUrl}/v1/convai/whatsapp/outbound-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`ElevenLabs ${res.status}: ${json.message || JSON.stringify(json.detail || json)}`);
  }
  return json; // { success, message, conversation_id }
}

// ElevenLabs webhook header: "t=<unix>,v0=<hex hmac of `${t}.${body}`>"
function verifyElevenSignature(rawBody, header, secret, toleranceSec = 30 * 60) {
  if (!secret) return true; // not configured: accept (README says to set it)
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const got = `v0=${parts.v0 || ''}`;
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pull what we care about from a post-call webhook.
function parsePostCall(payload) {
  const d = payload?.data || {};
  const vars = d.conversation_initiation_client_data?.dynamic_variables || {};
  const analysis = d.analysis || {};
  const collected = {};
  for (const [k, v] of Object.entries(analysis.data_collection_results || {})) {
    collected[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
  }
  return {
    type: payload?.type,
    conversation_id: d.conversation_id,
    lead_id: vars.lead_id || d.user_id || null,
    status: d.status,
    call_successful: analysis.call_successful, // "success" | "failure" | "unknown"
    summary: analysis.transcript_summary || '',
    collected,
    duration_secs: d.metadata?.call_duration_secs,
    failure_reason: d.failure_reason || d.metadata?.error || null,
  };
}

module.exports = { requestWhatsAppCall, verifyElevenSignature, parsePostCall };
