/** OpenAPI 3.0 document generated from a compact route table (served at /api/openapi.json and /api/docs). */
type R = [method: string, path: string, tag: string, summary: string, auth: string, body?: any];
const ROUTES: R[] = [
  ['post', '/auth/login', 'Authentication', 'Sign in with email and password; returns access + refresh tokens', 'public', { email: 'admin1@store2door.demo', password: 'Demo@1234' }],
  ['post', '/auth/refresh', 'Authentication', 'Exchange a refresh token for a new token pair (rotates the session)', 'public', { refreshToken: '...' }],
  ['post', '/auth/logout', 'Authentication', 'End the session; the access token stops working immediately', 'any user'],
  ['get', '/auth/me', 'Authentication', 'Current user, role, business and permissions', 'any user'],
  ['post', '/auth/change-password', 'Authentication', 'Change own password', 'any user', { currentPassword: '...', newPassword: 'NewPass@123' }],

  ['get', '/owner/dashboard', 'Owner', 'Platform KPIs: businesses, revenue, subscriptions, staff', 'platform.reports.view'],
  ['get', '/owner/businesses', 'Owner', 'List businesses with revenue, staff counts and admin (paginated)', 'platform.businesses.manage'],
  ['post', '/owner/businesses', 'Owner', 'Onboard a business and create its first Business Admin', 'platform.businesses.manage', { name: 'Acme Pharmacy', businessType: 'Pharmacy', admin: { name: 'Asha', email: 'asha@acme.test', password: 'Welcome@123' }, planId: '<uuid>' }],
  ['get', '/owner/businesses/{id}', 'Owner', 'Business overview (details, revenue, staff, subscription) - no operational order data', 'platform.businesses.manage'],
  ['get', '/owner/businesses/{id}/staff', 'Owner', 'Staff of a business', 'platform.businesses.manage'],
  ['patch', '/owner/businesses/{id}', 'Owner', 'Edit business details', 'platform.businesses.manage'],
  ['post', '/owner/businesses/{id}/suspend', 'Owner', 'Suspend a business (all its users are blocked immediately)', 'platform.businesses.manage'],
  ['post', '/owner/businesses/{id}/activate', 'Owner', 'Activate a business', 'platform.businesses.manage'],
  ['post', '/owner/businesses/{id}/deactivate', 'Owner', 'Mark a business inactive', 'platform.businesses.manage'],
  ['delete', '/owner/businesses/{id}', 'Owner', 'Soft-delete a business (data retained)', 'platform.businesses.manage'],
  ['put', '/owner/businesses/{id}/subscription', 'Owner', 'Set plan, status, renewal date and limit overrides', 'platform.plans.manage'],
  ['get', '/owner/users/{userId}/permissions', 'Owner', 'Permissions held by a Business Admin', 'platform.users.manage'],
  ['put', '/owner/users/{userId}/permissions', 'Owner', 'Replace a Business Admin\'s permissions (revocations cascade to managers)', 'platform.users.manage', { permissions: ['orders.view', 'orders.create'] }],
  ['get', '/owner/permissions', 'Owner', 'Permission catalog', 'platform.users.manage'],
  ['get', '/owner/plans', 'Owner', 'List plans', 'platform.plans.manage'],
  ['post', '/owner/plans', 'Owner', 'Create plan', 'platform.plans.manage'],
  ['patch', '/owner/plans/{id}', 'Owner', 'Edit plan', 'platform.plans.manage'],
  ['post', '/owner/users', 'Owner', 'Create a platform user or Business Admin', 'platform.users.manage'],
  ['get', '/owner/reports/businesses', 'Owner', 'Business-level report; ?format=csv|excel', 'platform.reports.view'],
  ['get', '/owner/audit-logs', 'Owner', 'Administrative audit log', 'platform.reports.view'],

  ['get', '/business', 'Business', 'Own business profile', 'business user'],
  ['patch', '/business', 'Business', 'Edit own business details', 'settings.manage'],
  ['get', '/business/settings', 'Business', 'COD / returns / partial / OTP / proof / notification settings', 'settings.view'],
  ['put', '/business/settings', 'Business', 'Update settings (including manager report scope)', 'settings.manage'],
  ['get', '/business/subscription', 'Business', 'Plan, status, renewal date, limits and usage', 'settings.view'],

  ['get', '/users', 'Users', 'List staff (paginated, filter by role/status/search)', 'users.view'],
  ['post', '/users', 'Users', 'Create a manager or delivery partner (plan limits enforced)', 'users.create', { name: 'Rahul', email: 'rahul@x.test', mobile: '9876543210', role: 'delivery_partner', password: 'Welcome@123' }],
  ['get', '/users/{id}', 'Users', 'Get a staff member', 'users.view'],
  ['patch', '/users/{id}', 'Users', 'Edit / activate / deactivate staff', 'users.edit'],
  ['delete', '/users/{id}', 'Users', 'Soft-delete staff', 'users.delete'],
  ['post', '/users/{id}/reset-password', 'Users', 'Reset a staff password', 'users.edit'],
  ['get', '/users/{id}/permissions', 'Permissions', 'Permissions of a staff member', 'users.view'],
  ['put', '/users/{id}/permissions', 'Permissions', 'Admin grants permissions to a Manager (only permissions the admin holds)', 'permissions.manage', { permissions: ['orders.view', 'reports.view'] }],
  ['post', '/me/duty', 'Users', 'Delivery partner duty ON/OFF (OFF blocked while orders are unresolved)', 'delivery_partner', { on: true }],

  ['get', '/customers', 'Customers', 'List customers', 'customers.view'],
  ['post', '/customers', 'Customers', 'Create customer', 'customers.create'],
  ['get', '/customers/{id}', 'Customers', 'Customer with order history', 'customers.view'],
  ['patch', '/customers/{id}', 'Customers', 'Edit customer', 'customers.edit'],

  ['get', '/orders', 'Orders', 'List orders - page, limit, sort, dir, status, partnerId, managerId, from, to, q', 'orders.view'],
  ['post', '/orders', 'Orders', 'Create order. receivable = bill + change (computed server-side)', 'orders.create', { invoiceNumber: 'INV-1001', customerName: 'A. Sharma', customerMobile: '9810000001', customerAddress: '12 Main Rd', billAmount: 950, changeAmount: 50, paymentMode: 'cod' }],
  ['get', '/orders/{id}', 'Orders', 'Order with items, deliveries, assignments, events, returns, payments', 'orders.view'],
  ['patch', '/orders/{id}', 'Orders', 'Edit an order that is not yet assigned', 'orders.edit'],
  ['delete', '/orders/{id}', 'Orders', 'Soft-delete an order without delivery history', 'orders.delete'],
  ['post', '/orders/{id}/ready', 'Orders', 'created -> ready', 'orders.edit'],
  ['post', '/orders/{id}/assign', 'Orders', 'Assign / reassign a delivery partner (history preserved)', 'deliveries.assign | deliveries.reassign', { partnerId: '<uuid>', reason: 'Closer to customer' }],
  ['post', '/orders/{id}/cancel', 'Orders', 'Cancel an order', 'orders.edit'],
  ['post', '/orders/{id}/retry', 'Orders', 'failed -> ready for another attempt', 'deliveries.assign'],
  ['post', '/orders/{id}/verify', 'Orders', 'Manager verification: Complete / Incomplete with final amount', 'deliveries.verify', { result: 'complete', finalAmount: 1000, remarks: '' }],
  ['get', '/orders/{id}/events', 'Orders', 'Immutable delivery event history', 'orders.view'],

  ['get', '/deliveries', 'Deliveries', 'Partner: own deliveries. Staff: all (deliveries.view)', 'partner / deliveries.view'],
  ['get', '/deliveries/{orderId}', 'Deliveries', 'Partner: one assigned delivery', 'delivery_partner'],
  ['post', '/deliveries/{orderId}/{action}', 'Deliveries', 'action = accept | reject | pickup | start | arrive | deliver | partial | fail | full_return', 'delivery_partner (assigned only)',
    { customerPaid: 1000, paymentMode: 'cod', paymentProofFileId: '<uuid>', otp: '123456', latitude: 28.45, longitude: 77.02 }],
  ['post', '/files', 'Files', 'Upload proof (multipart: file, kind, orderId). jpeg/png/webp/pdf, max 5 MB', 'authenticated'],
  ['get', '/files/{id}', 'Files', 'Download a file (tenant-checked)', 'authenticated'],

  ['get', '/cod/summary', 'COD', 'Expected / collected / pending / submitted / settled totals per partner', 'cod.view | partner'],
  ['get', '/cod/transactions', 'COD', 'COD transactions', 'cod.view | partner'],
  ['post', '/cod/submit', 'COD', 'Partner submits collected cash for settlement', 'delivery_partner'],
  ['post', '/cod/settlements', 'COD', 'Settle cash received from a partner (FIFO allocation)', 'cod.settle', { partnerId: '<uuid>', amount: 1500, referenceNo: 'REF-1' }],
  ['get', '/cod/settlements', 'COD', 'Settlement history', 'cod.view'],

  ['get', '/returns', 'Returns', 'List returns (partial + full)', 'returns.view'],
  ['patch', '/returns/{id}/status', 'Returns', 'Advance return workflow (created -> ... -> closed)', 'returns.manage'],

  ['get', '/reports', 'Reports', 'Available report types', 'reports.view'],
  ['get', '/reports/{type}', 'Reports', 'type = orders|deliveries|failed|returns|partial|cod|partners|managers|revenue; from, to, status, partnerId, managerId, format=json|csv|excel', 'reports.view (+ reports.export for csv/excel)'],

  ['get', '/notifications', 'Notifications', 'In-app notifications', 'authenticated'],
  ['post', '/notifications/{id}/read', 'Notifications', 'Mark read', 'authenticated'],
  ['post', '/notifications/read-all', 'Notifications', 'Mark all read', 'authenticated'],

  ['get', '/integrations/google', 'Google Sheets', 'Connection status', 'integrations.view'],
  ['get', '/integrations/google/auth-url', 'Google Sheets', 'Start Google OAuth', 'integrations.manage'],
  ['get', '/integrations/google/callback', 'Google Sheets', 'OAuth redirect target', 'signed state'],
  ['put', '/integrations/google/sheet', 'Google Sheets', 'Choose spreadsheet + sheet name', 'integrations.manage', { spreadsheetId: '1AbC...', sheetName: 'Orders' }],
  ['post', '/integrations/google/sync', 'Google Sheets', 'Queue a backfill of existing orders', 'integrations.manage'],
  ['post', '/integrations/google/sync/run', 'Google Sheets', 'Process due sync jobs now', 'integrations.manage'],
  ['get', '/integrations/google/sync-logs', 'Google Sheets', 'Sync log / queue', 'integrations.view'],
  ['delete', '/integrations/google', 'Google Sheets', 'Disconnect', 'integrations.manage'],

  ['get', '/webhooks', 'Webhooks', 'List webhooks', 'webhooks.manage'],
  ['get', '/webhooks/events', 'Webhooks', 'Supported events', 'webhooks.manage'],
  ['post', '/webhooks', 'Webhooks', 'Create (secret returned once)', 'webhooks.manage', { url: 'https://example.com/hook', events: ['order.created', 'delivery.delivered'] }],
  ['patch', '/webhooks/{id}', 'Webhooks', 'Edit / activate / deactivate', 'webhooks.manage'],
  ['post', '/webhooks/{id}/rotate-secret', 'Webhooks', 'Rotate signing secret', 'webhooks.manage'],
  ['delete', '/webhooks/{id}', 'Webhooks', 'Delete', 'webhooks.manage'],
  ['post', '/webhooks/{id}/test', 'Webhooks', 'Queue a test event', 'webhooks.manage'],
  ['get', '/webhooks/{id}/deliveries', 'Webhooks', 'Delivery attempts', 'webhooks.manage'],
  ['post', '/webhooks/deliveries/{id}/retry', 'Webhooks', 'Retry a failed delivery', 'webhooks.manage'],

  ['get', '/api-keys', 'API Keys', 'List keys (prefix only)', 'apikeys.manage'],
  ['post', '/api-keys', 'API Keys', 'Create key; full secret shown once. Use header x-api-key', 'apikeys.manage', { name: 'ERP', scopes: ['orders.create', 'orders.view'] }],
  ['delete', '/api-keys/{id}', 'API Keys', 'Revoke key', 'apikeys.manage'],
];

export function buildOpenApi() {
  const paths: Record<string, any> = {};
  for (const [method, path, tag, summary, auth, body] of ROUTES) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    paths[path] ??= {};
    paths[path][method] = {
      tags: [tag], summary, description: `**Access:** ${auth}`,
      ...(params.length ? { parameters: params } : {}),
      ...(body ? { requestBody: { content: { 'application/json': { example: body } } } } : {}),
      ...(auth === 'public' ? { security: [] } : {}),
      responses: {
        '200': { description: 'Success: { success: true, data, message, meta? }' },
        '400': { description: 'VALIDATION_ERROR' }, '401': { description: 'UNAUTHORIZED / TOKEN_INVALID' },
        '403': { description: 'FORBIDDEN / PERMISSION_DENIED' }, '404': { description: 'NOT_FOUND' }, '409': { description: 'CONFLICT / INVALID_TRANSITION' },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'DMS SaaS API', version: '1.0.0', description: 'Multi-tenant Delivery Management System. Errors: { success:false, message, code, error:{ code, message, details[] } }' },
    servers: [{ url: '/api' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
    security: [{ bearer: [] }, { apiKey: [] }],
    paths,
  };
}
