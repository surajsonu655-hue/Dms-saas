import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { errorHandler, notFound } from './errors.js';
import { pool } from './db.js';
import { authRouter } from './routes/auth.js';
import { ownerRouter } from './routes/owner.js';
import { businessRouter } from './routes/business.js';
import { opsRouter } from './routes/operations.js';
import { integrationsRouter } from './routes/integrations.js';
import { buildOpenApi } from './openapi.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false);
  // API responses get a locked-down CSP; the bundled web UI (public/index.html) needs inline script/style plus the xlsx CDN for Excel export.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cors({ origin: (o, cb) => cb(null, !o || config.corsOrigins.includes(o)), credentials: true, maxAge: 600 }));
  if (config.rateLimitEnabled) app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '256kb' }));
  if (!config.isTest) app.use((req, res, next) => { const t = Date.now(); res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t}ms`)); next(); });

  app.get('/health', async (_q, res) => { try { await pool.query('select 1'); res.json({ success: true, data: { status: 'ok' } }); } catch { res.status(503).json({ success: false, message: 'Database unavailable', code: 'UNAVAILABLE' }); } });
  const spec = buildOpenApi();
  app.get('/api/openapi.json', (_q, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));

  app.use('/api/auth', authRouter);
  app.use('/api/owner', ownerRouter);
  app.use('/api', integrationsRouter);
  app.use('/api', businessRouter);
  app.use('/api', opsRouter);
  app.use('/api', (_q, _s, next) => next(notFound('Endpoint not found')));
  // ---- bundled web UI: same origin as the API, so no CORS and the browser never needs a configured URL ----
  const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), config.isProd ? '../../public' : '../public');
  const indexFile = path.join(pub, 'index.html');
  if (fs.existsSync(indexFile)) {
    // The existing UI file is served unchanged; the API-mode layer is injected so the same file still works as a standalone demo elsewhere.
    const html = () => fs.readFileSync(indexFile, 'utf8').replace('</body>', `<script>window.DMS_API_BASE='/api'</script><script src="/dms-api-mode.js"></script></body>`);
    app.get('/dms-api-mode.js', (_q, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('js').sendFile(path.join(pub, 'dms-api-mode.js')); });
    app.get(['/', '/index.html', /^\/settings(\/.*)?$/], (_q, res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
      res.setHeader('Cache-Control', 'no-store'); res.type('html').send(html());
    });
  }
  app.use(errorHandler);
  return app;
}
