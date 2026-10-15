import { query, one, type Db } from '../db.js';

/**
 * Notification service abstraction. Core order processing only calls notify()/notifyCustomer();
 * how a message leaves the system is decided by the registered channel providers.
 *  - in_app   : stored in `notifications`, shown in the UI bell
 *  - email    : outbox row (status 'queued') until an EmailProvider is registered
 *  - whatsapp : outbox row (status 'queued') until a WhatsAppProvider is registered
 */
export interface OutboundProvider { send(n: { recipient: string; title: string; body: string; data: any }): Promise<void> }
const providers: Partial<Record<'email' | 'whatsapp', OutboundProvider>> = {};
export const registerProvider = (ch: 'email' | 'whatsapp', p: OutboundProvider) => { providers[ch] = p; };

export async function notify(db: Db, n: { businessId: string | null; userId?: string | null; type: string; title: string; body?: string; data?: any }) {
  await query(`INSERT INTO notifications(business_id,user_id,channel,type,title,body,data,status) VALUES($1,$2,'in_app',$3,$4,$5,$6,'unread')`,
    [n.businessId, n.userId ?? null, n.type, n.title, n.body ?? null, JSON.stringify(n.data ?? {})], db);
}
export async function notifyRole(db: Db, businessId: string, roles: string[], n: { type: string; title: string; body?: string; data?: any }) {
  const users = await query<{ id: string }>(`SELECT id FROM users WHERE business_id=$1 AND role = ANY($2) AND status='active' AND deleted_at IS NULL`, [businessId, roles], db);
  for (const u of users) await notify(db, { businessId, userId: u.id, ...n });
}
/** Customer-facing message; queued for the outbound channels the business has switched on. */
export async function notifyCustomer(db: Db, businessId: string, mobile: string, n: { type: string; title: string; body: string; data?: any }) {
  const s = await one<any>(`SELECT notification_prefs FROM business_settings WHERE business_id=$1`, [businessId], db);
  const prefs = s?.notification_prefs ?? {};
  for (const ch of ['whatsapp', 'email'] as const) {
    if (!prefs[ch]) continue;
    await query(`INSERT INTO notifications(business_id,channel,type,title,body,data,recipient,status) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')`,
      [businessId, ch, n.type, n.title, n.body, JSON.stringify(n.data ?? {}), mobile], db);
  }
}
/** Drain queued outbound messages through registered providers (no-op if none registered). */
export async function flushOutbound(limit = 50) {
  const rows = await query<any>(`SELECT * FROM notifications WHERE status='queued' AND channel IN ('email','whatsapp') ORDER BY created_at LIMIT $1`, [limit]);
  let sent = 0;
  for (const r of rows) {
    const p = providers[r.channel as 'email' | 'whatsapp'];
    if (!p) continue;
    try { await p.send({ recipient: r.recipient, title: r.title, body: r.body ?? '', data: r.data }); await query(`UPDATE notifications SET status='sent' WHERE id=$1`, [r.id]); sent++; }
    catch { await query(`UPDATE notifications SET status='failed' WHERE id=$1`, [r.id]); }
  }
  return sent;
}
