import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { processSheetSync } from './services/sheets.js';
import { processWebhookDeliveries } from './services/webhooks.js';
import { flushOutbound } from './services/notifications.js';

async function main() {
  await migrate();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`DMS API listening on :${config.port} (${config.env})  docs: /api/docs`));
  const timers: NodeJS.Timeout[] = [];
  if (config.workersEnabled) {
    const loop = (name: string, ms: number, fn: () => Promise<any>) => { let busy = false; timers.push(setInterval(async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { console.error(`[worker:${name}]`, e); } finally { busy = false; } }, ms)); };
    loop('webhooks', 5_000, () => processWebhookDeliveries());
    loop('sheets', 5_000, () => processSheetSync());
    loop('outbound', 15_000, () => flushOutbound());
  }
  const stop = () => { timers.forEach(clearInterval); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(e => { console.error(e); process.exit(1); });
