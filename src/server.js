process.removeAllListeners('warning'); // hide node:sqlite experimental warning
require('./env').loadEnvFile();
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const config = loadConfig();
const db = openDb(config.dbFile);
const { app, sweep } = createApp({ config, db });

app.listen(config.port, () => {
  console.log(`Speed-to-lead running on :${config.port} with ${config.clients.length} client(s)${config.dryRun ? ' [DRY_RUN]' : ''}`);
});

setInterval(() => sweep().catch(e => console.error('Sweep failed', e)), 60_000);
