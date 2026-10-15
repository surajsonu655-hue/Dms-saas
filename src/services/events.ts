import { query, type Db } from '../db.js';

export const orderPayload = (o: any) => ({
  id: o.id, invoice_number: o.invoice_number, status: o.status, final_status: o.final_status,
  customer: { name: o.customer_name, mobile: o.customer_mobile, address: o.customer_address },
  bill_amount: o.bill_amount, change_amount: o.change_amount, receivable_amount: o.receivable_amount,
  returned_amount: o.returned_amount, delivered_amount: o.delivered_amount, collected_amount: o.collected_amount, final_amount: o.final_amount,
  payment_mode: o.payment_mode, partner_id: o.current_partner_id, updated_at: o.updated_at,
});

/**
 * Transactional outbox: webhook deliveries and Google-Sheet sync jobs are written in the SAME
 * transaction as the order change. If the transaction rolls back nothing is emitted; if an external
 * system is down the order is still saved and the job is retried later by the workers.
 */
export async function emit(db: Db, businessId: string, event: string, order: any, extra: any = {}) {
  const hooks = await query<{ id: string }>(`SELECT id FROM webhooks WHERE business_id=$1 AND active AND ('*' = ANY(events) OR $2 = ANY(events))`, [businessId, event], db);
  const payload = JSON.stringify({ event, business_id: businessId, created_at: new Date().toISOString(), data: { order: orderPayload(order), ...extra } });
  for (const h of hooks)
    await query(`INSERT INTO webhook_deliveries(business_id,webhook_id,event,payload) VALUES($1,$2,$3,$4::jsonb)`, [businessId, h.id, event, payload], db);
  await enqueueSheetSync(db, businessId, order.id);
}

export async function enqueueSheetSync(db: Db, businessId: string, orderId: string) {
  const conn = await query<{ id: string }>(`SELECT id FROM google_sheet_connections WHERE business_id=$1 AND status='active' AND sync_enabled AND spreadsheet_id IS NOT NULL`, [businessId], db);
  for (const c of conn)
    await query(`INSERT INTO google_sheet_sync_logs(business_id,connection_id,order_id) VALUES($1,$2,$3) ON CONFLICT (connection_id, order_id) WHERE sync_status='pending' DO NOTHING`, [businessId, c.id, orderId], db);
}

export const STATUS_EVENT: Record<string, string> = {
  created: 'order.created', assigned: 'order.assigned', accepted: 'delivery.accepted', picked_up: 'delivery.picked_up',
  out_for_delivery: 'delivery.out_for_delivery', arrived: 'delivery.arrived', delivered: 'delivery.delivered',
  partial: 'delivery.partial', failed: 'delivery.failed', full_return: 'order.returned', cancelled: 'order.updated', ready: 'order.updated',
};
