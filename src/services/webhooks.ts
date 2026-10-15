import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { AppError } from '../errors.js';
import { hmac } from '../crypto.js';

export const WEBHOOK_EVENTS = ['order.created', 'order.updated', 'order.assigned', 'delivery.accepted', 'delivery.picked_up', 'delivery.out_for_delivery', 'delivery.arrived', 'delivery.delivered', 'delivery.partial', 'delivery.failed', 'order.returned', 'cod.updated'];
export const newWebhookSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');
const BACKOFF_MIN = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = 6;

function isPrivate(ip: string) {
  if (net.isIPv6(ip)) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
/** SSRF guard: in production only public https endpoints are accepted. */
export async function assertSafeWebhookUrl(raw: string) {
  let u: URL; try { u = new URL(raw); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Invalid webhook URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError(400, 'VALIDATION_ERROR', 'Webhook URL must be http(s)');
  if (config.allowPrivateWebhookTargets) return;
  if (u.protocol !== 'https:') throw new AppError(400, 'VALIDATION_ERROR', 'Webhook URL must use https');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new AppError(400, 'VALIDATION_ERROR', 'Webhook URL must resolve to a public address');
}

export function signPayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return { timestamp: ts, signature: `t=${ts},v1=${hmac(secret, `${ts}.${body}`)}` };
}

async function post(url: string, secret: string, event: string, deliveryId: string, body: string) {
  const { signature } = signPayload(secret, body);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await fetch(url, { method: 'POST', body, signal: ctl.signal, redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'DMS-Webhook/1.0', 'x-dms-event': event, 'x-dms-delivery': deliveryId, 'x-dms-signature': signature } });
    return { status: r.status, ok: r.status >= 200 && r.status < 300 };
  } finally { clearTimeout(t); }
}

/** Claim due deliveries with a lease (so concurrent workers never double-send), call out, record the result. */
export async function processWebhookDeliveries(limit = 25) {
  const jobs = await query<any>(`UPDATE webhook_deliveries SET attempts=attempts+1, next_attempt_at=now()+interval '2 minutes'
      WHERE id IN (SELECT id FROM webhook_deliveries WHERE status='pending' AND next_attempt_at<=now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit]);
  let delivered = 0;
  for (const j of jobs) {
    const h = await one<any>(`SELECT * FROM webhooks WHERE id=$1`, [j.webhook_id]);
    if (!h || !h.active) { await query(`UPDATE webhook_deliveries SET status='dead', error_message='Webhook inactive or deleted' WHERE id=$1`, [j.id]); continue; }
    try {
      await assertSafeWebhookUrl(h.url);
      const r = await post(h.url, h.secret, j.event, j.id, JSON.stringify(j.payload));
      if (r.ok) { delivered++; await query(`UPDATE webhook_deliveries SET status='success', response_status=$2, error_message=NULL WHERE id=$1`, [j.id, r.status]); await query(`UPDATE webhooks SET last_delivery_at=now(), failure_count=0 WHERE id=$1`, [h.id]); }
      else throw Object.assign(new Error(`Endpoint responded ${r.status}`), { status: r.status });
    } catch (e: any) {
      const dead = j.attempts >= MAX_ATTEMPTS;
      await query(`UPDATE webhook_deliveries SET status=$2, response_status=$3, error_message=$4, next_attempt_at=now()+($5 || ' minutes')::interval WHERE id=$1`,
        [j.id, dead ? 'dead' : 'pending', e.status ?? null, String(e.message).slice(0, 500), String(BACKOFF_MIN[Math.min(j.attempts - 1, BACKOFF_MIN.length - 1)])]);
      await query(`UPDATE webhooks SET failure_count=failure_count+1, last_delivery_at=now() WHERE id=$1`, [h.id]);
    }
  }
  return { processed: jobs.length, delivered };
}
