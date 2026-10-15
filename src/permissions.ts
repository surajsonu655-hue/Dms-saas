import { query, tx, type Db } from './db.js';
import { forbidden } from './errors.js';

export type Role = 'owner' | 'business_admin' | 'manager' | 'delivery_partner';
export const ROLE_RANK: Record<Role, number> = { owner: 0, business_admin: 1, manager: 2, delivery_partner: 3 };

type P = [key: string, category: string, description: string, scope?: 'platform' | 'business'];
export const PERMISSION_CATALOG: P[] = [
  ['orders.view', 'Orders', 'View orders'], ['orders.create', 'Orders', 'Create orders'], ['orders.edit', 'Orders', 'Edit orders'], ['orders.delete', 'Orders', 'Delete orders'],
  ['deliveries.view', 'Deliveries', 'View all deliveries'], ['deliveries.assign', 'Deliveries', 'Assign delivery partners'], ['deliveries.reassign', 'Deliveries', 'Reassign deliveries'],
  ['deliveries.update', 'Deliveries', 'Update delivery status on behalf of partners'], ['deliveries.verify', 'Deliveries', 'Verify completed deliveries (Complete / Incomplete)'],
  ['customers.view', 'Customers', 'View customers'], ['customers.create', 'Customers', 'Create customers'], ['customers.edit', 'Customers', 'Edit customers'],
  ['cod.view', 'COD', 'View COD'], ['cod.manage', 'COD', 'Manage COD'], ['cod.settle', 'COD', 'Settle COD with partners'],
  ['returns.view', 'Returns', 'View returns'], ['returns.manage', 'Returns', 'Manage return workflow'],
  ['reports.view', 'Reports', 'View reports'], ['reports.export', 'Reports', 'Export reports'],
  ['users.view', 'Users', 'View staff'], ['users.create', 'Users', 'Create staff'], ['users.edit', 'Users', 'Edit staff'], ['users.delete', 'Users', 'Delete staff'],
  ['permissions.manage', 'Users', 'Grant or revoke permissions for staff'],
  ['settings.view', 'Settings', 'View business settings'], ['settings.manage', 'Settings', 'Change business settings'],
  ['integrations.view', 'Integrations', 'View integrations'], ['integrations.manage', 'Integrations', 'Connect and manage integrations (Google Sheets)'],
  ['webhooks.manage', 'Developer', 'Manage webhooks'], ['apikeys.manage', 'Developer', 'Manage API keys'],
  ['notifications.view', 'Notifications', 'View notifications'],
  ['platform.businesses.manage', 'Platform', 'Create and manage businesses', 'platform'], ['platform.plans.manage', 'Platform', 'Manage plans', 'platform'],
  ['platform.reports.view', 'Platform', 'View platform reports', 'platform'], ['platform.users.manage', 'Platform', 'Manage platform users', 'platform'],
];
export const BUSINESS_PERMISSIONS = PERMISSION_CATALOG.filter(p => (p[3] ?? 'business') === 'business').map(p => p[0]);
export const PLATFORM_PERMISSIONS = PERMISSION_CATALOG.filter(p => p[3] === 'platform').map(p => p[0]);

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: [...BUSINESS_PERMISSIONS, ...PLATFORM_PERMISSIONS],
  business_admin: BUSINESS_PERMISSIONS,
  manager: ['orders.view', 'orders.create', 'orders.edit', 'deliveries.view', 'deliveries.assign', 'deliveries.reassign', 'deliveries.update', 'deliveries.verify',
    'customers.view', 'customers.create', 'customers.edit', 'cod.view', 'returns.view', 'returns.manage', 'reports.view', 'notifications.view'],
  delivery_partner: [],
};
/** Permissions that a Business Admin may never pass on to a Manager. */
export const NOT_DELEGABLE = new Set(['permissions.manage', 'users.delete', 'apikeys.manage']);

export async function seedPermissionCatalog(db: Db) {
  for (const [key, category, description, scope] of PERMISSION_CATALOG)
    await query(`INSERT INTO permissions(key,category,description,scope) VALUES($1,$2,$3,$4)
                 ON CONFLICT (key) DO UPDATE SET category=EXCLUDED.category, description=EXCLUDED.description, scope=EXCLUDED.scope`, [key, category, description, scope ?? 'business'], db);
  const roles: [Role, string][] = [['owner', 'System Owner'], ['business_admin', 'Business Admin'], ['manager', 'Manager'], ['delivery_partner', 'Delivery Partner']];
  for (const [r, l] of roles) await query(`INSERT INTO roles(role,label,rank) VALUES($1,$2,$3) ON CONFLICT (role) DO NOTHING`, [r, l, ROLE_RANK[r]], db);
  for (const [r, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    for (const k of keys) await query(`INSERT INTO role_permissions(role,permission_key) VALUES($1,$2) ON CONFLICT DO NOTHING`, [r, k], db);
}

export async function loadPermissions(userId: string, db: Db = undefined as any): Promise<Set<string>> {
  const rows = await query<{ permission_key: string }>(`SELECT permission_key FROM user_permissions WHERE user_id=$1`, [userId], db);
  return new Set(rows.map(r => r.permission_key));
}

/** Give a newly created user the default permissions for its role, limited to what the creator holds. */
export async function grantDefaults(db: Db, userId: string, businessId: string, role: Role, grantedBy: string | null, creatorPerms?: Set<string>) {
  for (const k of DEFAULT_ROLE_PERMISSIONS[role]) {
    if (creatorPerms && !creatorPerms.has(k)) continue;
    if (role === 'manager' && NOT_DELEGABLE.has(k)) continue;
    await query(`INSERT INTO user_permissions(user_id,business_id,permission_key,granted_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [userId, businessId, k, grantedBy], db);
  }
}

/**
 * Hierarchy rule: a user can only receive a permission its parent administrator holds.
 *  - Owner  -> Business Admin : any business permission
 *  - Admin  -> Manager        : only permissions the admin currently holds, and never NOT_DELEGABLE ones
 * Delivery partners are role-driven and never receive grantable permissions.
 */
export function assertCanGrant(grantor: { role: Role; perms: Set<string> }, targetRole: Role, keys: string[]) {
  if (targetRole === 'delivery_partner' || targetRole === 'owner') throw forbidden('Permissions cannot be assigned to this role');
  for (const k of keys) {
    if (!BUSINESS_PERMISSIONS.includes(k)) throw forbidden(`Unknown or non-grantable permission: ${k}`);
    if (grantor.role === 'owner') { if (targetRole !== 'business_admin' && targetRole !== 'manager') throw forbidden(); continue; }
    if (grantor.role !== 'business_admin' || targetRole !== 'manager') throw forbidden('Only a Business Admin can grant permissions to Managers');
    if (!grantor.perms.has(k)) throw forbidden(`You cannot grant "${k}" because you do not hold it`, 'PERMISSION_NOT_HELD');
    if (NOT_DELEGABLE.has(k)) throw forbidden(`"${k}" cannot be delegated to a Manager`, 'NOT_DELEGABLE');
  }
}

/** Replace a user's permission set. Revoking from an admin cascades to that business's managers immediately. */
export async function setUserPermissions(userId: string, businessId: string, targetRole: Role, keys: string[], grantedBy: string) {
  await tx(async c => {
    const before = await loadPermissions(userId, c);
    await query(`DELETE FROM user_permissions WHERE user_id=$1`, [userId], c);
    for (const k of keys) await query(`INSERT INTO user_permissions(user_id,business_id,permission_key,granted_by) VALUES($1,$2,$3,$4)`, [userId, businessId, k, grantedBy], c);
    if (targetRole === 'business_admin') {
      const removed = [...before].filter(k => !keys.includes(k));
      if (removed.length) await query(`DELETE FROM user_permissions up USING users u WHERE up.user_id=u.id AND u.business_id=$1 AND u.role='manager' AND up.permission_key = ANY($2)`, [businessId, removed], c);
    }
  });
}
