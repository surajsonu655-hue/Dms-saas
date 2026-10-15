import 'dotenv/config';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function secret(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}

export const config = {
  env,
  isProd,
  isTest: env === 'test',
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://dms:dms@localhost:5432/dms',
  jwtSecret: secret('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  jwtRefreshSecret: secret('JWT_REFRESH_SECRET', 'dev-only-refresh-secret-change-me'),
  tokenEncKey: secret('TOKEN_ENC_KEY', 'dev-only-token-encryption-key-change-me'),
  accessTtlSec: Number(process.env.ACCESS_TTL_SEC || 15 * 60),
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS || 7),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  corsOrigins: (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map(s => s.trim()),
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED ? process.env.RATE_LIMIT_ENABLED === 'true' : !(env === 'test'),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  allowPrivateWebhookTargets: process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true' || !isProd,
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',
    dir: process.env.STORAGE_DIR || './storage',
    bucket: process.env.STORAGE_BUCKET || '',
    maxBytes: Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
    // Spreadsheet listing needs the Drive metadata scope. Set GOOGLE_DRIVE_LISTING=false to request only the Sheets scope
    // (users then paste a spreadsheet link instead of picking from a list).
    driveListing: process.env.GOOGLE_DRIVE_LISTING !== 'false',
    minIntervalMs: Number(process.env.GOOGLE_MIN_INTERVAL_MS ?? (env === 'test' ? 0 : 1000)),   // throttle: Sheets quota is ~60 writes/min/user
    // Endpoint overrides exist only so the test-suite can point at a local fake Google. Leave unset in real deployments.
    authUrl: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    revokeUrl: process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
    userinfoUrl: process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v2/userinfo',
    sheetsBase: process.env.GOOGLE_SHEETS_BASE || 'https://sheets.googleapis.com/v4',
    driveBase: process.env.GOOGLE_DRIVE_BASE || 'https://www.googleapis.com/drive/v3',
  },
  workersEnabled: process.env.WORKERS_ENABLED ? process.env.WORKERS_ENABLED === 'true' : !(env === 'test'),
};
