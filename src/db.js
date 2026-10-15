const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      leadgen_id      TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL,
      name            TEXT,
      phone_raw       TEXT,
      whatsapp_id     TEXT,
      answers_json    TEXT,
      status          TEXT NOT NULL,   -- received | queued | call_requested | called | failed | bad_phone
      conversation_id TEXT,
      outcome_json    TEXT,
      error           TEXT,
      fallback_sent   INTEGER NOT NULL DEFAULT 0,
      due_at          INTEGER,         -- for leads that arrived outside call hours
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_conv ON leads(conversation_id);
  `);

  const now = () => Date.now();
  return {
    raw: db,
    // Returns false if this lead was already seen (Facebook retries webhooks).
    insertLead(l) {
      const res = db.prepare(`INSERT OR IGNORE INTO leads
        (leadgen_id, client_id, name, phone_raw, whatsapp_id, answers_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(l.leadgen_id, l.client_id, l.name, l.phone_raw, l.whatsapp_id, JSON.stringify(l.answers || {}), l.status, now(), now());
      return res.changes > 0;
    },
    update(leadgen_id, fields) {
      const keys = Object.keys(fields);
      const sets = keys.map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE leads SET ${sets}, updated_at = ? WHERE leadgen_id = ?`)
        .run(...keys.map(k => fields[k]), now(), leadgen_id);
    },
    get(leadgen_id) {
      return db.prepare('SELECT * FROM leads WHERE leadgen_id = ?').get(leadgen_id);
    },
    getByConversation(conversation_id) {
      return db.prepare('SELECT * FROM leads WHERE conversation_id = ?').get(conversation_id);
    },
    // Leads that were sent to the AI but haven't produced a finished call yet.
    staleUncalled(olderThanMs) {
      return db.prepare(`SELECT * FROM leads
        WHERE status = 'call_requested'
          AND fallback_sent = 0 AND updated_at < ?`).all(now() - olderThanMs);
    },
    dueQueued() {
      return db.prepare(`SELECT * FROM leads WHERE status = 'queued' AND due_at <= ?`).all(now());
    },
    recent(limit = 50) {
      return db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?').all(limit);
    },
  };
}

module.exports = { openDb };
