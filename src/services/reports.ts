import { one, query } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import type { Auth } from '../auth.js';
import { ORDER_REPORT_COLUMNS, orderReportSelect } from './orderReport.js';
const ORD = orderReportSelect('$4');

export const REPORT_TYPES = ['orders', 'deliveries', 'failed', 'returns', 'partial', 'cod', 'partner_performance', 'manager_performance', 'revenue'] as const;
export type ReportType = typeof REPORT_TYPES[number];
export interface ReportFilters { from?: string; to?: string; status?: string; partnerId?: string; managerId?: string }

/** Managers are clamped to the history window the Business Admin allowed (enforced here, not in the UI). */
export async function effectiveRange(businessId: string, auth: Auth, f: ReportFilters) {
  const b = await one<any>(`SELECT b.timezone, s.manager_report_scope AS scope FROM businesses b JOIN business_settings s ON s.business_id=b.id WHERE b.id=$1`, [businessId]);
  const tz = b!.timezone;
  let floor: string | null = null;
  if (auth.role === 'manager' && b!.scope !== 'complete') {
    const unit = ({ same_day: 'day', weekly: 'week', monthly: 'month', yearly: 'year' } as any)[b!.scope];
    floor = (await one<any>(`SELECT to_char(date_trunc($2, now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [tz, unit]))!.d;
  }
  const today = (await one<any>(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [tz]))!.d;
  let from = f.from ?? null, to = f.to ?? null;
  // a period that lies entirely outside the allowed window is refused (not silently replaced by different data)
  if (floor && to && to < floor) throw new AppError(403, 'REPORT_SCOPE', `Your report access is limited to ${String(b!.scope).replace('_', ' ')} data`);
  if (floor && (!from || from < floor)) from = floor;
  if (floor && b!.scope === 'same_day') to = today;
  if (from && to && from > to) throw badRequest('"from" must not be after "to"');
  return { from, to, tz, scope: b!.scope as string };
}

const DATE = (col = 'o.created_at') => `($2::date IS NULL OR ${col} >= ($2::date)::timestamp AT TIME ZONE $4) AND ($3::date IS NULL OR ${col} < (($3::date + 1))::timestamp AT TIME ZONE $4)`;
const FILT = `AND ($5::text IS NULL OR o.status=$5) AND ($6::uuid IS NULL OR o.current_partner_id=$6) AND ($7::uuid IS NULL OR o.assigned_manager_id=$7)`;

const SQL: Record<ReportType, { cols: string[]; sql: string }> = {
  orders: { cols: [...ORDER_REPORT_COLUMNS],
    sql: `SELECT ${ORD.select} FROM orders o LEFT JOIN users u ON u.id=o.current_partner_id ${ORD.joins}
          WHERE o.business_id=$1 AND o.deleted_at IS NULL AND ${DATE()} ${FILT} ORDER BY o.created_at DESC` },
  deliveries: { cols: ['Bill Number', 'Delivery Agent', 'Attempt', 'Status', 'Accepted', 'Out For Delivery', 'Completed'],
    sql: `SELECT o.invoice_number, u.name, d.attempt_no, d.status, d.accepted_at, d.out_for_delivery_at, d.completed_at FROM deliveries d JOIN orders o ON o.id=d.order_id LEFT JOIN users u ON u.id=d.partner_id
          WHERE d.business_id=$1 AND ${DATE('d.created_at')} ${FILT} ORDER BY d.created_at DESC` },
  failed: { cols: ['Bill Number', 'Customer', 'Delivery Agent', 'Attempt', 'Reason', 'Notes', 'When'],
    sql: `SELECT o.invoice_number, o.customer_name, u.name, d.attempt_no, d.failure_reason, d.failure_notes, d.completed_at FROM deliveries d JOIN orders o ON o.id=d.order_id LEFT JOIN users u ON u.id=d.partner_id
          WHERE d.business_id=$1 AND d.failure_reason IS NOT NULL AND ${DATE('d.created_at')} ${FILT} ORDER BY d.completed_at DESC` },
  returns: { cols: ['Return', 'Bill Number', 'Type', 'Original Amount', 'Returned Amount', 'Delivered Amount', 'Reason', 'Status', 'Created'],
    sql: `SELECT r.id::text, o.invoice_number, r.return_type, r.original_amount, r.returned_amount, r.delivered_amount, r.reason, r.status, r.created_at FROM returns r JOIN orders o ON o.id=r.order_id
          WHERE r.business_id=$1 AND ${DATE('r.created_at')} ${FILT} ORDER BY r.created_at DESC` },
  partial: { cols: ['Bill Number', 'Customer', 'Original Amount', 'Returned Amount', 'Delivered Amount', 'Collected', 'Delivery Agent', 'Final Status'],
    sql: `SELECT o.invoice_number, o.customer_name, o.bill_amount, o.returned_amount, o.delivered_amount, o.collected_amount, u.name, o.final_status FROM orders o LEFT JOIN users u ON u.id=o.current_partner_id
          WHERE o.business_id=$1 AND o.status='partial' AND o.deleted_at IS NULL AND ${DATE()} ${FILT} ORDER BY o.created_at DESC` },
  cod: { cols: ['Bill Number', 'Delivery Agent', 'Expected', 'Collected', 'Change Given', 'Settled', 'Pending', 'Status'],
    sql: `SELECT o.invoice_number, u.name, t.expected_amount, t.collected_amount, t.change_given, t.settled_amount, (t.collected_amount-t.settled_amount), t.status FROM cod_transactions t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.partner_id
          WHERE t.business_id=$1 AND ${DATE('t.created_at')} ${FILT} ORDER BY t.created_at DESC` },
  partner_performance: { cols: ['Delivery Partner', 'Assigned', 'Delivered', 'Partial', 'Failed', 'Full Return', 'Success Rate %', 'Collected'],
    sql: `SELECT u.name, count(o.id), count(*) FILTER (WHERE o.status='delivered'), count(*) FILTER (WHERE o.status='partial'), count(*) FILTER (WHERE o.status='failed'), count(*) FILTER (WHERE o.status='full_return'),
            CASE WHEN count(*) FILTER (WHERE o.status IN ('delivered','partial','failed','full_return'))=0 THEN 0 ELSE round(100.0*count(*) FILTER (WHERE o.status IN ('delivered','partial'))/count(*) FILTER (WHERE o.status IN ('delivered','partial','failed','full_return')),1) END,
            COALESCE(sum(o.collected_amount),0)
          FROM users u LEFT JOIN orders o ON o.current_partner_id=u.id AND o.deleted_at IS NULL AND ${DATE()} ${FILT}
          WHERE u.business_id=$1 AND u.role='delivery_partner' AND u.deleted_at IS NULL GROUP BY u.id,u.name ORDER BY u.name` },
  manager_performance: { cols: ['Manager', 'Orders Handled', 'Delivered', 'Partial', 'Failed', 'Full Return', 'Verified Complete'],
    sql: `SELECT u.name, count(o.id), count(*) FILTER (WHERE o.status='delivered'), count(*) FILTER (WHERE o.status='partial'), count(*) FILTER (WHERE o.status='failed'), count(*) FILTER (WHERE o.status='full_return'), count(*) FILTER (WHERE o.final_status='complete')
          FROM users u LEFT JOIN orders o ON o.assigned_manager_id=u.id AND o.deleted_at IS NULL AND ${DATE()} ${FILT}
          WHERE u.business_id=$1 AND u.role='manager' AND u.deleted_at IS NULL GROUP BY u.id,u.name ORDER BY u.name` },
  revenue: { cols: ['Date', 'Orders', 'Delivered Amount', 'Returned Amount', 'Collected', 'Change Given'],
    sql: `SELECT to_char(o.created_at AT TIME ZONE $4,'YYYY-MM-DD'), count(*), COALESCE(sum(o.delivered_amount),0), COALESCE(sum(o.returned_amount),0), COALESCE(sum(o.collected_amount),0), COALESCE(sum(o.change_given),0)
          FROM orders o WHERE o.business_id=$1 AND o.deleted_at IS NULL AND o.status IN ('delivered','partial','full_return') AND ${DATE()} ${FILT} GROUP BY 1 ORDER BY 1 DESC` },
};

export async function runReport(businessId: string, auth: Auth, type: ReportType, f: ReportFilters, page?: { page: number; limit: number }) {
  const def = SQL[type]; if (!def) throw badRequest('Unknown report type');
  if (f.partnerId && !/^[0-9a-f-]{36}$/i.test(f.partnerId)) throw badRequest('Invalid partnerId');
  if (f.managerId && !/^[0-9a-f-]{36}$/i.test(f.managerId)) throw badRequest('Invalid managerId');
  const r = await effectiveRange(businessId, auth, f);
  const cap = page ? '' : ' LIMIT 50000';
  const { rows, fields } = await (await import('../db.js')).pool.query({ text: def.sql + cap, values: [businessId, r.from, r.to, r.tz, f.status ?? null, f.partnerId ?? null, f.managerId ?? null], rowMode: 'array' });
  void fields;
  const all = rows as any[][];
  const out = page ? all.slice((page.page - 1) * page.limit, page.page * page.limit) : all;
  return { columns: def.cols, rows: out, total: all.length, range: { from: r.from, to: r.to, timezone: r.tz, scope: r.scope } };
}

const cell = (v: any) => {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = `'${s}`;          // CSV/Excel formula-injection guard
  return s;
};
export function toCsv(columns: string[], rows: any[][]) {
  const esc = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return '\uFEFF' + [columns, ...rows].map(r => r.map(c => esc(cell(c))).join(',')).join('\r\n');
}
const h = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** Excel-compatible (HTML table, opens natively in Excel) and print/PDF-ready. */
export function toHtmlTable(title: string, columns: string[], rows: any[][]) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(title)}</title><style>body{font-family:Arial,sans-serif}table{border-collapse:collapse}th,td{border:1px solid #999;padding:4px 8px;font-size:12px}th{background:#e8f1fb}</style></head><body><h3>${h(title)}</h3><table><thead><tr>${columns.map(c => `<th>${h(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${h(cell(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}
