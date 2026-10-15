# Speed-to-Lead: Facebook form → AI WhatsApp call

When someone submits a remodeller's Facebook lead form, this server reacts within seconds:

```
Facebook lead form ──webhook──▶ this server ──▶ ElevenLabs WhatsApp outbound call
                                    │                 │
                                    │                 ├─ no permission yet → sends "Allow call?" WhatsApp message
                                    │                 └─ lead taps Allow → AI agent calls them immediately
                                    │
                                    ├─▶ Telegram: "New lead: Sarah, 2 toilets, Tampines HDB. AI calling now"
                                    ├─▶ Telegram after call: summary, booking time, qualified or not
                                    └─▶ Telegram after 10 min with no call: "Phone them now"
```

**About the 5-minute target:** WhatsApp won't let a business call anyone who hasn't granted permission. The permission message goes out within seconds of the form submission, and the AI calls the moment they tap **Allow**. Leads who tap it straight away get called inside your 5 minutes. Leads who don't are flagged to the remodeller after `FALLBACK_AFTER_MINUTES` for a normal phone call.

**Built-in safety rails**
- No calls outside each client's call hours (default 9am-9pm, Mon-Sat, Singapore time). Night-time leads are queued for the next morning.
- Landline numbers (6xxx xxxx) are caught, since they can't have WhatsApp, and the remodeller is told to call manually.
- Duplicate Facebook webhooks never double-call a lead.
- Bad phone numbers and API errors immediately tell the remodeller to call manually.
- Both webhooks are signature-checked, so nobody else can trigger calls.

---

## Setup (once per remodeller client)

### 1. WhatsApp number (Meta)
1. Pick the number the AI will call from (see **Which phone number to use** below), and connect it through ElevenLabs' **Import account** flow in step 2.
2. Verify the business, set the display name, and **add a payment method** in WhatsApp Manager. Business-initiated calls are billed per minute.
3. In **WhatsApp Manager → Phone numbers → your number → Call settings**, turn on calling.
4. Create the permission template. In **WhatsApp Manager → Message templates**, make a **Utility** template with a **Call permission request** button. Use `whatsapp-permission-template.json` as the wording. It must have **no variables**, so put the client's business name in the text. Wait for approval, usually minutes to a few hours.

### 2. ElevenLabs (the AI caller)
1. In ElevenLabs, go to **Agents → WhatsApp → Import account** and connect the client's WhatsApp Business account.
2. Create the agent using `agent-prompt.md`: first message, system prompt, data-collection fields, and success criteria.
3. Copy the **phone number ID** (the account menu has a "Copy phone number ID" option) and the **agent ID**.
4. In **Settings → Webhooks**, add a post-call webhook to `https://YOUR-SERVER/webhooks/elevenlabs`. Copy the signing secret into `ELEVENLABS_WEBHOOK_SECRET`.

### 3. Facebook lead form
1. Make sure the form has a **Phone number** field.
2. Add a custom consent checkbox, for example: *"I agree to be contacted by Acme Renovation on WhatsApp, including by an AI assistant, about my enquiry."*
3. In your own Meta developer app, add the **Webhooks** product, subscribe to **Page → leadgen**, and set:
   - Callback URL: `https://YOUR-SERVER/webhooks/facebook`
   - Verify token: the same value as `FB_VERIFY_TOKEN`
4. Get a long-lived **Page access token** with `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, and `pages_read_engagement`. The client must give your business access to their Page, and to leads in **Leads Access Manager**. Then subscribe the Page to your app with `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`.

### 4. Telegram alerts
1. Create a bot with @BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
2. Create a group with the remodeller, add the bot, and put the group's chat ID in the client's `telegram_chat_id`. Put your own chat ID in `ADMIN_TELEGRAM_CHAT_ID` to get a copy of everything.

### 5. Configure and deploy
```bash
cp .env.example .env               # fill in keys
cp clients.example.json clients.json   # one block per remodeller
npm install
npm test                           # 11 tests, all mocked
npm start
```
Deploy anywhere with Node 22.13+ and a public HTTPS URL, such as Railway, Render, or a small VPS. The lead log is SQLite, so give it a **persistent disk** and point `DB_FILE` at it (for example `/data/leads.db`).

### 6. Test it live
Use Meta's **Lead Ads Testing Tool** (developers.facebook.com/tools/lead-ads-testing) with your own mobile number in the phone field. You should get the Telegram alert, then the WhatsApp "Allow call?" message, then the AI call when you tap Allow.

To check recent leads, open `GET /leads?token=ADMIN_TOKEN`.

---

## Which phone number to use

The number the AI calls from must live on Meta's **WhatsApp Cloud API**, not in the WhatsApp phone app. ElevenLabs can't import a number that's still active in the WhatsApp Business app, and once a number is on the Cloud API you can't open its chats in the WhatsApp app.

**Option A: a new number (recommended).** Get a cheap prepaid or SIM-only line (Singtel, StarHub, M1, GOMO, giga, etc.). The SIM only needs to receive one SMS or voice code during setup. After that the AI uses the number entirely in the cloud, so the SIM can sit in a drawer. Your personal and business WhatsApp stay untouched.

**Option B: move an existing number.** If you want leads to see a number they already know:
1. Back up its chats, since they won't carry over.
2. On the phone, delete the WhatsApp account for that number (WhatsApp → Settings → Account → Delete account). Uninstalling the app isn't enough.
3. Then connect it through ElevenLabs as below. From then on, you see that number's WhatsApp chats only through the API (ElevenLabs or another inbox tool), never in the WhatsApp app.

**Connecting the number:**
1. In ElevenLabs, open **Agents → WhatsApp → Import account**. This opens Meta's sign-in.
2. Log in with the Facebook account that manages the business, then pick or create the Meta Business portfolio and WhatsApp Business account.
3. Enter the number and verify it with the SMS or voice code.
4. Set the display name (for example "Acme Renovation"). Meta reviews it, usually within a day.
5. In Meta's WhatsApp Manager: add a payment method, turn on calling under **Phone numbers → Call settings**, and submit the permission template.
6. Back in ElevenLabs, copy the **phone number ID** into `clients.json`.

## Adding another remodeller
Each new client needs its own WhatsApp number, approved template, ElevenLabs agent, and Telegram group. After that, add a block to `clients.json` and restart. If several clients share one Facebook Page, use `facebook_form_ids` to route leads by form.

## Costs to plan for
- **Meta:** per-minute charges for business-initiated calls, plus a charge for permission-request templates sent outside an open chat.
- **ElevenLabs:** per-minute agent usage.
- **Hosting:** a few dollars a month.

## Limits to know
- **Permission requests:** max 1 per lead per 24 hours, and 2 per 7 days.
- **Temporary permission:** lasts 7 days unless the lead picks "always allow".
- **Unanswered calls:** 4 in a row revoke the permission automatically.
- **Availability:** business-initiated calling isn't available in the US, Canada, Egypt, Vietnam, or Nigeria. Singapore is supported.
- **Late permission:** if a lead taps Allow late in the evening, ElevenLabs places the call then. Call hours only control when the request is sent.

## Compliance (Singapore)
Under the PDPA's Do Not Call rules, the form's consent checkbox matters: clear, recorded consent lets you contact leads even if their number is on the DNC Registry. WhatsApp's own permission prompt adds a second layer. The agent always identifies itself as an AI assistant when asked and stops if the lead asks. Have each client confirm their own PDPA obligations. This setup isn't legal advice.
