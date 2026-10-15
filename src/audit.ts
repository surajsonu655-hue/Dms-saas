import type { Request } from 'express';
import { query, type Db } from './db.js';
import type { Auth } from './auth.js';

export async function audit(db: Db | undefined, a: { auth?: Auth | null; businessId?: string | null; action: string; entity?: string; entityId?: string; oldValue?: any; newValue?: any; req?: Request }) {
  const { auth, req } = a;
  const safe = (v: any) => v === undefined ? null : JSON.stringify(v, (k, val) => /password|secret|token|hash/i.test(k) ? '[redacted]' : val);
  await query(`INSERT INTO audit_logs(business_id,user_id,user_role,action,entity,entity_id,old_value,new_value,ip,user_agent)
               VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [a.businessId ?? auth?.businessId ?? null, auth?.userId ?? null, auth?.role ?? null, a.action, a.entity ?? null, a.entityId ?? null,
     safe(a.oldValue), safe(a.newValue), req?.ip ?? null, (req?.headers['user-agent'] as string) ?? null], db);
}
