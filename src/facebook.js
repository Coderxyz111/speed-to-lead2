const crypto = require('crypto');

// Verify X-Hub-Signature-256 so only Meta can trigger calls.
function verifyMetaSignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pull leadgen events out of a Page webhook payload.
function extractLeadEvents(body) {
  const events = [];
  if (body?.object !== 'page') return events;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen' && change.value?.leadgen_id) {
        events.push({
          leadgen_id: String(change.value.leadgen_id),
          page_id: String(change.value.page_id || entry.id),
          form_id: change.value.form_id ? String(change.value.form_id) : null,
          ad_id: change.value.ad_id ? String(change.value.ad_id) : null,
        });
      }
    }
  }
  return events;
}

async function fetchLead(leadgenId, { graphVersion, accessToken, fetchImpl = fetch }) {
  const url = `https://graph.facebook.com/${graphVersion}/${leadgenId}?fields=created_time,field_data,form_id,ad_name,campaign_name&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchImpl(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

// Turn field_data into a flat { field: value } map and pick out name/phone.
function parseLeadFields(lead) {
  const answers = {};
  for (const f of lead.field_data || []) answers[f.name] = (f.values || []).join(', ');

  const pick = (...keys) => {
    for (const k of keys) {
      const hit = Object.keys(answers).find(a => a.toLowerCase() === k);
      if (hit && answers[hit]) return answers[hit];
    }
    return '';
  };
  const first = pick('first_name');
  const last = pick('last_name');
  const name = pick('full_name', 'name') || [first, last].filter(Boolean).join(' ');
  const phone = pick('phone_number', 'phone', 'mobile', 'mobile_number', 'whatsapp_number');
  return { name, firstName: first || name.split(' ')[0] || '', phone, answers };
}

module.exports = { verifyMetaSignature, extractLeadEvents, fetchLead, parseLeadFields };
