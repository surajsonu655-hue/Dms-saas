/**
 * The Order Report: ONE definition used by the Orders report (JSON/CSV/Excel) and by Google Sheets.
 * Exactly these 17 fields, in this order. All timestamps come from DMS event records (never from Google),
 * rendered in the business timezone.
 */
export const ORDER_REPORT_COLUMNS = ['Date', 'Bill Number', 'Customer Name', 'Customer Address', 'Bill Amount', 'Change', 'Receivable Amount', 'Pay Mode', 'Delivery Partner',
  'Assigned Time', 'Out for Delivery Time', 'Delivered Time', 'Duration', 'Return Amount', 'Final Amount', 'Status', 'Remarks'] as const;

const TS = (expr: string, tz: string) => `to_char(${expr} AT TIME ZONE ${tz}, 'DD Mon YYYY, HH12:MI AM')`;

/** SELECT list + lateral joins. `tz` is the SQL placeholder holding the timezone (e.g. "$4"). Requires alias `o` = orders and `u` = partner user. */
export function orderReportSelect(tz: string) {
  return {
    select: `to_char(o.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS c01, o.invoice_number AS c02, o.customer_name AS c03, o.customer_address AS c04,
      o.bill_amount AS c05, o.change_amount AS c06, o.receivable_amount AS c07,
      CASE WHEN o.payment_mode IN ('cod','upi') THEN upper(o.payment_mode) ELSE initcap(o.payment_mode) END AS c08,
      u.name AS c09,
      ${TS('a.assigned_at', tz)} AS c10,
      ${TS('d.out_for_delivery_at', tz)} AS c11,
      CASE WHEN o.status IN ('delivered','partial') THEN ${TS('d.completed_at', tz)} END AS c12,
      CASE WHEN o.status IN ('delivered','partial') AND a.assigned_at IS NOT NULL AND d.completed_at IS NOT NULL THEN
        CASE WHEN m.mins < 1 THEN 'Less than a minute' WHEN m.mins = 1 THEN '1 minute' WHEN m.mins < 60 THEN m.mins || ' minutes' ELSE (m.mins / 60) || ' hr ' || (m.mins % 60) || ' min' END END AS c13,
      o.returned_amount AS c14, o.final_amount AS c15,
      CASE o.status WHEN 'created' THEN 'Created' WHEN 'ready' THEN 'Ready' WHEN 'assigned' THEN 'Assigned' WHEN 'accepted' THEN 'Accepted' WHEN 'picked_up' THEN 'Picked Up'
        WHEN 'out_for_delivery' THEN 'Out for Delivery' WHEN 'arrived' THEN 'Arrived' WHEN 'delivered' THEN 'Delivered' WHEN 'partial' THEN 'Partial Delivered'
        WHEN 'failed' THEN 'Failed' WHEN 'full_return' THEN 'Full Return' WHEN 'cancelled' THEN 'Cancelled' ELSE o.status END AS c16,
      concat_ws(' / ', o.remarks, o.manager_remarks, d.failure_reason, (SELECT r.reason FROM returns r WHERE r.order_id = o.id ORDER BY r.created_at DESC LIMIT 1)) AS c17`,
    joins: `LEFT JOIN LATERAL (SELECT assigned_at FROM delivery_assignments WHERE order_id = o.id ORDER BY assigned_at DESC LIMIT 1) a ON true
      LEFT JOIN LATERAL (SELECT out_for_delivery_at, completed_at, failure_reason FROM deliveries WHERE order_id = o.id ORDER BY attempt_no DESC LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT GREATEST(0, round(extract(epoch FROM (d.completed_at - a.assigned_at)) / 60))::int AS mins) m ON true`,
  };
}
