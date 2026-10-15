import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDatabase } from '../src/migrate.js';
import { pool, one, tx } from '../src/db.js';
import { createUserRecord } from '../src/services/users.js';

export const app = createApp();
export const api = () => request(app);
export const PW = 'Demo@1234';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function login(email: string, password = PW) {
  const r = await api().post('/api/auth/login').send({ email, password });
  return { res: r, token: r.body?.data?.accessToken as string, refresh: r.body?.data?.refreshToken as string, user: r.body?.data?.user };
}
export const as = (token: string) => ({
  get: (u: string) => api().get(u).set('Authorization', `Bearer ${token}`),
  post: (u: string, b: any = {}) => api().post(u).set('Authorization', `Bearer ${token}`).send(b),
  put: (u: string, b: any = {}) => api().put(u).set('Authorization', `Bearer ${token}`).send(b),
  patch: (u: string, b: any = {}) => api().patch(u).set('Authorization', `Bearer ${token}`).send(b),
  del: (u: string) => api().delete(u).set('Authorization', `Bearer ${token}`),
});

export interface World {
  owner: ReturnType<typeof as>; planId: string;
  A: Biz; B: Biz;
}
export interface Biz { id: string; admin: ReturnType<typeof as>; manager: ReturnType<typeof as>; partner: ReturnType<typeof as>; partner2: ReturnType<typeof as>; partnerId: string; partner2Id: string; managerId: string; adminId: string; adminEmail: string; }

/** Fresh database + owner + two onboarded businesses (A and B) with admin, manager and two duty-on partners each. */
export async function buildWorld(): Promise<World> {
  await resetDatabase();
  const plan = await one<any>(`INSERT INTO plans(name,price,api_access,google_sheets,whatsapp) VALUES('Pro',2999,true,true,true) RETURNING id`);
  await tx(c => createUserRecord(c, { businessId: null, role: 'owner', name: 'Owner', email: 'owner@test.dev', password: PW, createdBy: null }));
  const owner = as((await login('owner@test.dev')).token);
  const mk = async (name: string, slug: string): Promise<Biz> => {
    const r = await owner.post('/api/owner/businesses', { name, businessType: 'Retail', planId: plan!.id, admin: { name: `${name} Admin`, email: `admin@${slug}.test`, password: PW } });
    if (r.status !== 201) throw new Error('onboarding failed ' + JSON.stringify(r.body));
    const id = r.body.data.business.id, adminEmail = `admin@${slug}.test`;
    const admin = as((await login(adminEmail)).token);
    const m = await admin.post('/api/users', { role: 'manager', name: 'Mgr', email: `mgr@${slug}.test`, password: PW });
    const p1 = await admin.post('/api/users', { role: 'delivery_partner', name: 'P1', email: `p1@${slug}.test`, password: PW, mobile: '9000000001' });
    const p2 = await admin.post('/api/users', { role: 'delivery_partner', name: 'P2', email: `p2@${slug}.test`, password: PW, mobile: '9000000002' });
    const partner = as((await login(`p1@${slug}.test`)).token), partner2 = as((await login(`p2@${slug}.test`)).token);
    for (const p of [partner, partner2]) { const d = await p.post('/api/me/duty', { on: true }); if (d.status !== 200) throw new Error('duty ON failed: ' + JSON.stringify(d.body)); }
    return { id, admin, manager: as((await login(`mgr@${slug}.test`)).token), partner, partner2, partnerId: p1.body.data.id, partner2Id: p2.body.data.id, managerId: m.body.data.id, adminId: r.body.data.admin.id, adminEmail };
  };
  return { owner, planId: plan!.id, A: await mk('Alpha Store', 'alpha'), B: await mk('Beta Pharmacy', 'beta') };
}

export const newOrder = (o: Partial<any> = {}) => ({ invoiceNumber: 'INV-' + Math.random().toString(36).slice(2, 9), customerName: 'Test Customer', customerMobile: '9810000001', customerAddress: '12 Main Road', billAmount: 950, changeAmount: 50, paymentMode: 'cod', ...o });

export async function upload(who: ReturnType<typeof as> & { _t?: string }, token: string, kind: string, orderId?: string) {
  const r = await api().post('/api/files').set('Authorization', `Bearer ${token}`).field('kind', kind).field('orderId', orderId ?? '').attach('file', png, { filename: 'p.png', contentType: 'image/png' });
  return r;
}
export const closeDb = () => pool.end();
