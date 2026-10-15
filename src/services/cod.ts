import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { AppError, conflict, notFound } from '../errors.js';
import { round2 } from '../validate.js';

/** Cash outstanding for one partner = collected - settled (all server-side). */
export async function partnerOutstanding(c: PoolClient | undefined, businessId: string, partnerId: string) {
  const r = await one<any>(`SELECT COALESCE(SUM(collected_amount - settled_amount),0) AS outstanding FROM cod_transactions
                             WHERE business_id=$1 AND partner_id=$2 AND status IN ('collected','submitted')`, [businessId, partnerId], c);
  return round2(r!.outstanding);
}

export async function codSummary(businessId: string, partnerId?: string) {
  return query(`SELECT u.id AS partner_id, u.name AS partner_name,
          COALESCE(SUM(t.expected_amount) FILTER (WHERE t.status<>'void'),0) AS expected,
          COALESCE(SUM(t.collected_amount),0) AS collected,
          COALESCE(SUM(t.change_given),0) AS change_given,
          COALESCE(SUM(t.settled_amount),0) AS settled,
          COALESCE(SUM(t.collected_amount - t.settled_amount) FILTER (WHERE t.status IN ('collected','submitted')),0) AS pending,
          COALESCE(SUM(t.collected_amount - t.settled_amount) FILTER (WHERE t.status='submitted'),0) AS submitted
        FROM users u LEFT JOIN cod_transactions t ON t.partner_id=u.id AND t.business_id=u.business_id
       WHERE u.business_id=$1 AND u.role='delivery_partner' AND u.deleted_at IS NULL AND ($2::uuid IS NULL OR u.id=$2)
       GROUP BY u.id,u.name ORDER BY u.name`, [businessId, partnerId ?? null]);
}

/** Partner declares the cash they are handing over; managers settle against it. */
export async function submitCod(c: PoolClient, businessId: string, partnerId: string) {
  const r = await query(`UPDATE cod_transactions SET status='submitted', submitted_at=now() WHERE business_id=$1 AND partner_id=$2 AND status='collected' RETURNING id`, [businessId, partnerId], c);
  return r.length;
}

export async function settleCod(c: PoolClient, businessId: string, partnerId: string, amount: number, by: string, reference?: string, notes?: string) {
  const p = await one(`SELECT id FROM users WHERE id=$1 AND business_id=$2 AND role='delivery_partner'`, [partnerId, businessId], c);
  if (!p) throw notFound('Delivery partner not found');
  const txs = await query<any>(`SELECT * FROM cod_transactions WHERE business_id=$1 AND partner_id=$2 AND status IN ('collected','submitted') AND collected_amount>settled_amount ORDER BY created_at FOR UPDATE`, [businessId, partnerId], c);
  const outstanding = round2(txs.reduce((a, t) => a + t.collected_amount - t.settled_amount, 0));
  if (amount > outstanding + 0.004) throw new AppError(422, 'INVALID_AMOUNT', `Settlement ${amount} exceeds outstanding COD ${outstanding}`);
  if (outstanding <= 0) throw conflict('Nothing to settle for this partner', 'NOTHING_TO_SETTLE');
  const s = (await one<any>(`INSERT INTO cod_settlements(business_id,partner_id,amount,reference_no,notes,settled_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [businessId, partnerId, amount, reference ?? null, notes ?? null, by], c))!;
  let left = amount;
  for (const t of txs) {                      // FIFO allocation
    if (left <= 0.004) break;
    const take = round2(Math.min(left, t.collected_amount - t.settled_amount));
    const settled = round2(t.settled_amount + take);
    await query(`UPDATE cod_transactions SET settled_amount=$2, status=CASE WHEN $2>=collected_amount THEN 'settled' ELSE status END, settled_at=CASE WHEN $2>=collected_amount THEN now() ELSE settled_at END, last_settlement_id=$3 WHERE id=$1`, [t.id, settled, s.id], c);
    left = round2(left - take);
  }
  return { settlement: s, outstandingAfter: round2(outstanding - amount) };
}
