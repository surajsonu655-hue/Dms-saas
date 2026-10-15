import type { PoolClient } from 'pg';
import { one } from '../db.js';
import { hashPassword } from '../auth.js';
import { conflict } from '../errors.js';
import { grantDefaults, type Role } from '../permissions.js';

export async function createUserRecord(c: PoolClient, a: { businessId: string | null; role: Role; name: string; email: string; mobile?: string; designation?: string; password: string; status?: string; createdBy: string | null; creatorPerms?: Set<string> }) {
  const dup = await one(`SELECT 1 FROM users WHERE email=$1`, [a.email], c);
  if (dup) throw conflict('A user with this email already exists', 'EMAIL_TAKEN');
  const u = (await one<any>(`INSERT INTO users(business_id,role,name,email,mobile,designation,password_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,business_id,role,name,email,mobile,designation,status,duty_on,created_at`,
    [a.businessId, a.role, a.name, a.email, a.mobile ?? null, a.designation ?? null, await hashPassword(a.password), a.status ?? 'active'], c))!;
  if (a.businessId) await grantDefaults(c, u.id, a.businessId, a.role, a.createdBy, a.creatorPerms);
  return u;
}
export const publicUser = (u: any) => ({ id: u.id, name: u.name, email: u.email, mobile: u.mobile, designation: u.designation, role: u.role, status: u.status, dutyOn: u.duty_on, businessId: u.business_id, createdAt: u.created_at });
