/* DMS web UI -> backend connection layer.
 * Loaded only when the page is served by the backend (window.DMS_API_BASE is set). It does NOT redefine business rules:
 * every order/status/amount rule lives in the server. This file only (1) signs in, (2) fetches and shows server data,
 * (3) sends the user's actions, and (4) turns server errors into messages. Modules not yet connected show a notice, never demo data. */
(function () {
  'use strict';
  const API = window.DMS_API_BASE; if (!API) return;
  const RT_KEY = 'dms_rt', RMAP = { owner: 'owner', business_admin: 'admin', manager: 'manager', delivery_partner: 'partner' };
  const T = { at: null }; const AS = { user: null, perms: new Set(), partners: [], gen: 0 };
  const g = id => document.getElementById(id), q$ = (s, r = document) => r.querySelector(s);
  const getRT = () => { try { return sessionStorage.getItem(RT_KEY); } catch { return null; } };
  const setRT = v => { try { v ? sessionStorage.setItem(RT_KEY, v) : sessionStorage.removeItem(RT_KEY); } catch { /* storage unavailable */ } };

  // ------------------------------------------------------------------ HTTP client
  class ApiError extends Error { constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details || []; } }
  async function raw(path, o = {}) {
    const h = { Accept: 'application/json' }; if (T.at) h.Authorization = 'Bearer ' + T.at;
    let body; if (o.form) body = o.form; else if (o.body !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    let r; try { r = await fetch(API + path, { method: o.method || 'GET', headers: h, body }); }
    catch { throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.'); }
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok || (j && j.success === false)) {
      const e = j && j.error || {};
      throw new ApiError(r.status, e.code || j?.code || 'HTTP_' + r.status, e.message || j?.message || (r.status >= 500 ? 'The server had a problem. Please try again.' : 'Request failed'), e.details);
    }
    return j;
  }
  let refreshing = null;
  function refresh() {
    if (!refreshing) refreshing = (async () => {
      const rt = getRT(); if (!rt) return false;
      try { const r = await raw('/auth/refresh', { method: 'POST', body: { refreshToken: rt } }); T.at = r.data.accessToken; setRT(r.data.refreshToken); return true; }
      catch { return false; } finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function api(path, o = {}) {
    try { return await raw(path, o); }
    catch (e) {
      if (e.status === 401 && ['TOKEN_INVALID', 'SESSION_ENDED'].includes(e.code) && !o.retried && await refresh()) return api(path, { ...o, retried: true });
      if (e.status === 401 && ['TOKEN_INVALID', 'SESSION_ENDED', 'UNAUTHORIZED'].includes(e.code)) hardLogout('Your session has ended. Please sign in again.');
      throw e;
    }
  }
  const msgOf = e => !(e instanceof ApiError) ? 'Something went wrong. Please try again.' :
    e.message + (e.details.length && e.code === 'VALIDATION_ERROR' ? ': ' + e.details.map(d => (d.path ? d.path + ' - ' : '') + d.message).join('; ') : '');

  // ------------------------------------------------------------------ session
  function clearDemoData() {
    [orders, partners, STAFF, returns, NT, log].forEach(a => { a.length = 0; });
    BIZ.length = 0;
  }
  function enterApp(user) {
    clearDemoData(); AS.user = user; AS.perms = new Set(user.permissions); AS.gen++;
    BIZ.push({ id: 1, name: user.business ? user.business.name : 'DMS Platform', type: user.business ? user.business.type : 'Platform', status: 'Active', plan: '', sub: '', created: '' });
    S.biz = 1; S.role = RMAP[user.role]; S.view = S.role === 'owner' ? 'odash' : S.role === 'partner' ? 'home' : 'dash';
    USER.name = user.name; USER.email = user.email; USER.phone = user.mobile || '—'; USER.pic = null;
    S.user = USER; S.at = S.last = Date.now(); S.range = 7; S.filter = null;
    const qs = o => { const s = document.querySelector(o); if (s) s.style.display = 'none'; };
    qs('.demo'); qs('#biz'); qs('#exp');
    g('biz').innerHTML = '<option value="1">' + esc(BIZ[0].name) + '</option>'; g('lerr').textContent = '';
    O.pg = 1; O.q = ''; O.st = ''; O.pf = ''; loadPartners(); render(); refreshBell(); if (window.googleReturn) window.googleReturn();
  }
  function hardLogout(msg) {
    const had = T.at; T.at = null; setRT(null);
    if (had) fetch(API + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + had } }).catch(() => {});
    AS.user = null; AS.perms = new Set(); AS.partners = []; AS.gen++; clearDemoData();
    S.user = null; g('lerr').textContent = msg || ''; render();
  }
  async function afterLogin(r) { T.at = r.accessToken; setRT(r.refreshToken); enterApp(r.user); }

  g('lf').onsubmit = async e => {
    e.preventDefault(); const b = g('lb'), em = g('le').value.trim().toLowerCase(), pw = g('lp').value;
    if (!em || !pw) { g('lerr').textContent = 'Enter your email address and password.'; return; }
    if (!/^\S+@\S+\.\S+$/.test(em)) { g('lerr').textContent = 'Enter a valid email address.'; return; }
    b.disabled = true; b.innerHTML = '<span class="spin"></span> Signing in…'; g('lerr').textContent = '';
    try {
      const r = await raw('/auth/login', { method: 'POST', body: { email: em, password: pw } });
      try { g('rm').checked ? localStorage.setItem('dms_email', em) : localStorage.removeItem('dms_email'); } catch { /* ignore */ }
      b.innerHTML = '✓ Welcome back'; g('login').classList.add('ok'); await new Promise(r2 => setTimeout(r2, 250));
      g('lp').value = ''; await afterLogin(r.data); g('login').classList.remove('ok');
    } catch (err) {
      g('lerr').textContent = err.code === 'INVALID_CREDENTIALS' ? 'Incorrect email or password.' : msgOf(err);
    } finally { b.disabled = false; b.innerHTML = 'Login <span aria-hidden="true">→</span>'; }
  };
  document.addEventListener('click', e => { if (e.target.closest('[data-lo]')) hardLogout(''); });
  setInterval(() => { if (AS.user && !S.user) hardLogout('You were signed out after a period of inactivity.'); }, 3000);

  // ------------------------------------------------------------------ permissions (names mapped to the SERVER's permission keys; the server still enforces everything)
  const PM = { orders: { v: 'orders.view', c: 'orders.create', e: 'orders.edit', d: 'orders.delete', x: 'orders.view' }, createorders: { c: 'orders.create' },
    assign: { e: 'deliveries.assign' }, reassign: { e: 'deliveries.reassign' }, partners: { v: 'deliveries.view' }, returns: { v: 'returns.view', e: 'returns.manage' },
    cod: { v: 'cod.view' }, reports: { v: 'reports.view', x: 'reports.export' }, export: { v: 'reports.export', x: 'reports.export' }, staff: { v: 'users.view', c: 'users.create', e: 'users.edit' },
    managers: { v: 'users.view' }, settings: { v: 'settings.view', e: 'settings.manage' }, sheets: { v: 'integrations.view', e: 'integrations.manage' }, notifications: { v: 'notifications.view' },
    deliveries: { v: 'deliveries.view', e: 'deliveries.update' } };
  window.can = function (m, a) {
    a = a || 'v'; if (S.role === 'owner') return true; if (S.role === 'partner') return false;
    if (m === 'dashboard') return true;
    const k = PM[m] && PM[m][a]; return !!k && AS.perms.has(k);
  };
  const has = p => AS.perms.has(p);

  // ------------------------------------------------------------------ small UI helpers
  const css = document.createElement('style');
  css.textContent = '.sk{height:14px;border-radius:6px;background:linear-gradient(90deg,#e3edf9,#f4f8fd,#e3edf9);background-size:200% 100%;animation:skm 1.2s linear infinite;margin:10px 0}@keyframes skm{to{background-position:-200% 0}}.axerr{border:1px solid #f0b7bd;background:#fff5f6;border-radius:12px;padding:16px;color:#8a1f2b}.axmini{font-size:12px}.axtl li{padding:4px 0 4px 10px;border-left:2px solid var(--line);font-size:13px;list-style:none}.axtl{padding:0;margin:0}';
  document.head.appendChild(css);
  const skel = n => '<div class="card">' + Array.from({ length: n }, (_, i) => '<div class="sk" style="width:' + (60 + (i * 13) % 40) + '%"></div>').join('') + '</div>';
  const errCard = (e, retry) => '<div class="axerr" role="alert"><b>' + esc(msgOf(e)) + '</b>' + (e.code === 'PERMISSION_DENIED' || e.status === 403 ? '' : ' <button class="b mini" data-x2="retry-' + retry + '">Retry</button>') + '</div>';
  const SL = { created: 'Created', ready: 'Ready', assigned: 'Assigned', accepted: 'Accepted', picked_up: 'Picked up', out_for_delivery: 'Out for delivery', arrived: 'Arrived', delivered: 'Delivered', partial: 'Partial', failed: 'Failed', full_return: 'Full return', cancelled: 'Cancelled' };
  const SC = { created: 'created', ready: 'ready', assigned: 'assigned', accepted: 'accepted', picked_up: 'picked', out_for_delivery: 'out', arrived: 'arrived', delivered: 'delivered', partial: 'partial', failed: 'failed', full_return: 'returned', cancelled: 'returned' };
  const sBadge = s => '<span class="badge s-' + (SC[s] || 'created') + '">' + (SL[s] || esc(s)) + '</span>';
  const OUT = ['delivered', 'partial', 'failed', 'full_return'];
  const fsBadge = o => !OUT.includes(o.status) ? '—' : '<span class="badge ' + (o.final_status === 'complete' ? 's-delivered' : o.final_status === 'incomplete' ? 's-failed' : 's-assigned') + '">' + (o.final_status === 'pending' ? 'Pending verification' : o.final_status[0].toUpperCase() + o.final_status.slice(1)) + '</span>';
  const dt = s => s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const pad = n => String(n).padStart(2, '0'), ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function dates() {            // period selector -> from/to (business timezone is applied by the server)
    const n = new Date(), t = new Date(n.getFullYear(), n.getMonth(), n.getDate()), r = S.range;
    if (r === 0) return { from: ymd(t), to: ymd(t) };
    if (r === 1) { const y = new Date(t - 864e5); return { from: ymd(y), to: ymd(y) }; }
    if (r === -1) return { from: ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: ymd(new Date(n.getFullYear(), n.getMonth(), 0)) };
    if (r === 365) return { from: ymd(new Date(n.getFullYear(), 0, 1)), to: ymd(t) };
    if (r === -2) return { from: S.cf || undefined, to: S.ct || undefined };
    if (r === 30) return { from: ymd(new Date(n.getFullYear(), n.getMonth(), 1)), to: ymd(t) };
    const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return { from: ymd(mon), to: ymd(new Date(mon.getTime() + 6 * 864e5)) };
  }
  const qs = o => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== null) p.set(k, v); }); const s = p.toString(); return s ? '?' + s : ''; };
  function adlg(title, body, label, fn, extra) {
    const d = dlg('<form method="dialog" class="f" novalidate><h3>' + title + '</h3>' + body + '<div class="err" id="axerr" role="alert"></div><div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="b" value="x">Close</button>' + (extra || '') + (label ? '<button class="b p" id="axok" value="y">' + label + '</button>' : '') + '</div></form>');
    if (label) g('axok').onclick = async e => {
      e.preventDefault(); const b = e.currentTarget; if (b.disabled) return; b.disabled = true; const t = b.textContent; b.textContent = 'Please wait…'; g('axerr').textContent = '';
      try { if ((await fn()) !== false) d.close(); } catch (err) { g('axerr').textContent = msgOf(err); } finally { b.disabled = false; b.textContent = t; }
    };
    return d;
  }
  const notConnected = k => { const m = S.role === 'owner' && typeof OWN_MSG !== 'undefined' && OWN_MSG[k]; g('view').innerHTML = '<div class="card empty"><b>' + (m && /per business|belong to each|belongs to each/.test(m) ? 'Managed per business' : 'Not connected to the backend yet') + '</b><br>' + (m || 'This module is next in the rollout. It deliberately shows no demo data.') + '</div>'; };

  // ------------------------------------------------------------------ partners (for assignment)
  async function loadPartners() {
    if (S.role === 'partner' || S.role === 'owner' || !(has('deliveries.assign') || has('deliveries.reassign') || has('deliveries.view'))) { AS.partners = []; return; }
    try { AS.partners = (await api('/delivery-partners')).data; } catch { AS.partners = []; }
  }
  const partnerOpts = cur => '<option value="">Assign…</option>' + AS.partners.map(p => {
    const ok = p.duty_on && !p.unresolved && p.id !== cur;
    return '<option value="' + p.id + '"' + (ok ? '' : ' disabled') + '>' + esc(p.name) + (!p.duty_on ? ' (off duty)' : p.unresolved ? ' (busy)' : p.queued ? ' (' + p.queued + ' queued)' : '') + '</option>';
  }).join('');

  // ------------------------------------------------------------------ dashboard
  async function dashApi() {
    const gen = AS.gen; g('view').innerHTML = skel(4);
    try {
      const s = (await api('/orders/summary' + qs(dates()))).data; if (gen !== AS.gen || S.view !== 'dash') return;
      const K = [['Total orders', s.total, ''], ['Assigned', s.assigned, 'assigned,accepted,picked_up'], ['Out for delivery', s.out_for_delivery, 'out_for_delivery,arrived'], ['Delivered', s.delivered, 'delivered'],
        ['Partial delivered', s.partial, 'partial'], ['Fully returned', s.full_return, 'full_return'], ['Cancelled', s.cancelled, 'cancelled'], ['Total collection', fmt(s.total_collection), '']];
      g('view').innerHTML = bizHead(BIZ[0]) + '<div class="kpis">' + K.map(k => '<button class="kpi" data-x2="kpi" data-st="' + k[2] + '"><small>' + k[0] + '</small><b>' + k[1] + '</b></button>').join('') + '</div>' +
        '<div class="grid"><div class="card"><h3>Needs attention</h3><div class="row"><span style="width:160px">Not yet assigned</span><b>' + s.unassigned + '</b></div><div class="row"><span style="width:160px">Awaiting verification</span><b>' + s.pending_verification + '</b></div><div class="row"><span style="width:160px">Failed deliveries</span><b>' + s.failed + '</b></div></div></div>';
      post();
    } catch (e) { if (gen === AS.gen) { g('view').innerHTML = errCard(e, 'dash'); } }
  }

  // ------------------------------------------------------------------ orders (admin / manager)
  const O = { pg: 1, limit: 12, q: '', st: '', pf: '', rows: [], meta: null, busy: false };
  let qTimer = null;
  function ordersApi() {
    if (S.filter) { O.st = S.filter; S.filter = null; O.pg = 1; }
    g('view').innerHTML = '<div class="top"><input id="axq" placeholder="Search bill, customer, phone" value="' + esc(O.q) + '" style="flex:1;min-width:160px" aria-label="Search orders">' +
      '<select id="axpf" aria-label="Delivery agent"><option value="">All agents</option>' + AS.partners.map(p => '<option value="' + p.id + '"' + (O.pf === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' +
      '<select id="axst" aria-label="Status"><option value="">All statuses</option>' + Object.entries(SL).map(([k, v]) => '<option value="' + k + '"' + (O.st === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' +
      (has('orders.create') ? '<button class="b p" data-x2="new">+ New order</button>' : '') + '</div><div id="axlist"></div>';
    if (O.st.includes(',')) q$('#axst').insertAdjacentHTML('afterbegin', '<option value="' + O.st + '" selected>Filtered</option>');
    loadOrders();
  }
  async function loadOrders() {
    const gen = AS.gen, box = g('axlist'); if (!box) return; box.innerHTML = skel(6);
    try {
      const r = await api('/orders' + qs({ ...dates(), page: O.pg, limit: O.limit, q: O.q, status: O.st, partnerId: O.pf, sort: 'created_at', dir: 'desc' }));
      if (gen !== AS.gen || !g('axlist')) return; O.rows = r.data; O.meta = r.meta; box.innerHTML = ordersTable();
    } catch (e) { if (gen === AS.gen && g('axlist')) box.innerHTML = errCard(e, 'orders'); }
  }
  function rowActions(o) {
    const b = [`<button class="b mini" data-x2="view" data-i="${o.id}">View</button>`], st = o.status;
    if (['created', 'ready'].includes(st) && has('orders.edit')) b.push(`<button class="b mini" data-x2="edit" data-i="${o.id}">Edit</button>`);
    if (st === 'created' && has('orders.edit')) b.push(`<button class="b mini p" data-x2="ready" data-i="${o.id}">Mark ready</button>`);
    if (st === 'ready' && has('deliveries.assign')) b.push(`<select class="mini" data-x2="assign" data-i="${o.id}" aria-label="Assign delivery partner">${partnerOpts()}</select>`);
    if (['assigned', 'accepted', 'picked_up'].includes(st) && has('deliveries.reassign')) b.push(`<select class="mini" data-x2="assign" data-i="${o.id}" aria-label="Reassign delivery partner">${partnerOpts(o.current_partner_id).replace('Assign…', 'Reassign…')}</select>`);
    if (st === 'failed' && has('deliveries.assign')) b.push(`<button class="b mini" data-x2="retry" data-i="${o.id}">Retry</button>`);
    if (OUT.includes(st) && o.final_status !== 'complete' && has('deliveries.verify')) b.push(`<button class="b mini p" data-x2="verify" data-i="${o.id}">Verify</button>`);
    if (['created', 'ready', 'assigned', 'accepted', 'picked_up'].includes(st) && has('orders.edit')) b.push(`<button class="b mini" data-x2="cancel" data-i="${o.id}">Cancel</button>`);
    return b.join(' ');
  }
  function ordersTable() {
    const m = O.meta; if (!O.rows.length) return '<div class="card empty">No orders match these filters. Clear the search or change the period.</div>';
    return '<div class="card wrap"><table><tr><th>Date</th><th>Bill number</th><th>Customer</th><th>Address</th><th>Bill amount</th><th>Change</th><th>Receivable</th><th>Delivery agent</th><th>Delivery status</th><th>Return</th><th>Final amount</th><th>Final status</th><th>Remarks</th><th>Action</th></tr>' +
      O.rows.map(o => `<tr><td>${new Date(o.created_at).toLocaleDateString('en-IN')}</td><td>${esc(o.invoice_number)}</td><td>${esc(o.customer_name)}</td><td>${esc(o.customer_address)}</td><td>${fmt(o.bill_amount)}</td><td>${fmt(o.change_amount)}</td><td>${fmt(o.receivable_amount)}</td><td>${esc(o.partner_name || '—')}</td><td>${sBadge(o.status)}${o.payment_mismatch ? ' ⚠' : ''}</td><td>${o.returned_amount ? fmt(o.returned_amount) : '—'}</td><td>${o.final_amount == null ? '—' : fmt(o.final_amount)}</td><td>${fsBadge(o)}</td><td>${esc([o.remarks, o.manager_remarks].filter(Boolean).join(' / '))}</td><td>${rowActions(o)}</td></tr>`).join('') +
      `</table><div class="pgn"><span>${m.total} orders · page ${m.page}/${m.totalPages || 1}</span><button class="b mini" data-x2="pg" data-d="-1" ${m.page < 2 ? 'disabled' : ''}>Prev</button><button class="b mini" data-x2="pg" data-d="1" ${m.page >= (m.totalPages || 1) ? 'disabled' : ''}>Next</button></div></div>`;
  }
  const row = id => O.rows.find(o => o.id === id);
  async function mutate(label, fn) { try { await fn(); toast(label); await Promise.all([loadOrders(), loadPartners()]); } catch (e) { toast(msgOf(e)); loadOrders(); } }

  function orderForm(o) {
    const e = !!o;
    return '<label>Bill number<input id="axbn" value="' + esc(e ? o.invoice_number : '') + '" ' + (e ? 'disabled' : '') + ' placeholder="Leave blank to auto-generate"></label><label>Customer name<input id="axcn" value="' + esc(e ? o.customer_name : '') + '"></label>' +
      '<label>Customer mobile<input id="axmo" inputmode="numeric" maxlength="15" value="' + esc(e ? o.customer_mobile : '') + '"></label><label>Customer address<input id="axad" value="' + esc(e ? o.customer_address : '') + '"></label>' +
      '<label>Bill amount (₹)<input id="axba" type="number" min="0" step="0.01" value="' + (e ? o.bill_amount : '') + '" oninput="window.axCalc()"></label><label>Change to give (₹)<input id="axch" type="number" min="0" step="0.01" value="' + (e ? o.change_amount : 0) + '" oninput="window.axCalc()"></label>' +
      '<div class="sum" id="axrc"></div><label>Payment mode<select id="axpm">' + ['cod', 'prepaid', 'upi', 'card', 'other'].map(x => '<option value="' + x + '"' + (e && o.payment_mode === x ? ' selected' : '') + '>' + x.toUpperCase() + '</option>').join('') + '</select></label>' +
      (!e && has('deliveries.assign') ? '<label>Assign delivery partner (optional)<select id="axap"><option value="">Unassigned</option>' + AS.partners.map(p => '<option value="' + p.id + '"' + (p.duty_on && !p.unresolved ? '' : ' disabled') + '>' + esc(p.name) + (!p.duty_on ? ' (off duty)' : p.unresolved ? ' (busy)' : '') + '</option>').join('') + '</select></label>' : '');
  }
  window.axCalc = () => { const b = +g('axba').value || 0, c = +g('axch').value || 0; g('axrc').innerHTML = 'Bill ' + fmt(b) + ' + Change ' + fmt(c) + ' = <b>Receivable ' + fmt(b + c) + '</b>'; };
  function readForm(edit) {
    const v = id => g(id).value.trim(), b = +g('axba').value, c = +g('axch').value, errs = [];
    if (!v('axcn')) errs.push('Customer name is required.'); if (!/^\+?[0-9]{10,15}$/.test(v('axmo'))) errs.push('Enter a valid mobile number (10-15 digits).'); if (v('axad').length < 3) errs.push('Customer address is required.');
    if (!(b > 0)) errs.push('Bill amount must be above ₹0.'); if (!(c >= 0)) errs.push('Change cannot be negative.');
    if (errs.length) throw new ApiError(0, 'VALIDATION_ERROR', errs.join(' '));
    const body = { customerName: v('axcn'), customerMobile: v('axmo'), customerAddress: v('axad'), billAmount: b, changeAmount: c, paymentMode: g('axpm').value };
    if (!edit) { if (v('axbn')) body.invoiceNumber = v('axbn'); if (g('axap') && g('axap').value) body.partnerId = g('axap').value; }
    return body;
  }
  async function viewOrder(id) {
    const d = adlg('Order details', '<div id="axdet">' + skel(5) + '</div>', null);
    try {
      const r = (await api('/orders/' + id)).data, o = r.order;
      g('axdet').innerHTML = `<div class="sum"><div>Bill number<span>${esc(o.invoice_number)}</span></div><div>Status<span>${SL[o.status]}</span></div><div>Bill / Change / Receivable<span>${fmt(o.bill_amount)} / ${fmt(o.change_amount)} / ${fmt(o.receivable_amount)}</span></div><div>Returned / Final<span>${fmt(o.returned_amount)} / ${o.final_amount == null ? '—' : fmt(o.final_amount)}</span></div></div>
      <p><b>${esc(o.customer_name)}</b> · ${esc(o.customer_mobile)}<br>${esc(o.customer_address)}</p>
      <h4>Timeline</h4><ul class="axtl">${r.events.map(e => `<li>${dt(e.created_at)} — <b>${esc(e.previous_status || 'start')} → ${esc(e.new_status)}</b> by ${esc(e.changed_by_name || e.user_role || 'system')}${e.notes ? ' · ' + esc(e.notes) : ''}</li>`).join('')}</ul>
      <h4>Assignments</h4><ul class="axtl">${r.assignments.map(a => `<li>${dt(a.assigned_at)} — ${esc(a.partner_name)}${a.previous_partner_name ? ' (from ' + esc(a.previous_partner_name) + ')' : ''}${a.end_reason ? ' · ' + esc(a.end_reason) : ''}</li>`).join('') || '<li>None</li>'}</ul>
      ${r.returns.length ? '<h4>Returns</h4><ul class="axtl">' + r.returns.map(x => `<li>${esc(x.return_type)} · ${fmt(x.returned_amount)} · ${esc(x.reason)} · ${esc(x.status)}</li>`).join('') + '</ul>' : ''}`;
    } catch (e) { g('axdet').innerHTML = errCard(e, 'noop'); }
    return d;
  }
  function verifyDlg(o) {
    adlg('Verify · ' + esc(o.invoice_number), `<div class="sum"><div>Receivable<span>${fmt(o.receivable_amount)}</span></div><div>Collected<span>${fmt(o.collected_amount)}</span></div><div>Returned<span>${fmt(o.returned_amount)}</span></div></div><label>Final amount (₹)<input id="axfa" type="number" min="0" step="0.01" value="${o.final_amount == null ? o.collected_amount : o.final_amount}"></label><label>Manager remarks<input id="axrm"></label>`, 'Mark complete',
      () => verifyCall(o, 'complete'), '<button class="b" id="axinc" type="button">Mark incomplete</button>');
    g('axinc').onclick = async () => { try { await verifyCall(o, 'incomplete'); q$('#dlg').close(); } catch (e) { g('axerr').textContent = msgOf(e); } };
  }
  async function verifyCall(o, result) {
    const f = g('axfa').value; if (f === '' || +f < 0) throw new ApiError(0, 'VALIDATION_ERROR', 'Enter a final amount (0 or more).');
    await api('/orders/' + o.id + '/verify', { method: 'POST', body: { result, finalAmount: +f, remarks: g('axrm').value.trim() || undefined } });
    toast('Order marked ' + result); await loadOrders();
  }

  // ------------------------------------------------------------------ partner app
  const P = { active: [], history: [], hmeta: null, hpg: 1, busy: false };
  async function loadMine(kind) {
    const gen = AS.gen;
    if (kind === 'active' || kind === 'both') P.active = (await api('/deliveries?scope=active&limit=100')).data;
    if (kind === 'history' || kind === 'both') { const r = await api('/deliveries?scope=history&limit=12&page=' + P.hpg); P.history = r.data; P.hmeta = r.meta; }
    return gen === AS.gen;
  }
  const pHeadApi = () => bizHead(BIZ[0]) + '<div class="card row" style="justify-content:space-between"><div><b>' + esc(AS.user.name) + '</b><br><span class="badge ' + (AS.user.dutyOn ? 's-delivered' : 's-returned') + '">' + (AS.user.dutyOn ? 'ONLINE' : 'OFFLINE') + '</span></div><div><button class="b" data-x2="refresh" aria-label="Refresh">↻</button> <button class="b ' + (AS.user.dutyOn ? '' : 'p') + '" data-x2="duty">Duty ' + (AS.user.dutyOn ? 'OFF' : 'ON') + '</button></div></div>';
  function dCard(o, i) {
    const pend = OUT.includes(o.status), st = o.status; let a = '';
    if (pend) a = '<span class="badge s-assigned">' + (o.final_status === 'incomplete' ? 'Marked incomplete by manager' : 'Pending manager verification') + '</span>';
    else if (st === 'assigned') a = `<button class="b p" data-x2="act" data-a="accept" data-i="${o.id}">Accept</button> <button class="b" data-x2="act" data-a="reject" data-i="${o.id}">Reject / issue</button>`;
    else if (st === 'accepted') a = `<button class="b p" data-x2="act" data-a="pickup" data-i="${o.id}">Picked up</button>`;
    else if (st === 'picked_up') a = `<button class="b p" data-x2="act" data-a="start" data-i="${o.id}">Out for delivery</button>`;
    else if (st === 'out_for_delivery' || st === 'arrived') a = (st === 'out_for_delivery' ? `<button class="b" data-x2="act" data-a="arrive" data-i="${o.id}">Arrived</button> ` : '') + ['deliver:Delivered', 'partial:Partial', 'full_return:Full return', 'fail:Failed'].map(x => { const [k, l] = x.split(':'); return `<button class="b mini" data-x2="out" data-k="${k}" data-i="${o.id}">${l}</button>`; }).join(' ');
    return `<div class="card dc"><div class="row" style="justify-content:space-between"><b>${i ? '#' + i + ' · ' : ''}Bill ${esc(o.invoice_number)}</b>${sBadge(st)}</div><b>${esc(o.customer_name)}</b><div class="mut">${esc(o.customer_address)}</div><div class="row"><a class="b" href="tel:${esc(o.customer_mobile)}">📞 Call</a><a class="b" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.customer_address)}">🧭 Navigate</a></div><div class="mut">Receivable</div><div class="big">${fmt(o.receivable_amount)}</div><div class="mut">Bill ${fmt(o.bill_amount)} + change ${fmt(o.change_amount)} · ${esc(o.payment_mode.toUpperCase())}</div><div style="margin-top:8px">${a}</div></div>`;
  }
  const rank = o => ({ out_for_delivery: 0, arrived: 0, picked_up: 1, accepted: 1, assigned: 2 }[o.status] ?? 3);
  async function partnerView(kind) {
    const gen = AS.gen; g('view').innerHTML = pHeadApi() + skel(3);
    try {
      if (!(await loadMine(kind === 'hist' ? 'history' : 'active')) || S.view !== kind) return;
      const A = P.active.slice().sort((a, b) => rank(a) - rank(b));
      let body;
      if (kind === 'hist') body = '<div class="card">' + (P.history.length ? '<div class="wrap"><table><tr><th>Bill</th><th>Customer</th><th>Amount</th><th>Return</th><th>Final</th><th>Status</th><th>Completed</th></tr>' + P.history.map(o => `<tr><td>${esc(o.invoice_number)}</td><td>${esc(o.customer_name)}</td><td>${fmt(o.receivable_amount)}</td><td>${fmt(o.returned_amount)}</td><td>${o.final_amount == null ? '—' : fmt(o.final_amount)}</td><td>${sBadge(o.status)}</td><td>${dt(o.completed_at)}</td></tr>`).join('') + `</table></div><div class="pgn"><span>page ${P.hmeta.page}/${P.hmeta.totalPages || 1}</span><button class="b mini" data-x2="hpg" data-d="-1" ${P.hmeta.page < 2 ? 'disabled' : ''}>Prev</button><button class="b mini" data-x2="hpg" data-d="1" ${P.hmeta.page >= (P.hmeta.totalPages || 1) ? 'disabled' : ''}>Next</button></div>` : '<div class="empty">No completed deliveries yet.</div>') + '</div>';
      else if (kind === 'cur') body = A.filter(o => ['out_for_delivery', 'arrived', ...OUT].includes(o.status)).map(o => dCard(o)).join('') || '<div class="card empty">No current delivery. Start one from Assigned orders.</div>';
      else {
        const k = s => A.filter(o => o.status === s).length;
        body = (kind === 'home' ? '<div class="kpis" style="grid-template-columns:repeat(3,1fr)">' + [['Assigned', k('assigned')], ['Accepted', k('accepted') + k('picked_up')], ['Out for delivery', k('out_for_delivery') + k('arrived')], ['Pending verification', A.filter(o => OUT.includes(o.status)).length]].map(x => `<div class="kpi"><small>${x[0]}</small><b style="font-size:20px">${x[1]}</b></div>`).join('') + '</div><h3>Assigned orders</h3>' : '') +
          (A.map((o, i) => dCard(o, i + 1)).join('') || '<div class="card empty">No active orders.' + (AS.user.dutyOn ? '' : ' Duty is OFF, so no new orders will be assigned.') + '</div>');
      }
      if (gen === AS.gen) { g('view').innerHTML = pHeadApi() + body; post(); if (kind === 'home') partnerCash(); }
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = pHeadApi() + errCard(e, 'p' + kind); }
  }
  const uploadFile = async (file, kind, orderId) => { const f = new FormData(); f.append('kind', kind); f.append('orderId', orderId); f.append('file', file); return (await api('/files', { method: 'POST', form: f })).data.id; };
  const getPos = () => new Promise(r => { if (!navigator.geolocation) return r({}); const t = setTimeout(() => r({}), 3000); navigator.geolocation.getCurrentPosition(p => { clearTimeout(t); r({ latitude: p.coords.latitude, longitude: p.coords.longitude }); }, () => { clearTimeout(t); r({}); }, { timeout: 2500 }); });
  window.axOut = () => {
    const k = window.axK, o = window.axO; if (!g('axsm')) return;
    const ret = k === 'partial' ? (+g('axra').value || 0) : 0, due = Math.max(0, o.receivable_amount - ret), pg = g('axpg'), gave = pg && pg.value !== '' ? +pg.value : due;
    g('axsm').innerHTML = k === 'deliver' || k === 'partial' ? `<div>Receivable<span>${fmt(o.receivable_amount)}</span></div>` + (k === 'partial' ? `<div>Return<span>${fmt(ret)}</span></div>` : '') + `<div>Collect<span>${fmt(due)}</span></div><div>Customer gave<span>${fmt(gave)}</span></div>` + (gave >= due ? `<div>Change to customer<span>${fmt(gave - due)}</span></div>` : `<div style="color:var(--bad)">Short by<span>${fmt(due - gave)}</span></div>`) : '';
  };
  function outcomeDlg(o, k) {
    window.axK = k; window.axO = o; const ids = {}, pay = k === 'deliver' || k === 'partial';
    const R = { partial: ['Customer Rejected', 'Damaged', 'Wrong Item', 'Unavailable', 'Quality Issue', 'Customer Request', 'Other'], full_return: ['Customer Rejected', 'Damaged', 'Wrong Item', 'Customer Request', 'Other'], fail: ['Customer unavailable', 'Wrong address', 'Phone unreachable', 'Payment issue', 'Other'] }[k];
    const file = (id, l, req) => `<label>${l}${req ? ' (required)' : ' (optional)'}<input type="file" accept="image/*" id="${id}"></label>`;
    adlg({ deliver: 'Delivered', partial: 'Partial delivery', full_return: 'Full return', fail: 'Failed delivery' }[k] + ' · ' + esc(o.invoice_number),
      (R ? `<label>Reason<select id="axrs">${R.map(x => `<option>${x}</option>`).join('')}</select></label>` : '') +
      (k === 'partial' ? `<label>Return value (₹)<input id="axra" type="number" min="1" step="0.01" oninput="window.axOut()"></label>` : '') +
      (pay ? `<label>Payment mode<select id="axpm2">${['cod', 'upi', 'card', 'other'].map(x => `<option value="${x}" ${o.payment_mode === x ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}</select></label><label>Customer paid (₹, blank = exact)<input id="axpg" type="number" min="0" step="0.01" oninput="window.axOut()"></label>` : '') +
      '<div class="sum" id="axsm"></div>' + (pay ? file('axf1', 'Payment proof photo', true) : '') + (k === 'deliver' ? file('axf2', 'Delivery photo', false) + '<label>Customer OTP (if the business uses OTP)<input id="axotp" inputmode="numeric" maxlength="6"></label>' : '') +
      (k === 'partial' || k === 'full_return' ? file('axf3', 'Return item photo', true) : '') + (k !== 'deliver' ? '<label>Notes<input id="axnt"></label>' : '') + '<label id="axmmw" hidden><input type="checkbox" id="axmm"> Confirm payment amount mismatch</label>', 'Confirm',
      async () => {
        const body = {}, F = id => g(id) && g(id).files[0];
        if (g('axrs')) body.reason = g('axrs').value; if (g('axnt') && g('axnt').value.trim()) body.notes = g('axnt').value.trim();
        if (k === 'partial') { body.returnedAmount = +g('axra').value; if (!(body.returnedAmount > 0)) throw new ApiError(0, 'VALIDATION_ERROR', 'Enter the return value (above ₹0).'); }
        if (pay) { body.paymentMode = g('axpm2').value; if (g('axpg').value !== '') { body.customerPaid = +g('axpg').value; if (body.customerPaid < 0) throw new ApiError(0, 'VALIDATION_ERROR', 'Customer paid cannot be negative.'); }
          if (!F('axf1') && !ids.pay) throw new ApiError(0, 'PROOF_REQUIRED', 'Payment proof photo is required.'); }
        if ((k === 'partial' || k === 'full_return') && !F('axf3') && !ids.ret) throw new ApiError(0, 'PROOF_REQUIRED', 'Return item photo is required.');
        if (F('axf1') && !ids.pay) ids.pay = await uploadFile(F('axf1'), 'payment_proof', o.id);
        if (F('axf2') && !ids.photo) ids.photo = await uploadFile(F('axf2'), 'photo', o.id);
        if (F('axf3') && !ids.ret) ids.ret = await uploadFile(F('axf3'), 'return_photo', o.id);
        if (ids.pay) body.paymentProofFileId = ids.pay; if (ids.photo) body.photoFileId = ids.photo; if (ids.ret) body.returnPhotoFileId = ids.ret;
        if (g('axotp') && g('axotp').value) body.otp = g('axotp').value; if (g('axmm') && g('axmm').checked) body.confirmMismatch = true;
        Object.assign(body, await getPos());
        try { await api('/deliveries/' + o.id + '/' + k, { method: 'POST', body }); }
        catch (e) { if (e.code === 'PAYMENT_MISMATCH') g('axmmw').hidden = false; throw e; }
        toast('Delivery submitted for manager verification'); partnerView(S.view);
      });
    window.axOut();
  }

  // ------------------------------------------------------------------ account
  function accApi() {
    const u = AS.user;
    g('view').innerHTML = '<div class="grid"><div class="card"><h3>Profile</h3><div class="row"><span>Name</span>' + esc(u.name) + '</div><div class="row"><span>Email / login</span>' + esc(u.email) + '</div><div class="row"><span>Mobile</span>' + esc(u.mobile || '—') + '</div><div class="row"><span>Role</span>' + ROLE[S.role] + '</div>' + (u.business ? '<div class="row"><span>Business</span>' + esc(u.business.name) + '</div>' : '') + '<div class="row"><span>Last sign-in</span>' + dt(u.lastLoginAt) + '</div><p><button class="b" data-lo="1">Logout</button></p></div>' +
      '<div class="card"><h3>Change password</h3><div class="f"><label>Current password<input id="axp0" type="password" autocomplete="current-password"></label><label>New password (8+ chars, a capital letter and a number)<input id="axp1" type="password" autocomplete="new-password"></label><label>Confirm new password<input id="axp2" type="password" autocomplete="new-password"></label><div class="err" id="axpe" role="alert"></div><button class="b p" data-x2="pw">Update password</button></div></div></div>';
  }

  // ------------------------------------------------------------------ returns (admin / manager)
  const RF = ['created', 'assigned', 'picked_up', 'received', 'verified', 'closed'], RL = { created: 'Return created', assigned: 'Return assigned', picked_up: 'Return picked up', received: 'Return received', verified: 'Return verified', closed: 'Return closed' };
  const R = { pg: 1, limit: 12, type: '', st: '', rows: [], meta: null, totals: null };
  async function returnsApi() {
    if (!has('returns.view')) { g('view').innerHTML = '<div class="card empty"><b>Unauthorized</b><br>Your role does not have permission to open this page.</div>'; return; }
    const gen = AS.gen;
    g('view').innerHTML = '<div id="axrk">' + skel(2) + '</div><div class="top"><select id="axrt" aria-label="Return type"><option value="">All returns</option><option value="full"' + (R.type === 'full' ? ' selected' : '') + '>Full returns</option><option value="partial"' + (R.type === 'partial' ? ' selected' : '') + '>Partial returns</option></select>' +
      '<select id="axrs" aria-label="Return status"><option value="">Any status</option>' + RF.map(x => '<option value="' + x + '"' + (R.st === x ? ' selected' : '') + '>' + RL[x] + '</option>').join('') + '</select><span class="mut">Period follows the selector above</span></div><div id="axrl">' + skel(5) + '</div>';
    try {
      const r = await api('/returns' + qs({ ...dates(), page: R.pg, limit: R.limit, type: R.type, status: R.st }));
      if (gen !== AS.gen || S.view !== 'returns' || !g('axrl')) return; R.rows = r.data.returns; R.meta = r.meta; R.totals = r.data.totals;
      const t = R.totals;
      g('axrk').innerHTML = '<div class="kpis">' + [['Total returns', t.count], ['Return value', fmt(t.value)], ['Full returns', t.full_count], ['Partial returns', t.partial_count]].map(k => '<div class="kpi"><small>' + k[0] + '</small><b style="font-size:22px">' + k[1] + '</b></div>').join('') + '</div>';
      g('axrl').innerHTML = !R.rows.length ? '<div class="card empty">No returns match these filters.</div>' :
        '<div class="card wrap"><table><tr><th>Return</th><th>Order</th><th>Customer</th><th>Type</th><th>Original</th><th>Returned</th><th>Delivered</th><th>Reason</th><th>Status</th><th>Created</th><th></th></tr>' +
        R.rows.map(x => { const nx = RF[RF.indexOf(x.status) + 1]; return '<tr><td>R-' + esc(x.id.slice(0, 6).toUpperCase()) + '</td><td>' + esc(x.invoice_number) + '</td><td>' + esc(x.customer_name) + '</td><td>' + (x.return_type === 'full' ? 'Full' : 'Partial') + '</td><td>' + fmt(x.original_amount) + '</td><td>' + fmt(x.returned_amount) + '</td><td>' + fmt(x.delivered_amount) + '</td><td>' + esc(x.reason) + '</td><td>' + esc(RL[x.status]) + '</td><td>' + dt(x.created_at) + '</td><td>' + (nx && has('returns.manage') ? '<button class="b mini" data-x2="radv" data-i="' + x.id + '" data-n="' + nx + '">→ ' + RL[nx].replace('Return ', '') + '</button>' : '') + '</td></tr>'; }).join('') +
        '</table><div class="pgn"><span>' + R.meta.total + ' returns · page ' + R.meta.page + '/' + (R.meta.totalPages || 1) + '</span><button class="b mini" data-x2="rpg" data-d="-1" ' + (R.meta.page < 2 ? 'disabled' : '') + '>Prev</button><button class="b mini" data-x2="rpg" data-d="1" ' + (R.meta.page >= (R.meta.totalPages || 1) ? 'disabled' : '') + '>Next</button></div></div>';
      post();
    } catch (e) { if (gen === AS.gen && g('axrl')) { g('axrk').innerHTML = ''; g('axrl').innerHTML = errCard(e, 'returns'); } }
  }
  document.addEventListener('change', e => { const t = e.target; if (t.id === 'axrt') { R.type = t.value; R.pg = 1; returnsApi(); } else if (t.id === 'axrs') { R.st = t.value; R.pg = 1; returnsApi(); } });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-x2]'); if (!t) return; const x = t.dataset.x2;
    if (x === 'retry-returns') returnsApi();
    else if (x === 'rpg') { R.pg = Math.max(1, R.pg + +t.dataset.d); returnsApi(); }
    else if (x === 'radv') { t.disabled = true; try { await api('/returns/' + t.dataset.i + '/status', { method: 'PATCH', body: { status: t.dataset.n } }); toast('Return moved to ' + RL[t.dataset.n]); } catch (er) { toast(msgOf(er)); } returnsApi(); }
  });

  // ------------------------------------------------------------------ COD (admin / manager) + cash card on the partner home screen
  const C = { pg: 1, limit: 10, st: '', pf: '', rows: [], meta: null };
  const CSTAT = { expected: 'Expected', collected: 'Collected', submitted: 'Submitted', settled: 'Settled', void: 'Void' };
  async function codApi() {
    if (!has('cod.view')) { g('view').innerHTML = '<div class="card empty"><b>Unauthorized</b><br>Your role does not have permission to open this page.</div>'; return; }
    if (!AS.partners.length) await loadPartners();      // the partner filter needs the list even on a fresh page load
    const gen = AS.gen;
    g('view').innerHTML = '<div id="axck">' + skel(2) + '</div><div id="axcp"></div><div class="top"><select id="axcst" aria-label="COD status"><option value="">Any status</option>' + Object.entries(CSTAT).map(([k, v]) => '<option value="' + k + '"' + (C.st === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' +
      '<select id="axcpf" aria-label="Delivery partner"><option value="">All partners</option>' + AS.partners.map(p => '<option value="' + p.id + '"' + (C.pf === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select><span class="mut">All-time cash position (not limited by the period selector)</span></div><div id="axcl">' + skel(4) + '</div><div id="axcs"></div>';
    try {
      const sm = has('cod.view') ? (await api('/cod/summary')).data : null;
      const [tx, st] = await Promise.all([api('/cod/transactions' + qs({ page: C.pg, limit: C.limit, status: C.st, partnerId: C.pf })), api('/cod/settlements?limit=8')]);
      if (gen !== AS.gen || S.view !== 'cod' || !g('axcl')) return; C.rows = tx.data; C.meta = tx.meta; const t = sm.totals;
      g('axck').innerHTML = '<div class="kpis">' + [['Expected', t.expected], ['Collected', t.collected], ['Change given', t.changeGiven], ['Pending with partners', t.pending], ['Submitted', t.submitted], ['Settled', t.settled]].map(k => '<div class="kpi"><small>' + k[0] + '</small><b style="font-size:22px">' + fmt(k[1]) + '</b></div>').join('') + '</div>';
      g('axcp').innerHTML = '<div class="card wrap"><h3>Cash held by delivery partners</h3><table><tr><th>Partner</th><th>Expected</th><th>Collected</th><th>Change given</th><th>Settled</th><th>Pending</th><th>Submitted</th><th></th></tr>' + sm.partners.map(p => '<tr><td>' + esc(p.partner_name) + '</td><td>' + fmt(p.expected) + '</td><td>' + fmt(p.collected) + '</td><td>' + fmt(p.change_given) + '</td><td>' + fmt(p.settled) + '</td><td><b>' + fmt(p.pending) + '</b></td><td>' + fmt(p.submitted) + '</td><td>' + (has('cod.settle') && p.pending > 0 ? '<button class="b mini p" data-x2="settle" data-pid="' + p.partner_id + '" data-pn="' + esc(p.partner_name) + '" data-out="' + p.pending + '">Settle</button>' : '') + '</td></tr>').join('') + '</table></div>';
      g('axcl').innerHTML = !C.rows.length ? '<div class="card empty">No COD transactions match these filters.</div>' :
        '<div class="card wrap"><h3>Transactions</h3><table><tr><th>Order</th><th>Partner</th><th>Expected</th><th>Collected</th><th>Change given</th><th>Settled</th><th>Status</th><th>Date</th></tr>' + C.rows.map(x => '<tr><td>' + esc(x.invoice_number) + '</td><td>' + esc(x.partner_name || '—') + '</td><td>' + fmt(x.expected_amount) + '</td><td>' + fmt(x.collected_amount) + '</td><td>' + fmt(x.change_given) + '</td><td>' + fmt(x.settled_amount) + '</td><td>' + (CSTAT[x.status] || esc(x.status)) + '</td><td>' + dt(x.created_at) + '</td></tr>').join('') +
        '</table><div class="pgn"><span>' + C.meta.total + ' transactions · page ' + C.meta.page + '/' + (C.meta.totalPages || 1) + '</span><button class="b mini" data-x2="cpg" data-d="-1" ' + (C.meta.page < 2 ? 'disabled' : '') + '>Prev</button><button class="b mini" data-x2="cpg" data-d="1" ' + (C.meta.page >= (C.meta.totalPages || 1) ? 'disabled' : '') + '>Next</button></div></div>';
      g('axcs').innerHTML = st.data.length ? '<div class="card wrap"><h3>Settlement history</h3><table><tr><th>Date</th><th>Partner</th><th>Amount</th><th>Reference</th><th>Settled by</th></tr>' + st.data.map(x => '<tr><td>' + dt(x.settled_at) + '</td><td>' + esc(x.partner_name) + '</td><td>' + fmt(x.amount) + '</td><td>' + esc(x.reference_no || '—') + '</td><td>' + esc(x.settled_by_name || '—') + '</td></tr>').join('') + '</table></div>' : '';
      post();
    } catch (e) { if (gen === AS.gen && g('axcl')) { g('axck').innerHTML = ''; g('axcl').innerHTML = errCard(e, 'cod'); } }
  }
  function settleDlg(pid, name, out) {
    adlg('Settle cash · ' + esc(name), '<div class="sum"><div>Outstanding<span>' + fmt(out) + '</span></div></div><label>Amount received (₹)<input id="axcsa" type="number" min="0.01" step="0.01" value="' + out + '"></label><label>Reference number<input id="axcsr" maxlength="80"></label><label>Notes<input id="axcsn" maxlength="300"></label>', 'Record settlement', async () => {
      const a = +g('axcsa').value; if (!(a > 0)) throw new ApiError(0, 'VALIDATION_ERROR', 'Enter an amount above ₹0.');
      await api('/cod/settlements', { method: 'POST', body: { partnerId: pid, amount: a, referenceNo: g('axcsr').value.trim() || undefined, notes: g('axcsn').value.trim() || undefined } });
      toast('Settlement recorded'); codApi();
    });
  }
  async function partnerCash() {                       // appended to the partner Home screen: own cash only (the server scopes it to the caller)
    const gen = AS.gen; if (!g('view') || S.view !== 'home') return;
    try {
      const r = (await api('/cod/summary')).data[0]; if (gen !== AS.gen || S.view !== 'home' || !r) return;
      const unsub = Math.max(0, r.pending - r.submitted);
      g('view').insertAdjacentHTML('beforeend', '<div class="card" id="axcash"><h3>My cash (COD)</h3><div class="row"><span style="width:180px">Collected</span><b>' + fmt(r.collected) + '</b></div><div class="row"><span style="width:180px">To hand over</span><b>' + fmt(r.pending) + '</b></div><div class="row"><span style="width:180px">Submitted, awaiting settlement</span><b>' + fmt(r.submitted) + '</b></div><div class="row"><span style="width:180px">Settled</span><b>' + fmt(r.settled) + '</b></div>' + (unsub > 0 ? '<button class="b p" data-x2="csubmit">Submit ' + fmt(unsub) + ' for settlement</button>' : '') + '</div>');
    } catch { /* the cash card is optional; the delivery list above already rendered */ }
  }
  const _navItems = window.navItems;
  window.navItems = function () {
    const n = _navItems();
    if ((S.role === 'admin' || S.role === 'manager') && has('cod.view') && !n.some(x => x[0] === 'cod')) { const i = n.findIndex(x => x[0] === 'returns'); n.splice(i < 0 ? n.length : i + 1, 0, ['cod', 'COD', 'cod']); }
    return n;
  };
  document.addEventListener('change', e => { const t = e.target; if (t.id === 'axcst') { C.st = t.value; C.pg = 1; codApi(); } else if (t.id === 'axcpf') { C.pf = t.value; C.pg = 1; codApi(); } });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-x2]'); if (!t) return; const x = t.dataset.x2;
    if (x === 'cpg') { C.pg = Math.max(1, C.pg + +t.dataset.d); codApi(); }
    else if (x === 'settle') settleDlg(t.dataset.pid, t.dataset.pn, +t.dataset.out);
    else if (x === 'csubmit') { t.disabled = true; try { const r = await api('/cod/submit', { method: 'POST' }); toast(r.message || 'Cash submitted'); } catch (er) { toast(msgOf(er)); } partnerView('home'); }
  });
  // the login screen's demo-credentials hint must not appear when real accounts are in use
  document.querySelectorAll('#login small').forEach(el => { if (/Demo account/i.test(el.textContent)) el.textContent = 'Sign in with your DMS account.'; });

  // ------------------------------------------------------------------ reports (admin / manager): rows, filters, scope and exports all come from the server
  const RPL = { orders: 'Orders', deliveries: 'Deliveries', failed: 'Failed deliveries', returns: 'Returns', partial: 'Partial deliveries', cod: 'COD', partner_performance: 'Delivery partner performance', manager_performance: 'Manager performance', revenue: 'Revenue' };
  const SCOPE = { same_day: 'same day only', weekly: 'the current week', monthly: 'the current month', yearly: 'the current year' };
  const RP = { type: 'orders', st: '', pf: '', mf: '', pg: 1, limit: 15, mgrs: null };
  const rpQuery = extra => qs({ ...dates(), status: RP.st, partnerId: RP.pf, managerId: RP.mf, ...extra });
  const cellf = v => v == null ? '' : typeof v === 'number' ? String(v) : /^\d{4}-\d\d-\d\dT/.test(v) ? dt(v) : esc(v);
  async function reportsApi() {
    if (!has('reports.view')) { g('view').innerHTML = '<div class="card empty"><b>Unauthorized</b><br>Your role does not have permission to open this page.</div>'; return; }
    const gen = AS.gen;
    if (!AS.partners.length) await loadPartners();
    if (RP.mgrs === null) { RP.mgrs = []; if (has('users.view')) { try { RP.mgrs = (await api('/users?role=manager&limit=100')).data; } catch { /* filter is optional */ } } }
    g('view').innerHTML = '<div class="top"><select id="axrpt" aria-label="Report">' + Object.entries(RPL).map(([k, v]) => '<option value="' + k + '"' + (RP.type === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' +
      '<select id="axrps" aria-label="Order status"><option value="">Any status</option>' + Object.entries(SL).map(([k, v]) => '<option value="' + k + '"' + (RP.st === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' +
      '<select id="axrpp" aria-label="Delivery partner"><option value="">All partners</option>' + AS.partners.map(p => '<option value="' + p.id + '"' + (RP.pf === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' +
      (RP.mgrs.length ? '<select id="axrpm" aria-label="Manager"><option value="">All managers</option>' + RP.mgrs.map(m => '<option value="' + m.id + '"' + (RP.mf === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select>' : '') +
      (has('reports.export') ? '<button class="b" data-x2="rexp" data-f="csv">Export CSV</button><button class="b" data-x2="rexp" data-f="excel">Export Excel</button>' : '') + '<button class="b" onclick="print()">Print</button></div><div id="axrpc">' + skel(6) + '</div>';
    try {
      const r = await api('/reports/' + RP.type + rpQuery({ page: RP.pg, limit: RP.limit })); if (gen !== AS.gen || S.view !== 'reports' || !g('axrpc')) return;
      const d = r.data, m = r.meta, note = S.role === 'manager' && d.range.scope && d.range.scope !== 'complete' ? '<p class="mut" id="axrpn">Your Business Admin limits your reports to ' + SCOPE[d.range.scope] + '.</p>' : '';
      g('axrpc').innerHTML = note + (!d.rows.length ? '<div class="card empty">No rows for this report, period and filters.</div>' :
        '<div class="card wrap"><table><tr>' + d.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>' + d.rows.map(row => '<tr>' + row.map(c => '<td>' + cellf(c) + '</td>').join('') + '</tr>').join('') +
        '</table><div class="pgn"><span>' + m.total + ' rows · page ' + m.page + '/' + (m.totalPages || 1) + ' · ' + esc(d.range.timezone) + '</span><button class="b mini" data-x2="rppg" data-d="-1" ' + (m.page < 2 ? 'disabled' : '') + '>Prev</button><button class="b mini" data-x2="rppg" data-d="1" ' + (m.page >= (m.totalPages || 1) ? 'disabled' : '') + '>Next</button></div></div>');
      post();
    } catch (e) { if (gen === AS.gen && g('axrpc')) g('axrpc').innerHTML = errCard(e, 'reports'); }
  }
  async function authBlob(path) {
    const go = () => fetch(API + path, { headers: { Authorization: 'Bearer ' + T.at } });
    let r; try { r = await go(); if (r.status === 401 && await refresh()) r = await go(); } catch { throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.'); }
    if (!r.ok) { let j = null; try { j = await r.json(); } catch { /* not JSON */ } throw new ApiError(r.status, j?.error?.code || 'HTTP_' + r.status, j?.error?.message || 'Export failed'); }
    return r.blob();
  }
  async function exportReport(fmt) {                    // the server builds the file (and re-checks reports.export + the manager scope)
    const blob = await authBlob('/reports/' + RP.type + rpQuery({ format: fmt }));
    if (window.URL && URL.createObjectURL) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = RP.type + (fmt === 'csv' ? '.csv' : '.xls'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
    return blob;
  }
  document.addEventListener('change', e => {
    const t = e.target, m = { axrpt: 'type', axrps: 'st', axrpp: 'pf', axrpm: 'mf' }[t.id]; if (!m) return; RP[m] = t.value; RP.pg = 1; reportsApi();
  });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-x2]'); if (!t) return; const x = t.dataset.x2;
    if (x === 'rppg') { RP.pg = Math.max(1, RP.pg + +t.dataset.d); reportsApi(); }
    else if (x === 'rexp') { t.disabled = true; try { await exportReport(t.dataset.f); toast('Report exported'); } catch (er) { toast(msgOf(er)); } t.disabled = false; }
  });
  const tabCss = document.createElement('style'); tabCss.textContent = '#view>.tabs{display:none}'; document.head.appendChild(tabCss);   // the "Raw data" tab is not connected yet

  // ------------------------------------------------------------------ platform owner (SaaS operator): businesses, onboarding, plans, subscriptions, staff, reports, admin rights
  const OW = { list: null, sel: '', pg: 1, q: '', st: '', staff: [], role: '', perm: { admin: '', cat: null, have: new Set(), loaded: false }, reps: { q: '', biz: '', st: '' } };
  const bstat = st => '<span class="badge ' + (st === 'active' ? 's-delivered' : st === 'inactive' ? 's-returned' : 's-failed') + '">' + esc(st) + '</span>';
  const unauth = () => { g('view').innerHTML = '<div class="card empty"><b>Unauthorized</b><br>Your role does not have permission to open this page.</div>'; };
  async function ownerBizList(force) { if (!OW.list || force) OW.list = (await api('/owner/businesses?limit=100')).data; if (!OW.sel && OW.list[0]) OW.sel = OW.list[0].id; return OW.list; }
  const bizSelect = (id, v) => '<select id="' + id + '" aria-label="Business">' + (OW.list || []).map(b => '<option value="' + b.id + '"' + (v === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') + '</select>';
  function ownerBizRows(rows) {
    return !rows.length ? '<div class="card empty">No businesses match these filters.</div>' : '<div class="card wrap"><table><tr><th>Business</th><th>Type</th><th>Status</th><th>Revenue</th><th>Orders</th><th>Staff</th><th>Business admin</th><th>Plan</th><th>Subscription</th><th>Created</th><th>Actions</th></tr>' +
      rows.map(b => '<tr><td><b>' + esc(b.name) + '</b></td><td>' + esc(b.business_type) + '</td><td>' + bstat(b.status) + '</td><td>' + fmt(b.revenue) + '</td><td>' + b.total_orders + '</td><td>' + b.staff + '</td><td>' + esc(b.admin_name || '—') + '</td><td>' + esc(b.plan || '—') + '</td><td>' + esc(b.subscription_status || '—') + '</td><td>' + new Date(b.created_at).toLocaleDateString('en-IN') + '</td><td>' +
        '<button class="b mini" data-x2="bopen" data-i="' + b.id + '">Open</button> ' + (b.status === 'active' ? '<button class="b mini" data-x2="bsus" data-i="' + b.id + '" data-n="' + esc(b.name) + '">Suspend</button> <button class="b mini" data-x2="bina" data-i="' + b.id + '" data-n="' + esc(b.name) + '">Deactivate</button>' : '<button class="b mini p" data-x2="bact" data-i="' + b.id + '">Activate</button>') + ' <button class="b mini" data-x2="bdel" data-i="' + b.id + '" data-n="' + esc(b.name) + '">Delete</button></td></tr>').join('') + '</table></div>';
  }
  async function ownerDash() {
    const gen = AS.gen; g('view').innerHTML = skel(4);
    try {
      const [d, l] = await Promise.all([api('/owner/dashboard'), api('/owner/businesses?limit=8')]); if (gen !== AS.gen || S.view !== 'odash') return; const x = d.data, b = x.businesses, st = x.staff;
      const K = [['Total businesses', b.total], ['Active', b.active], ['Inactive', b.inactive], ['Suspended', b.suspended], ['Business revenue', fmt(x.revenue)], ['Subscription MRR', fmt(x.subscriptionMrr)], ['Total staff', st.total], ['Managers', st.managers], ['Delivery partners', st.partners]];
      g('view').innerHTML = '<div class="wel"><h2>Welcome, ' + esc(USER.name.split(' ')[0]) + '</h2><span class="mut">Platform overview · figures are all-time and come straight from the database</span></div><div class="kpis">' + K.map(k => '<div class="kpi"><small>' + k[0] + '</small><b>' + k[1] + '</b></div>').join('') + '</div>' +
        '<div class="card"><h3>Subscriptions</h3>' + (x.subscriptions.map(s => '<span class="badge s-picked" style="margin-right:6px">' + esc(s.status) + ': ' + s.count + '</span>').join('') || '<span class="mut">None yet</span>') + '</div><h3>Businesses</h3>' + ownerBizRows(l.data); post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'odash'); }
  }
  async function ownerBiz() {
    const gen = AS.gen;
    g('view').innerHTML = '<div class="top"><input id="axbq" placeholder="Search businesses" value="' + esc(OW.q) + '" style="flex:1;min-width:160px" aria-label="Search businesses"><select id="axbs" aria-label="Status"><option value="">Any status</option>' + ['active', 'inactive', 'suspended'].map(x => '<option value="' + x + '"' + (OW.st === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select><button class="b p" data-x2="gonboard">+ Onboard business</button></div><div id="axbl">' + skel(5) + '</div>';
    try {
      const r = await api('/owner/businesses' + qs({ page: OW.pg, limit: 10, search: OW.q, status: OW.st })); if (gen !== AS.gen || S.view !== 'biz' || !g('axbl')) return;
      g('axbl').innerHTML = '<p class="mut">' + r.meta.total + ' businesses using the platform</p>' + ownerBizRows(r.data) + '<div class="pgn"><span>page ' + r.meta.page + '/' + (r.meta.totalPages || 1) + '</span><button class="b mini" data-x2="bpg" data-d="-1" ' + (r.meta.page < 2 ? 'disabled' : '') + '>Prev</button><button class="b mini" data-x2="bpg" data-d="1" ' + (r.meta.page >= (r.meta.totalPages || 1) ? 'disabled' : '') + '>Next</button></div>'; post();
    } catch (e) { if (gen === AS.gen && g('axbl')) g('axbl').innerHTML = errCard(e, 'biz'); }
  }
  async function ownerOverview() {
    const gen = AS.gen; g('view').innerHTML = skel(5);
    try {
      const [o, st] = await Promise.all([api('/owner/businesses/' + OW.sel), api('/owner/businesses/' + OW.sel + '/staff?limit=100')]); if (gen !== AS.gen || S.view !== 'obiz') return;
      const d = o.data, b = d.business, s = d.stats, sf = d.staff, sub = d.subscription;
      g('view').innerHTML = '<p><button class="b" data-x2="gobiz">← All businesses</button></p><div class="card"><h3 style="font-size:18px">' + esc(b.name) + ' ' + bstat(b.status) + '</h3><div class="mut">' + esc(b.business_type) + ' · ' + esc([b.address, b.city, b.state].filter(Boolean).join(', ') || 'No address') + ' · ' + esc(b.phone || 'no phone') + ' · ' + esc(b.email || 'no email') + '</div>' +
        '<p>Admin: ' + (d.admins.map(a => esc(a.name) + ' (' + esc(a.email) + ')').join(', ') || '—') + '</p><p><button class="b" data-x2="bedit">Edit details</button> <button class="b" data-x2="grights" data-i="' + b.id + '">Admin rights</button> <button class="b" data-x2="gusers" data-i="' + b.id + '">Staff</button></p></div>' +
        '<div class="kpis">' + [['Revenue', fmt(s.revenue)], ['Collected', fmt(s.collected)], ['Orders', s.total_orders], ['Delivered', s.delivered], ['Pending', s.pending], ['Partial', s.partial], ['Returned', s.returned], ['Failed', s.failed], ['Staff', sf.total], ['Managers', sf.managers], ['Delivery partners', sf.partners]].map(k => '<div class="kpi"><small>' + k[0] + '</small><b style="font-size:20px">' + k[1] + '</b></div>').join('') + '</div>' +
        '<div class="card"><h3>Subscription</h3>' + (sub ? '<div class="row"><span style="width:160px">Plan</span><b>' + esc(sub.plan_name) + ' (' + fmt(sub.price) + ')</b></div><div class="row"><span style="width:160px">Status</span><b>' + esc(sub.status) + '</b></div><div class="row"><span style="width:160px">Renewal</span><b>' + esc(sub.renewal_date ? String(sub.renewal_date).slice(0, 10) : '—') + '</b></div>' : 'No subscription') + '</div>' + staffTable(st.data); window.__owBiz = b; post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = '<p><button class="b" data-x2="gobiz">← All businesses</button></p>' + errCard(e, 'obiz'); }
  }
  const RL2 = { business_admin: 'Business Admin', manager: 'Manager', delivery_partner: 'Delivery Partner' };
  const staffTable = rows => !rows.length ? '<div class="card empty">No staff.</div>' : '<div class="card wrap"><h3>Staff</h3><table><tr><th>Name</th><th>Role</th><th>Designation</th><th>Mobile</th><th>Email</th><th>Status</th><th>Orders</th><th>Delivered</th><th>Partial</th><th>Returned</th><th>Failed</th><th>Collection</th></tr>' + rows.map(u => '<tr><td>' + esc(u.name) + '</td><td>' + RL2[u.role] + '</td><td>' + esc(u.designation || '—') + '</td><td>' + esc(u.mobile || '—') + '</td><td>' + esc(u.email) + '</td><td>' + esc(u.status) + '</td><td>' + u.orders + '</td><td>' + u.delivered + '</td><td>' + u.partial + '</td><td>' + u.returned + '</td><td>' + u.failed + '</td><td>' + fmt(u.collection) + '</td></tr>').join('') + '</table></div>';
  async function ownerUsers() {
    const gen = AS.gen; g('view').innerHTML = skel(3);
    try {
      await ownerBizList(); if (!OW.list.length) { g('view').innerHTML = '<div class="card empty">No businesses yet.</div>'; return; }
      g('view').innerHTML = '<div class="top">' + bizSelect('axub', OW.sel) + '<select id="axur" aria-label="Role"><option value="">All roles</option>' + Object.entries(RL2).map(([k, v]) => '<option value="' + k + '"' + (OW.role === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select><span class="mut">Read-only view of each business\'s team. Business Admins manage their own staff.</span></div><div id="axul">' + skel(4) + '</div>';
      const r = await api('/owner/businesses/' + OW.sel + '/staff' + qs({ role: OW.role, limit: 100 })); if (gen !== AS.gen || S.view !== 'users' || !g('axul')) return; g('axul').innerHTML = staffTable(r.data); post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'users'); }
  }
  const PLN = {};
  async function loadPlans() { const r = (await api('/owner/plans')).data; r.forEach(p => { PLN[p.id] = p; }); return r; }
  const lim = v => v == null ? 'Unlimited' : String(v);
  async function ownerPlans() {
    const gen = AS.gen; g('view').innerHTML = skel(4);
    try {
      const rows = await loadPlans(); if (gen !== AS.gen || S.view !== 'plans') return;
      g('view').innerHTML = '<div class="top"><span class="mut" style="margin-right:auto">SaaS plans offered to businesses</span><button class="b p" data-x2="pnew">+ New plan</button></div><div class="card wrap"><table><tr><th>Plan</th><th>Price</th><th>Cycle</th><th>Users</th><th>Partners</th><th>Orders / month</th><th>API</th><th>Sheets</th><th>WhatsApp</th><th>Subscribers</th><th>Active</th><th></th></tr>' +
        rows.map(p => '<tr><td><b>' + esc(p.name) + '</b></td><td>' + fmt(p.price) + '</td><td>' + p.billing_cycle + '</td><td>' + lim(p.max_users) + '</td><td>' + lim(p.max_delivery_partners) + '</td><td>' + lim(p.max_orders_per_month) + '</td><td>' + (p.api_access ? '✓' : '—') + '</td><td>' + (p.google_sheets ? '✓' : '—') + '</td><td>' + (p.whatsapp ? '✓' : '—') + '</td><td>' + p.subscribers + '</td><td>' + (p.active ? 'Yes' : 'No') + '</td><td><button class="b mini" data-x2="pedit" data-i="' + p.id + '">Edit</button> <button class="b mini" data-x2="ptog" data-i="' + p.id + '">' + (p.active ? 'Deactivate' : 'Activate') + '</button></td></tr>').join('') + '</table></div>'; post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'plans'); }
  }
  function planDlg(p) {
    const n = v => v == null ? '' : v, ck = (id, l, v) => '<label><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '> ' + l + '</label>';
    adlg(p ? 'Edit plan' : 'New plan', '<label>Plan name<input id="axpn" value="' + esc(p ? p.name : '') + '"></label><label>Price (₹)<input id="axpp" type="number" min="0" step="0.01" value="' + (p ? p.price : 0) + '"></label><label>Billing cycle<select id="axpc">' + ['monthly', 'quarterly', 'yearly'].map(x => '<option' + (p && p.billing_cycle === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></label>' +
      '<label>Max users (blank = unlimited)<input id="axpu" type="number" min="1" value="' + n(p && p.max_users) + '"></label><label>Max delivery partners (blank = unlimited)<input id="axpd" type="number" min="0" value="' + n(p && p.max_delivery_partners) + '"></label><label>Orders per month (blank = unlimited)<input id="axpo" type="number" min="0" value="' + n(p && p.max_orders_per_month) + '"></label>' + ck('axpa', 'API access', p && p.api_access) + ck('axpg', 'Google Sheets', p && p.google_sheets) + ck('axpw', 'WhatsApp', p && p.whatsapp), p ? 'Save plan' : 'Create plan', async () => {
        const v = id => g(id).value.trim(), nul = id => v(id) === '' ? null : +v(id); if (v('axpn').length < 2) throw new ApiError(0, 'VALIDATION_ERROR', 'Plan name is required.'); if (!(+v('axpp') >= 0)) throw new ApiError(0, 'VALIDATION_ERROR', 'Price cannot be negative.');
        const body = { name: v('axpn'), price: +v('axpp'), billingCycle: g('axpc').value, maxUsers: nul('axpu'), maxDeliveryPartners: nul('axpd'), maxOrdersPerMonth: nul('axpo'), apiAccess: g('axpa').checked, googleSheets: g('axpg').checked, whatsapp: g('axpw').checked };
        await api(p ? '/owner/plans/' + p.id : '/owner/plans', { method: p ? 'PATCH' : 'POST', body }); toast(p ? 'Plan updated' : 'Plan created'); ownerPlans();
      });
  }
  async function ownerSubs() {
    const gen = AS.gen; g('view').innerHTML = skel(4);
    try {
      const [l, plans] = await Promise.all([ownerBizList(true), loadPlans()]); if (gen !== AS.gen || S.view !== 'subs') return;
      const SU = ['trial', 'active', 'past_due', 'expired', 'cancelled'];
      g('view').innerHTML = '<div class="kpis">' + SU.map(x => '<div class="kpi"><small>' + x.replace('_', ' ') + '</small><b>' + l.filter(b => b.subscription_status === x).length + '</b></div>').join('') + '</div><div class="card wrap"><table><tr><th>Business</th><th>Business status</th><th>Plan</th><th>Subscription status</th></tr>' +
        l.map(b => '<tr><td>' + esc(b.name) + '</td><td>' + bstat(b.status) + '</td><td><select data-x2="sp" data-i="' + b.id + '" aria-label="Plan">' + plans.map(p => '<option value="' + p.id + '"' + (p.name === b.plan ? ' selected' : '') + (p.active || p.name === b.plan ? '' : ' disabled') + '>' + esc(p.name) + '</option>').join('') + '</select></td><td><select data-x2="ss" data-i="' + b.id + '" aria-label="Subscription status">' + SU.map(x => '<option value="' + x + '"' + (b.subscription_status === x ? ' selected' : '') + '>' + x.replace('_', ' ') + '</option>').join('') + '</select></td></tr>').join('') + '</table></div><p class="mut">Business status and subscription status are separate. Payment collection is not connected yet.</p>'; post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'subs'); }
  }
  async function ownerReports() {
    const gen = AS.gen, R2 = OW.reps; await ownerBizList().catch(() => {});
    g('view').innerHTML = '<div class="top"><input id="axoq" placeholder="Search business" value="' + esc(R2.q) + '" style="flex:1;min-width:140px" aria-label="Search business"><select id="axob" aria-label="Business"><option value="">All businesses</option>' + (OW.list || []).map(b => '<option value="' + b.id + '"' + (R2.biz === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') + '</select><button class="b" data-x2="orexp" data-f="csv">Export CSV</button><button class="b" data-x2="orexp" data-f="excel">Export Excel</button><button class="b" onclick="print()">Print</button></div><div id="axoc">' + skel(4) + '</div>';
    try {
      const r = await api('/owner/reports/businesses' + qs({ ...dates(), search: R2.q, businessId: R2.biz })); if (gen !== AS.gen || S.view !== 'reports' || !g('axoc')) return; const d = r.data;
      g('axoc').innerHTML = !d.rows.length ? '<div class="card empty">No businesses match.</div>' : '<div class="card wrap"><table><tr>' + d.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>' + d.rows.map(row => '<tr>' + row.map(c => '<td>' + cellf(c) + '</td>').join('') + '</tr>').join('') + '</table></div><p class="mut">Business-level sales, returns and collections. Individual orders are not part of the owner\'s reports. Period follows the selector above.</p>'; post();
    } catch (e) { if (gen === AS.gen && g('axoc')) g('axoc').innerHTML = errCard(e, 'oreports'); }
  }
  async function ownerExport(fmt2) {
    const blob = await authBlob('/owner/reports/businesses' + qs({ ...dates(), search: OW.reps.q, businessId: OW.reps.biz, format: fmt2 }));
    if (window.URL && URL.createObjectURL) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'businesses' + (fmt2 === 'csv' ? '.csv' : '.xls'); document.body.appendChild(a); a.click(); a.remove(); }
    return blob;
  }
  async function ownerOnboard() {
    const gen = AS.gen; g('view').innerHTML = skel(4);
    try {
      const plans = (await loadPlans()).filter(p => p.active); if (gen !== AS.gen || S.view !== 'onboard') return;
      g('view').innerHTML = '<div class="card" style="max-width:560px"><h3>Onboard a new business</h3><div class="f"><label>Business name<input id="axo1"></label><label>Business type<input id="axo2" placeholder="e.g. Pharmacy, Bakery, Courier"></label><label>City<input id="axo9"></label><label>Business admin name<input id="axo3"></label><label>Admin login email<input id="axo4" type="email"></label><label>Admin mobile (optional)<input id="axo5" inputmode="numeric"></label><label>Initial password (8+ chars, a capital letter and a number)<input id="axo6" type="password" autocomplete="new-password"></label>' +
        '<label>Plan<select id="axo7">' + plans.map(p => '<option value="' + p.id + '">' + esc(p.name) + ' · ' + fmt(p.price) + '</option>').join('') + '</select></label><label>Subscription<select id="axo8"><option value="trial">Trial</option><option value="active">Active</option></select></label><div class="err" id="axoe" role="alert"></div><button class="b p" data-x2="osave">Create business & admin</button></div><p class="mut">The admin receives the default Business Admin rights for this business only. You can change them under Rights & Permissions.</p></div>'; post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'onboard'); }
  }
  async function ownerRights() {
    const gen = AS.gen, P2 = OW.perm; g('view').innerHTML = skel(4);
    try {
      await ownerBizList(); if (!P2.cat) P2.cat = (await api('/owner/permissions')).data.filter(p => p.scope === 'business');
      if (!OW.list.length) { g('view').innerHTML = '<div class="card empty">No businesses yet.</div>'; return; }
      const d = (await api('/owner/businesses/' + OW.sel)).data; if (gen !== AS.gen || S.view !== 'rights') return;
      if (!d.admins.some(a => a.id === P2.admin)) P2.admin = d.admins[0] ? d.admins[0].id : '';
      P2.have = P2.admin ? new Set((await api('/owner/users/' + P2.admin + '/permissions')).data.permissions) : new Set();
      const cats = [...new Set(P2.cat.map(p => p.category))];
      g('view').innerHTML = '<div class="top">' + bizSelect('axrb', OW.sel) + '<select id="axra" aria-label="Business admin">' + d.admins.map(a => '<option value="' + a.id + '"' + (a.id === P2.admin ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select><button class="b p" data-x2="rsave" ' + (P2.admin ? '' : 'disabled') + '>Save rights</button></div>' +
        '<p class="mut">Rights you remove from a Business Admin are removed from that business\'s Managers immediately. A Manager can never hold a right its Business Admin does not have.</p>' + cats.map(c => '<div class="card"><h3>' + esc(c) + '</h3>' + P2.cat.filter(p => p.category === c).map(p => '<label class="row"><input type="checkbox" data-x2="pchk" data-k="' + p.key + '"' + (P2.have.has(p.key) ? ' checked' : '') + '> <span style="width:auto">' + esc(p.description) + ' <small class="mut">(' + p.key + ')</small></span></label>').join('') + '</div>').join('') +
        '<div class="card"><b>Custom roles and custom rights</b><p class="mut">Not available yet: the backend has a fixed rights catalog. They will appear here once the backend supports them.</p></div>'; post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'rights'); }
  }
  function onboardSave(t) {
    const v = id => g(id).value.trim(), er = g('axoe'); er.textContent = '';
    const body = { name: v('axo1'), businessType: v('axo2'), city: v('axo9') || undefined, planId: g('axo7').value, subscriptionStatus: g('axo8').value, admin: { name: v('axo3'), email: v('axo4').toLowerCase(), mobile: v('axo5') || undefined, password: g('axo6').value } };
    if (!body.name || !body.businessType || !body.admin.name) { er.textContent = 'Business name, type and admin name are required.'; return; }
    if (!/^\S+@\S+\.\S+$/.test(body.admin.email)) { er.textContent = 'Enter a valid admin email.'; return; }
    t.disabled = true; api('/owner/businesses', { method: 'POST', body }).then(() => { toast('Business created'); OW.list = null; OW.q = ''; OW.st = ''; OW.pg = 1; S.view = 'biz'; render(); }).catch(e => { er.textContent = msgOf(e); t.disabled = false; });
  }
  function editBizDlg(b) {
    adlg('Edit business', ['name:Business name', 'business_type:Business type', 'phone:Phone', 'email:Email', 'address:Address', 'city:City'].map(x => { const [k, l] = x.split(':'); return '<label>' + l + '<input id="axe_' + k + '" value="' + esc(b[k] || '') + '"></label>'; }).join(''), 'Save changes', async () => {
      const body = {}; for (const [k, key] of [['name', 'name'], ['business_type', 'businessType'], ['phone', 'phone'], ['email', 'email'], ['address', 'address'], ['city', 'city']]) { const v = g('axe_' + k).value.trim(); if (v !== (b[k] || '')) { if (v === '' && ['phone', 'email', 'address', 'city'].includes(k)) continue; body[key] = v; } }
      if (!Object.keys(body).length) return true; await api('/owner/businesses/' + b.id, { method: 'PATCH', body }); toast('Business updated'); OW.list = null; ownerOverview();
    });
  }
  const bizAct = async (id, what, label) => { try { await api('/owner/businesses/' + id + (what === 'delete' ? '?confirm=true' : '/' + what), { method: what === 'delete' ? 'DELETE' : 'POST' }); toast(label); OW.list = null; } catch (e) { toast(msgOf(e)); } S.view === 'obiz' && what === 'delete' ? (S.view = 'biz', render()) : render(); };
  document.addEventListener('input', e => { if (e.target.id === 'axbq') { clearTimeout(qTimer); qTimer = setTimeout(() => { OW.q = e.target.value.trim(); OW.pg = 1; ownerBiz(); }, 300); } else if (e.target.id === 'axoq') { clearTimeout(qTimer); qTimer = setTimeout(() => { OW.reps.q = e.target.value.trim(); ownerReports(); }, 300); } });
  document.addEventListener('change', async e => {
    const t = e.target, x = t.dataset.x2;
    if (t.id === 'axbs') { OW.st = t.value; OW.pg = 1; ownerBiz(); } else if (t.id === 'axub') { OW.sel = t.value; ownerUsers(); } else if (t.id === 'axur') { OW.role = t.value; ownerUsers(); }
    else if (t.id === 'axob') { OW.reps.biz = t.value; ownerReports(); } else if (t.id === 'axrb') { OW.sel = t.value; OW.perm.admin = ''; ownerRights(); } else if (t.id === 'axra') { OW.perm.admin = t.value; ownerRights(); }
    else if (x === 'pchk') { t.checked ? OW.perm.have.add(t.dataset.k) : OW.perm.have.delete(t.dataset.k); }
    else if (x === 'sp' || x === 'ss') { t.disabled = true; try { await api('/owner/businesses/' + t.dataset.i + '/subscription', { method: 'PUT', body: x === 'sp' ? { planId: t.value } : { status: t.value } }); toast('Subscription updated'); } catch (er) { toast(msgOf(er)); } ownerSubs(); }
  });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-x2]'); if (!t || S.role !== 'owner') return; const x = t.dataset.x2, id = t.dataset.i, nm = t.dataset.n;
    if (x === 'bopen') { OW.sel = id; S.view = 'obiz'; render(); } else if (x === 'gobiz') { S.view = 'biz'; render(); } else if (x === 'gonboard') { S.view = 'onboard'; render(); }
    else if (x === 'grights') { OW.sel = id; OW.perm.admin = ''; S.view = 'rights'; render(); } else if (x === 'gusers') { OW.sel = id; S.view = 'users'; render(); }
    else if (x === 'bpg') { OW.pg = Math.max(1, OW.pg + +t.dataset.d); ownerBiz(); }
    else if (x === 'bact') bizAct(id, 'activate', 'Business activated');
    else if (x === 'bsus') confirmD('Suspend “' + esc(nm) + '”? All of its users are signed out immediately and cannot sign in until it is activated again.', () => bizAct(id, 'suspend', 'Business suspended'), 'Suspend');
    else if (x === 'bina') confirmD('Deactivate “' + esc(nm) + '”? Its users are signed out and blocked until it is activated again.', () => bizAct(id, 'deactivate', 'Business deactivated'), 'Deactivate');
    else if (x === 'bdel') confirmD('Are you sure you want to delete “' + esc(nm) + '”? Its users lose access immediately. Its records are kept in the database but are no longer available in the platform.', () => bizAct(id, 'delete', 'Business deleted'), 'Delete business');
    else if (x === 'bedit') editBizDlg(window.__owBiz);
    else if (x === 'pnew') planDlg(null); else if (x === 'pedit') planDlg(PLN[id]);
    else if (x === 'ptog') { t.disabled = true; try { await api('/owner/plans/' + id, { method: 'PATCH', body: { active: !PLN[id].active } }); toast('Plan updated'); } catch (er) { toast(msgOf(er)); } ownerPlans(); }
    else if (x === 'osave') onboardSave(t);
    else if (x === 'orexp') { t.disabled = true; try { await ownerExport(t.dataset.f); toast('Report exported'); } catch (er) { toast(msgOf(er)); } t.disabled = false; }
    else if (x === 'rsave') { t.disabled = true; try { const r = await api('/owner/users/' + OW.perm.admin + '/permissions', { method: 'PUT', body: { permissions: [...OW.perm.have] } }); toast(r.message || 'Rights saved'); } catch (er) { toast(msgOf(er)); } t.disabled = false; }
  });
  const OWN_MSG = { revenue: 'Platform subscription payments have no backend yet, so there is nothing real to show. Business revenue is on the Dashboard and Reports.', support: 'Support tickets have no backend yet.', sys: 'Platform settings have no backend yet.', notif: 'Platform notifications are not connected yet.',
    integ: 'Integrations are managed per business by its Business Admin. The platform owner has no access to a business\'s integrations or credentials.', apikeys: 'API keys belong to each business and are managed by its Business Admin. The platform owner cannot see them.', hooks: 'Webhooks belong to each business and are managed by its Business Admin. The platform owner cannot see them.' };

  // ------------------------------------------------------------------ notifications (all roles)
  let unreadN = 0;
  async function refreshBell() { if (!AS.user || S.role === 'owner') return; try { unreadN = (await api('/notifications?unread=true&limit=1')).meta.total; } catch { /* keep last */ } const b = g('bc'); if (b) b.textContent = unreadN || ''; }
  const _post = window.post; window.post = function () { _post(); const b = g('bc'); if (b) b.textContent = unreadN || ''; };
  setInterval(refreshBell, 45000);
  async function notifApi() {
    if (S.role === 'owner') return notConnected('notif');
    const gen = AS.gen; g('view').innerHTML = skel(4);
    try {
      const r = await api('/notifications?limit=40'); if (gen !== AS.gen || S.view !== 'notif') return;
      g('view').innerHTML = '<div class="top"><span class="mut" style="margin-right:auto">' + r.meta.total + ' notifications</span><button class="b" data-x2="nread">Mark all read</button></div><div class="card">' + (r.data.map(n => '<div class="row" style="margin:10px 0;align-items:flex-start"><span style="width:auto">' + (n.status === 'unread' ? '🔵' : '⚪') + '</span><div style="flex:1"><b>' + esc(n.title) + '</b>' + (n.body ? '<br>' + esc(n.body) : '') + '<br><small class="mut">' + dt(n.created_at) + '</small></div>' + (n.status === 'unread' ? '<button class="b mini" data-x2="nrd" data-i="' + n.id + '">Mark read</button>' : '') + '</div>').join('') || '<div class="empty">No notifications yet.</div>') + '</div>'; unreadN = r.data.filter(n => n.status === 'unread').length; post();
    } catch (e) { if (gen === AS.gen) g('view').innerHTML = errCard(e, 'notif'); }
  }

  // ------------------------------------------------------------------ Staff & Team (Business Admin)
  const SF = { role: '', q: '', pg: 1, rows: [] };
  const NOT_DELEGABLE = ['permissions.manage', 'users.delete', 'apikeys.manage'];
  async function staffApi() {
    if (!has('users.view')) return unauth(); const gen = AS.gen;
    g('view').innerHTML = '<div class="top"><input id="axsq" placeholder="Search name or email" value="' + esc(SF.q) + '" style="flex:1;min-width:140px" aria-label="Search staff"><select id="axsr" aria-label="Role"><option value="">All roles</option><option value="manager"' + (SF.role === 'manager' ? ' selected' : '') + '>Managers</option><option value="delivery_partner"' + (SF.role === 'delivery_partner' ? ' selected' : '') + '>Delivery partners</option></select>' + (has('users.create') ? '<button class="b p" data-x2="snew">+ Add staff</button>' : '') + '</div><div id="axsl">' + skel(5) + '</div>';
    try {
      const r = await api('/users' + qs({ page: SF.pg, limit: 12, role: SF.role, search: SF.q })); if (gen !== AS.gen || S.view !== 'staff' || !g('axsl')) return; SF.rows = r.data;
      g('axsl').innerHTML = !r.data.length ? '<div class="card empty">No staff match. Add a manager or delivery partner.</div>' : '<div class="card wrap"><table><tr><th>Name</th><th>Designation</th><th>Role</th><th>Mobile</th><th>Email / login</th><th>Status</th><th>Orders</th><th>Delivered</th><th>Partial</th><th>Returned</th><th>Collection</th><th></th></tr>' + r.data.map(u => {
        const mine = u.role !== 'business_admin';
        return '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.designation || '—') + '</td><td>' + RL2[u.role] + '</td><td>' + esc(u.mobile || '—') + '</td><td>' + esc(u.email) + '</td><td>' + esc(u.status) + '</td><td>' + u.orders + '</td><td>' + u.delivered + '</td><td>' + u.partial + '</td><td>' + u.returned + '</td><td>' + fmt(u.collection) + '</td><td>' + (!mine ? '' :
          (has('users.edit') ? '<button class="b mini" data-x2="sedit" data-i="' + u.id + '">Edit</button> <button class="b mini" data-x2="stog" data-i="' + u.id + '">' + (u.status === 'active' ? 'Deactivate' : 'Activate') + '</button> <button class="b mini" data-x2="spw" data-i="' + u.id + '">Reset password</button> ' : '') +
          (u.role === 'manager' && has('permissions.manage') && S.role === 'admin' ? '<button class="b mini p" data-x2="srights" data-i="' + u.id + '">Rights</button> ' : '') + (has('users.delete') ? '<button class="b mini" data-x2="sdel" data-i="' + u.id + '">Delete</button>' : '')) + '</td></tr>';
      }).join('') + '</table><div class="pgn"><span>' + r.meta.total + ' people · page ' + r.meta.page + '/' + (r.meta.totalPages || 1) + '</span><button class="b mini" data-x2="spg" data-d="-1" ' + (r.meta.page < 2 ? 'disabled' : '') + '>Prev</button><button class="b mini" data-x2="spg" data-d="1" ' + (r.meta.page >= (r.meta.totalPages || 1) ? 'disabled' : '') + '>Next</button></div></div>'; post();
    } catch (e) { if (gen === AS.gen && g('axsl')) g('axsl').innerHTML = errCard(e, 'staff'); }
  }
  const desigList = () => '<datalist id="axdl">' + [...new Set(SF.rows.map(u => u.designation).filter(Boolean).concat(['Operations Executive', 'Supervisor', 'Team Leader', 'Area Manager', 'Delivery Executive']))].map(d => '<option value="' + esc(d) + '">').join('') + '</datalist>';
  function staffDlg(u) {
    adlg(u ? 'Edit ' + esc(u.name) : 'Add staff', '<label>Name<input id="axsn" value="' + esc(u ? u.name : '') + '"></label>' + (u ? '' : '<label>Email / login ID<input id="axse" type="email" autocomplete="off"></label><label>Role<select id="axsro"><option value="manager">Manager</option><option value="delivery_partner">Delivery partner</option></select></label>') +
      '<label>Mobile<input id="axsm" inputmode="numeric" value="' + esc(u ? u.mobile || '' : '') + '"></label><label>Designation (type a new one to create it)<input id="axsd" list="axdl" value="' + esc(u ? u.designation || '' : '') + '"></label>' + desigList() + (u ? '' : '<label>Initial password (8+ chars, a capital letter and a number)<input id="axsp" type="password" autocomplete="new-password"></label>'), u ? 'Save' : 'Create user', async () => {
      const v = id => g(id).value.trim(); if (v('axsn').length < 2) throw new ApiError(0, 'VALIDATION_ERROR', 'Name is required.'); if (v('axsm') && !/^\+?[0-9]{10,15}$/.test(v('axsm'))) throw new ApiError(0, 'VALIDATION_ERROR', 'Mobile must be 10-15 digits.');
      if (u) await api('/users/' + u.id, { method: 'PATCH', body: { name: v('axsn'), mobile: v('axsm') || undefined, designation: v('axsd') || undefined } });
      else { if (!/^\S+@\S+\.\S+$/.test(v('axse'))) throw new ApiError(0, 'VALIDATION_ERROR', 'Enter a valid email.'); await api('/users', { method: 'POST', body: { name: v('axsn'), email: v('axse').toLowerCase(), role: g('axsro').value, mobile: v('axsm') || undefined, designation: v('axsd') || undefined, password: g('axsp').value } }); }
      toast(u ? 'Staff updated' : 'Staff created'); staffApi();
    });
  }
  async function rightsDlg(id) {
    let r; try { r = (await api('/users/' + id + '/permissions')).data; } catch (e) { return toast(msgOf(e)); }
    const gr = r.grantable.filter(k => !NOT_DELEGABLE.includes(k) && !k.startsWith('platform.')), cats = [...new Set(gr.map(k => k.split('.')[0]))];
    adlg('Manager rights', '<p class="mut">You can only give rights you hold yourself. Rights you do not have are not listed.</p>' + cats.map(c => '<div><b>' + esc(c) + '</b>' + gr.filter(k => k.split('.')[0] === c).map(k => '<label class="row"><input type="checkbox" class="axpm" value="' + k + '"' + (r.permissions.includes(k) ? ' checked' : '') + '> <span style="width:auto">' + esc(k) + '</span></label>').join('') + '</div>').join(''), 'Save rights', async () => {
      await api('/users/' + id + '/permissions', { method: 'PUT', body: { permissions: [...document.querySelectorAll('.axpm:checked')].map(c => c.value) } }); toast('Rights updated');
    });
  }

  // ------------------------------------------------------------------ Settings (Business Admin): business, operations, Google Sheets, API keys, webhooks, subscription
  const SET = { tab: '' };
  const live = k => !!g('axtab') && SET.tab === k;      // a slow response for a tab the user has already left must not overwrite the current tab
  const tabsFor = () => [['business', 'Business', has('settings.view')], ['ops', 'Operations', has('settings.view')], ['google', 'Google Sheets', has('integrations.view')], ['keys', 'API keys', has('apikeys.manage')], ['hooks', 'Webhooks', has('webhooks.manage')], ['sub', 'Subscription', has('settings.view')]].filter(t => t[2]);
  function settingsApi() {
    if (S.role === 'manager') return myRights();
    const T2 = tabsFor(); if (!T2.length) return unauth(); if (!T2.some(t => t[0] === SET.tab)) SET.tab = T2[0][0];
    g('view').innerHTML = '<div id="axset"><div class="tabs">' + T2.map(t => '<button data-x2="stab" data-t2="' + t[0] + '" class="' + (SET.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</div><div id="axtab">' + skel(4) + '</div></div>'; post(); loadTab();
  }
  const loadTab = () => ({ business: tabBusiness, ops: tabOps, google: () => googlePanel(g('axtab')), keys: tabKeys, hooks: tabHooks, sub: tabSub }[SET.tab] || (() => {}))();
  function myRights() {
    const ks = [...AS.perms].sort(), cats = [...new Set(ks.map(k => k.split('.')[0]))];
    g('view').innerHTML = '<div class="card"><h3>Your rights</h3><p class="mut">Granted by your Business Admin. The server checks these on every request.</p>' + (cats.map(c => '<div class="row"><span style="width:150px"><b>' + esc(c) + '</b></span><span style="width:auto">' + ks.filter(k => k.split('.')[0] === c).map(k => esc(k.split('.')[1])).join(', ') + '</span></div>').join('') || '<div class="empty">No rights granted.</div>') + '</div>'; post();
  }
  const tabErr = (e, k) => { const t = g('axtab'); if (t) t.innerHTML = errCard(e, k); };
  async function tabBusiness() {
    try {
      const b = (await api('/business')).data, ed = has('settings.manage'), dis = ed ? '' : ' disabled'; if (!live('business')) return;
      g('axtab').innerHTML = '<div class="card" style="max-width:560px"><h3>Business details</h3><div class="f">' + [['name', 'Business name', 'name'], ['phone', 'Phone', 'phone'], ['email', 'Email', 'email'], ['whatsappNumber', 'WhatsApp number', 'whatsapp_number'], ['address', 'Address', 'address'], ['city', 'City', 'city'], ['state', 'State', 'state'], ['pincode', 'Pincode', 'pincode']].map(f => '<label>' + f[1] + '<input id="axb_' + f[0] + '" value="' + esc(b[f[2]] || '') + '"' + dis + '></label>').join('') +
        '<label>Business logo (png / jpg / webp)<input type="file" id="axblogo" accept="image/*"' + dis + '></label><div class="mut">' + (b.logo_key ? 'A logo is on file.' : 'No logo uploaded.') + ' Timezone: ' + esc(b.timezone) + '</div><div class="err" id="axbe" role="alert"></div>' + (ed ? '<button class="b p" data-x2="bsave">Save business details</button>' : '<span class="mut">You do not have permission to edit these details.</span>') + '</div></div>'; window.__biz = b;
    } catch (e) { tabErr(e, 'settings'); }
  }
  async function saveBusiness(t) {
    const er = g('axbe'); er.textContent = ''; const b = window.__biz, body = {};
    for (const k of ['name', 'phone', 'email', 'whatsappNumber', 'address', 'city', 'state', 'pincode']) { const v = g('axb_' + k).value.trim(), old = b[{ whatsappNumber: 'whatsapp_number' }[k] || k] || ''; if (v !== old && (v !== '' || k === 'name')) body[k] = v; }
    t.disabled = true;
    try {
      const f = g('axblogo').files[0]; if (f) { const fd = new FormData(); fd.append('kind', 'logo'); fd.append('file', f); body.logoFileId = (await api('/files', { method: 'POST', form: fd })).data.id; }
      if (!Object.keys(body).length) { toast('Nothing to save'); t.disabled = false; return; }
      await api('/business', { method: 'PATCH', body }); toast('Business details saved'); if (body.name) { BIZ[0].name = body.name; render(); } else tabBusiness();
    } catch (e) { er.textContent = msgOf(e); t.disabled = false; }
  }
  const FLAGS = [['codEnabled', 'Cash on delivery'], ['returnsEnabled', 'Returns'], ['partialDeliveryEnabled', 'Partial delivery'], ['otpRequired', 'Customer OTP at delivery'], ['photoRequired', 'Delivery photo'], ['signatureRequired', 'Customer signature'], ['paymentProofRequired', 'Payment proof photo'], ['returnPhotoRequired', 'Return item photo'], ['gpsRequired', 'GPS location']];
  async function tabOps() {
    try {
      const s = (await api('/business/settings')).data, ed = has('settings.manage'), dis = ed ? '' : ' disabled'; if (!live('ops')) return;
      g('axtab').innerHTML = '<div class="card" style="max-width:560px"><h3>Delivery rules</h3><div class="f">' + FLAGS.map(f => '<label class="row"><input type="checkbox" id="axf_' + f[0] + '"' + (s[f[0]] ? ' checked' : '') + dis + '> <span style="width:auto">' + f[1] + '</span></label>').join('') +
        '<label>Order number prefix<input id="axf_orderPrefix" maxlength="8" value="' + esc(s.orderPrefix) + '"' + dis + '></label><label>Payment modes (comma separated)<input id="axf_paymentModes" value="' + esc((s.paymentModes || []).join(', ')) + '"' + dis + '></label><label>What managers may see in reports<select id="axf_managerReportScope"' + dis + '>' + [['same_day', 'Same day only'], ['weekly', 'Current week'], ['monthly', 'Current month'], ['yearly', 'Current year'], ['complete', 'Complete history']].map(o => '<option value="' + o[0] + '"' + (s.managerReportScope === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label><div class="err" id="axfe" role="alert"></div>' + (ed ? '<button class="b p" data-x2="osv">Save settings</button>' : '') + '</div></div>';
    } catch (e) { tabErr(e, 'settings'); }
  }
  async function saveOps(t) {
    const er = g('axfe'); er.textContent = ''; const body = {}; FLAGS.forEach(f => { body[f[0]] = g('axf_' + f[0]).checked; });
    body.orderPrefix = g('axf_orderPrefix').value.trim(); body.managerReportScope = g('axf_managerReportScope').value; body.paymentModes = g('axf_paymentModes').value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    t.disabled = true; try { await api('/business/settings', { method: 'PUT', body }); toast('Settings saved'); } catch (e) { er.textContent = msgOf(e); } t.disabled = false;
  }
  async function tabSub() {
    try { const s = (await api('/business/subscription')).data; if (!live('sub')) return; const L = v => v == null ? 'Unlimited' : v;
      g('axtab').innerHTML = '<div class="card" style="max-width:520px"><h3>Subscription</h3>' + (s ? [['Plan', s.plan], ['Status', s.status], ['Renewal date', s.renewalDate ? String(s.renewalDate).slice(0, 10) : '—'], ['Users', L(s.maxUsers)], ['Delivery partners', L(s.maxPartners)], ['Orders per month', L(s.maxOrdersPerMonth)], ['API access', s.apiAccess ? 'Yes' : 'No'], ['Google Sheets', s.googleSheets ? 'Yes' : 'No'], ['WhatsApp', s.whatsapp ? 'Yes' : 'No']].map(r => '<div class="row"><span style="width:180px">' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>').join('') + '<p class="mut">Plans are managed by the platform owner. Online payment is not connected.</p>' : 'No subscription found.') + '</div>';
    } catch (e) { tabErr(e, 'settings'); }
  }
  async function tabKeys() {
    try {
      const k = (await api('/api-keys')).data; if (!live('keys')) return;
      g('axtab').innerHTML = '<div class="top"><span class="mut" style="margin-right:auto">Keys let your own systems create and read orders. The secret is shown once.</span><button class="b p" data-x2="knew">+ Create API key</button></div><div class="card wrap">' + (!k.length ? '<div class="empty">No API keys yet.</div>' : '<table><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>' + k.map(x => '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.key_prefix) + '…</td><td>' + esc(x.scopes.join(', ')) + '</td><td>' + dt(x.created_at) + '</td><td>' + dt(x.last_used_at) + '</td><td>' + (x.active ? 'Active' : 'Revoked') + '</td><td>' + (x.active ? '<button class="b mini" data-x2="krev" data-i="' + x.id + '" data-n="' + esc(x.name) + '">Revoke</button>' : '') + '</td></tr>').join('') + '</table>') + '</div>';
    } catch (e) { tabErr(e, 'settings'); }
  }
  const SCOPES = ['orders.view', 'orders.create', 'orders.edit', 'customers.view', 'customers.create', 'deliveries.view', 'reports.view'];
  const secretDlg = (title, secret) => { const d = adlg(title, '<p class="mut">Copy it now. It cannot be shown again; only a hash is stored.</p><input readonly value="' + esc(secret) + '" onclick="this.select()" aria-label="Secret">', null); return d; };
  function keyDlg() {
    adlg('Create API key', '<label>Name<input id="axkn" placeholder="e.g. ERP integration"></label><div class="mut">Scopes (only rights you hold)</div>' + SCOPES.map(sc => '<label class="row"><input type="checkbox" class="axks" value="' + sc + '"' + (has(sc) ? '' : ' disabled') + '> <span style="width:auto">' + sc + '</span></label>').join(''), 'Create key', async () => {
      const name = g('axkn').value.trim(), scopes = [...document.querySelectorAll('.axks:checked')].map(c => c.value); if (name.length < 2) throw new ApiError(0, 'VALIDATION_ERROR', 'Give the key a name.'); if (!scopes.length) throw new ApiError(0, 'VALIDATION_ERROR', 'Choose at least one scope.');
      const r = (await api('/api-keys', { method: 'POST', body: { name, scopes } })).data; q$('#dlg').close(); secretDlg('Your new API key', r.secret); tabKeys();
    });
  }
  async function tabHooks() {
    try {
      const h = (await api('/webhooks')).data; if (!live('hooks')) return;
      g('axtab').innerHTML = '<div class="top"><span class="mut" style="margin-right:auto">Signed HTTPS callbacks (HMAC-SHA256) with automatic retries.</span><button class="b p" data-x2="hnew">+ Create webhook</button></div><div class="card wrap">' + (!h.length ? '<div class="empty">No webhooks yet.</div>' : '<table><tr><th>URL</th><th>Events</th><th>Status</th><th>Last delivery</th><th>Failures</th><th></th></tr>' + h.map(x => '<tr><td>' + esc(x.url) + '</td><td>' + esc(x.events.join(', ')) + '</td><td>' + (x.active ? 'Active' : 'Paused') + '</td><td>' + dt(x.lastDeliveryAt) + '</td><td>' + x.failureCount + '</td><td><button class="b mini" data-x2="htog" data-i="' + x.id + '" data-a="' + (x.active ? '1' : '') + '">' + (x.active ? 'Pause' : 'Activate') + '</button> <button class="b mini" data-x2="htest" data-i="' + x.id + '">Test</button> <button class="b mini" data-x2="hlog" data-i="' + x.id + '">History</button> <button class="b mini" data-x2="hrot" data-i="' + x.id + '">New secret</button> <button class="b mini" data-x2="hdel" data-i="' + x.id + '">Delete</button></td></tr>').join('') + '</table>') + '</div>';
    } catch (e) { tabErr(e, 'settings'); }
  }
  async function hookDlg() {
    let ev = []; try { ev = (await api('/webhooks/events')).data; } catch { /* fall back to all events */ }
    adlg('Create webhook', '<label>Endpoint URL (https)<input id="axhu" placeholder="https://example.com/dms-webhook"></label><label class="row"><input type="checkbox" id="axha" checked> <span style="width:auto">All events</span></label>' + ev.map(x => '<label class="row"><input type="checkbox" class="axhe" value="' + x + '"> <span style="width:auto">' + x + '</span></label>').join(''), 'Create webhook', async () => {
      const url = g('axhu').value.trim(); if (!/^https?:\/\/.+/.test(url)) throw new ApiError(0, 'VALIDATION_ERROR', 'Enter a valid URL starting with https://');
      const events = g('axha').checked ? ['*'] : [...document.querySelectorAll('.axhe:checked')].map(c => c.value); if (!events.length) throw new ApiError(0, 'VALIDATION_ERROR', 'Choose at least one event.');
      const r = (await api('/webhooks', { method: 'POST', body: { url, events } })).data; q$('#dlg').close(); secretDlg('Webhook signing secret', r.secret); tabHooks();
    });
  }

  // ------------------------------------------------------------------ Google Sheets (Settings -> Integrations for admins, own menu item for managers)
  const GS = { picked: null, tabs: null, list: null };
  const GREASON = { INVALID_REQUEST: 'The sign-in link was invalid or expired. Please try again.', GOOGLE_ERROR: 'Google reported a problem. Please try again.', REDIRECT_URI_MISMATCH: 'The redirect address registered in Google Cloud does not match this server.', INVALID_CLIENT: 'The Google client ID or secret on the server is wrong.', INVALID_STATE: 'That sign-in attempt expired. Please start again.' };
  async function googleApi() { const gen = AS.gen; g('view').innerHTML = '<div id="axtab">' + skel(4) + '</div>'; if (gen === AS.gen) return googlePanel(g('axtab')); }
  async function googlePanel(box) {
    if (!has('integrations.view')) { box.innerHTML = '<div class="card empty"><b>Unauthorized</b><br>Your role does not have permission to open this page.</div>'; return; }
    const gen = AS.gen, mg = has('integrations.manage'); let d, logs = [];
    try { d = (await api('/integrations/google')).data; if (d.connection && d.connection.status === 'active') logs = (await api('/integrations/google/sync-logs?limit=8')).data; } catch (e) { box.innerHTML = errCard(e, S.view === 'sheets' ? 'sheets' : 'settings'); return; }
    if (gen !== AS.gen || !g(box.id || 'axtab')) return; const c = d.connection;
    const row = (a, b) => '<div class="row"><span style="width:170px">' + a + '</span><b style="width:auto">' + b + '</b></div>';
    let h = '<div class="card" style="max-width:720px"><h3>Google Sheets</h3><p class="mut">Order reports are written to your own spreadsheet. DMS stays the source of truth.</p>';
    if (!d.configuredOnServer) h += '<div class="axerr">Google Sheets is not configured on the server yet. The administrator must set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.</div>';
    else if (!c || !c.hasTokens) h += '<p>No Google account is connected.</p>' + (mg ? '<button class="b p" data-x2="gconnect">Connect Google Account</button>' : '<p class="mut">Ask your Business Admin to connect Google.</p>');
    else {
      h += row('Connected account', esc(c.googleEmail || '—')) + row('Spreadsheet', c.spreadsheetId ? esc(c.spreadsheetName || c.spreadsheetId) : 'Not selected') + row('Worksheet', c.spreadsheetId ? esc(c.sheetName) : '—') + row('Auto sync', c.syncEnabled ? 'Enabled' : 'Off') + row('Sync status', esc(c.syncStatus || '—')) + row('Last sync', c.lastSyncAt ? dt(c.lastSyncAt) : 'Never') + (c.counts ? row('Rows synced / pending / failed', c.counts.synced + ' / ' + c.counts.pending + ' / ' + c.counts.failed) : '') + (c.lastError ? '<div class="axerr" role="alert">' + esc(c.lastError) + '</div>' : '');
      if (mg) {
        h += '<p>' + (c.spreadsheetId ? '<button class="b" data-x2="gtest">Test connection</button> ' + (c.syncEnabled ? '<button class="b" data-x2="goff">Disable auto sync</button>' : '<button class="b p" data-x2="gon">Enable auto sync</button>') + ' <button class="b" data-x2="gsync" id="axgsync">Sync now</button> ' : '') + '<button class="b" data-x2="gpick">' + (c.spreadsheetId ? 'Change spreadsheet' : 'Select spreadsheet') + '</button> <button class="b" data-x2="gconnect">Reconnect</button> <button class="b" data-x2="gdisc">Disconnect Google Account</button></p><div id="axgs"></div><div id="axgmsg" class="mut" role="status"></div>';
      }
    }
    h += '</div>';
    if (logs.length) h += '<div class="card wrap" style="max-width:720px"><h3>Recent sync activity</h3><table><tr><th>Order</th><th>Status</th><th>Attempts</th><th>Detail</th></tr>' + logs.map(l => '<tr><td>' + esc(l.invoice_number || '—') + '</td><td>' + esc(l.sync_status) + '</td><td>' + l.attempts + '</td><td>' + esc(l.error_message || '') + '</td></tr>').join('') + '</table></div>';
    box.innerHTML = h; post(); if (S.view === 'sheets') box.removeAttribute('id'), box.id = 'axtab';
  }
  async function gPicker() {
    const box = g('axgs'); if (!box) return; box.innerHTML = skel(2);
    try {
      const d = (await api('/integrations/google')).data.connection;
      if (d.canListSpreadsheets) { GS.list = (await api('/integrations/google/spreadsheets')).data; box.innerHTML = '<label>Spreadsheet<select id="axgsel"><option value="">Choose…</option>' + GS.list.map(x => '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>').join('') + '</select></label><div id="axgws"></div>'; }
      else box.innerHTML = '<label>Spreadsheet link or ID<input id="axgin" placeholder="https://docs.google.com/spreadsheets/d/…"></label><button class="b" data-x2="gload">Load worksheets</button><div id="axgws"></div>';
    } catch (e) { box.innerHTML = '<div class="axerr">' + esc(msgOf(e)) + '</div>'; }
  }
  async function gTabs(id) {
    const box = g('axgws'); if (!box || !id) return; box.innerHTML = skel(2);
    try { const t = (await api('/integrations/google/spreadsheets/' + encodeURIComponent(id) + '/sheets')).data; GS.picked = id; box.innerHTML = '<label>Worksheet in “' + esc(t.title) + '”<select id="axgtab">' + t.sheets.map(s => '<option>' + esc(s.title) + '</option>').join('') + '</select></label><button class="b p" data-x2="gsel">Use this worksheet</button>'; }
    catch (e) { box.innerHTML = '<div class="axerr">' + esc(msgOf(e)) + '</div>'; }
  }
  async function gSelect(overwrite) {
    const msg = g('axgmsg'); try { await api('/integrations/google/sheet', { method: 'PUT', body: { spreadsheetId: GS.picked, sheetName: g('axgtab').value, overwriteHeader: !!overwrite } }); toast('Google Sheet selected'); googleRefresh(); }
    catch (e) { if (e.code === 'HEADER_MISMATCH') confirmD(esc(e.message), () => gSelect(true), 'Replace header'); else if (msg) msg.textContent = msgOf(e); else toast(msgOf(e)); }
  }
  const googleRefresh = () => (S.view === 'sheets' ? googleApi() : loadTab());
  window.googleReturn = function () {                 // the browser comes back from Google to /settings/integrations?google=...
    const r = pendingGoogle; if (!r) return; pendingGoogle = null;
    const m = r.s === 'connected' ? 'Google account connected. Now choose a spreadsheet.' : r.s === 'cancelled' ? 'Google connection cancelled.' : (GREASON[r.reason] || 'Google connection failed' + (r.reason ? ' (' + r.reason + ')' : ''));
    if (S.role === 'admin' && has('integrations.view')) { SET.tab = 'google'; S.view = 'settings'; } else if (S.role === 'manager' && has('integrations.view')) S.view = 'sheets'; render(); setTimeout(() => toast(m), 50);
  };
  let pendingGoogle = null; try { const q2 = new URLSearchParams(location.search); if (q2.get('google')) { pendingGoogle = { s: q2.get('google'), reason: q2.get('reason') }; history.replaceState(null, '', '/'); } } catch { /* ignore */ }

  document.addEventListener('input', e => { if (e.target.id === 'axsq') { clearTimeout(qTimer); qTimer = setTimeout(() => { SF.q = e.target.value.trim(); SF.pg = 1; staffApi(); }, 300); } });
  document.addEventListener('change', async e => {
    const t = e.target; if (t.id === 'axsr') { SF.role = t.value; SF.pg = 1; staffApi(); } else if (t.id === 'axgsel') gTabs(t.value);
  });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-x2]'); if (!t) return; const x = t.dataset.x2, id = t.dataset.i, rowU = () => SF.rows.find(u => u.id === id), msg = () => g('axgmsg');
    const run = async (fn, ok2) => { t.disabled = true; try { const r = await fn(); if (ok2) toast(typeof ok2 === 'function' ? ok2(r) : ok2); } catch (er) { toast(msgOf(er)); } t.disabled = false; };
    if (x === 'nread') { await run(() => api('/notifications/read-all', { method: 'POST' }), 'All marked read'); unreadN = 0; notifApi(); }
    else if (x === 'nrd') { await run(() => api('/notifications/' + id + '/read', { method: 'POST' })); refreshBell(); notifApi(); }
    else if (x === 'snew') staffDlg(null); else if (x === 'sedit') staffDlg(rowU()); else if (x === 'spg') { SF.pg = Math.max(1, SF.pg + +t.dataset.d); staffApi(); }
    else if (x === 'stog') { const u = rowU(); await run(() => api('/users/' + id, { method: 'PATCH', body: { status: u.status === 'active' ? 'inactive' : 'active' } }), 'Staff updated'); staffApi(); }
    else if (x === 'spw') adlg('Reset password · ' + esc(rowU().name), '<label>New password (8+ chars, a capital letter and a number)<input id="axnp" type="password" autocomplete="new-password"></label><p class="mut">The person is signed out everywhere.</p>', 'Reset password', async () => { await api('/users/' + id + '/reset-password', { method: 'POST', body: { newPassword: g('axnp').value } }); toast('Password reset'); });
    else if (x === 'sdel') confirmD('Delete ' + esc(rowU().name) + '? They lose access immediately; their history is kept.', async () => { try { await api('/users/' + id, { method: 'DELETE' }); toast('Staff deleted'); } catch (er) { toast(msgOf(er)); } staffApi(); }, 'Delete');
    else if (x === 'srights') rightsDlg(id);
    else if (x === 'stab') { SET.tab = t.dataset.t2; settingsApi(); }
    else if (x === 'bsave') saveBusiness(t); else if (x === 'osv') saveOps(t);
    else if (x === 'knew') keyDlg(); else if (x === 'krev') confirmD('Revoke the key “' + esc(t.dataset.n) + '”? Systems using it stop working immediately.', async () => { try { await api('/api-keys/' + id, { method: 'DELETE' }); toast('API key revoked'); } catch (er) { toast(msgOf(er)); } tabKeys(); }, 'Revoke');
    else if (x === 'hnew') hookDlg();
    else if (x === 'htog') { await run(() => api('/webhooks/' + id, { method: 'PATCH', body: { active: !t.dataset.a } }), 'Webhook updated'); tabHooks(); }
    else if (x === 'htest') await run(() => api('/webhooks/' + id + '/test', { method: 'POST' }), r => 'Test: ' + r.data.status + (r.data.response_status ? ' (HTTP ' + r.data.response_status + ')' : r.data.error_message ? ' - ' + r.data.error_message : ''));
    else if (x === 'hrot') confirmD('Create a new signing secret? The old one stops working.', async () => { try { const r = (await api('/webhooks/' + id + '/rotate-secret', { method: 'POST' })).data; secretDlg('New signing secret', r.secret); } catch (er) { toast(msgOf(er)); } }, 'Create secret');
    else if (x === 'hdel') confirmD('Delete this webhook?', async () => { try { await api('/webhooks/' + id, { method: 'DELETE' }); toast('Webhook deleted'); } catch (er) { toast(msgOf(er)); } tabHooks(); }, 'Delete');
    else if (x === 'hlog') { try { const r = (await api('/webhooks/' + id + '/deliveries?limit=10')).data; adlg('Delivery history', r.length ? '<div class="wrap"><table><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>When</th></tr>' + r.map(d => '<tr><td>' + esc(d.event) + '</td><td>' + esc(d.status) + '</td><td>' + d.attempts + '</td><td>' + (d.response_status || esc(d.error_message || '—')) + '</td><td>' + dt(d.created_at) + '</td></tr>').join('') + '</table></div>' : '<div class="empty">No deliveries yet.</div>', null); } catch (er) { toast(msgOf(er)); } }
    else if (x === 'gconnect') { t.disabled = true; try { location.href = (await api('/integrations/google/auth-url')).data.url; } catch (er) { toast(msgOf(er)); t.disabled = false; } }
    else if (x === 'gpick') gPicker(); else if (x === 'gload') { const v = g('axgin').value.trim(); if (v) gTabs(v); } else if (x === 'gsel') gSelect(false);
    else if (x === 'gtest') { if (msg()) msg().textContent = 'Testing…'; await run(async () => { const r = (await api('/integrations/google/test', { method: 'POST' })).data; const ok3 = '✓ Google Sheet Connected: ' + r.spreadsheet + ' / ' + r.worksheet; await googleRefresh(); if (msg()) msg().textContent = ok3; }); }
    else if (x === 'gon') adlg('Enable auto sync', '<p>What should happen with the orders you already have?</p><label class="row"><input type="radio" name="axim" value="existing" checked> <span style="width:auto">Sync existing Order Reports</span></label><label class="row"><input type="radio" name="axim" value="new_only"> <span style="width:auto">Start with new orders only</span></label>', 'Enable', async () => { await api('/integrations/google/auto-sync', { method: 'POST', body: { enabled: true, initialSync: q$('input[name=axim]:checked').value } }); toast('Auto sync enabled'); googleRefresh(); });
    else if (x === 'goff') { await run(() => api('/integrations/google/auto-sync', { method: 'POST', body: { enabled: false } }), 'Auto sync disabled'); googleRefresh(); }
    else if (x === 'gsync') { if (msg()) msg().textContent = 'Syncing…'; t.disabled = true; let out = ''; try { const r = await api('/integrations/google/sync', { method: 'POST' }); out = r.message + (r.data.failed ? ' · ' + r.data.failed + ' failed' : ''); toast(r.message); } catch (er) { out = msgOf(er); } await googleRefresh(); if (msg()) msg().textContent = out; }
    else if (x === 'gdisc') confirmD('Disconnect the Google account? Syncing stops and the stored Google access is removed. Your spreadsheet is not deleted.', async () => { try { await api('/integrations/google', { method: 'DELETE' }); toast('Google account disconnected'); } catch (er) { toast(msgOf(er)); } googleRefresh(); }, 'Disconnect');
  });

  // ------------------------------------------------------------------ view table + events
  const CONN = new Set(['notif', 'staff', 'settings', 'sheets', 'odash', 'biz', 'obiz', 'onboard', 'users', 'subs', 'plans', 'rights', 'dash', 'orders', 'returns', 'cod', 'reports', 'home', 'deliv', 'cur', 'hist', 'account']);
  Object.keys(V).forEach(k => { if (!CONN.has(k)) V[k] = () => notConnected(k); });
  Object.assign(V, { dash: dashApi, orders: ordersApi, returns: returnsApi, account: accApi, home: () => partnerView('home'), cod: codApi, reports: () => S.role === 'owner' ? ownerReports() : reportsApi(), notif: notifApi, staff: staffApi, settings: () => S.role === 'owner' ? notConnected('sys') : settingsApi(), sheets: googleApi, odash: ownerDash, biz: ownerBiz, obiz: ownerOverview, onboard: ownerOnboard, users: ownerUsers, subs: ownerSubs, plans: ownerPlans, rights: ownerRights, deliv: () => partnerView('deliv'), cur: () => partnerView('cur'), hist: () => partnerView('hist') });

  document.addEventListener('input', e => { if (e.target.id === 'axq') { clearTimeout(qTimer); qTimer = setTimeout(() => { O.q = e.target.value.trim(); O.pg = 1; loadOrders(); }, 300); } });
  document.addEventListener('change', async e => {
    const t = e.target, x = t.dataset.x2;
    if (t.id === 'axst') { O.st = t.value; O.pg = 1; loadOrders(); } else if (t.id === 'axpf') { O.pf = t.value; O.pg = 1; loadOrders(); }
    else if (x === 'assign' && t.value) { const id = t.dataset.i, pid = t.value, re = t.getAttribute('aria-label').startsWith('Reassign'); t.disabled = true; await mutate(re ? 'Delivery reassigned' : 'Order assigned', () => api('/orders/' + id + '/assign', { method: 'POST', body: { partnerId: pid, reason: re ? 'Reassigned from dashboard' : undefined } })); }
  });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-x2]'); if (!t) return; const x = t.dataset.x2, id = t.dataset.i;
    if (x.startsWith('retry-')) { const w = x.slice(6); ({ dash: dashApi, orders: loadOrders, phome: () => partnerView('home'), cod: codApi, reports: reportsApi, notif: notifApi, staff: staffApi, settings: settingsApi, sheets: googleApi, oreports: ownerReports, odash: ownerDash, biz: ownerBiz, obiz: ownerOverview, onboard: ownerOnboard, users: ownerUsers, subs: ownerSubs, plans: ownerPlans, rights: ownerRights, pdeliv: () => partnerView('deliv'), pcur: () => partnerView('cur'), phist: () => partnerView('hist') }[w] || (() => {}))(); }
    else if (x === 'kpi') { O.st = t.dataset.st; O.pg = 1; O.q = ''; O.pf = ''; S.view = 'orders'; render(); }
    else if (x === 'new') { adlg('New order', orderForm(null), 'Create order', async () => { const r = await api('/orders', { method: 'POST', body: readForm(false) }); toast('Order created: ' + r.data.invoice_number); O.pg = 1; await Promise.all([loadOrders(), loadPartners()]); }); window.axCalc(); }
    else if (x === 'edit') { const o = row(id); adlg('Edit order', orderForm(o), 'Save changes', async () => { await api('/orders/' + id, { method: 'PATCH', body: readForm(true) }); toast('Order updated'); await loadOrders(); }); window.axCalc(); }
    else if (x === 'view') viewOrder(id);
    else if (x === 'ready') mutate('Order marked ready', () => api('/orders/' + id + '/ready', { method: 'POST' }));
    else if (x === 'retry') mutate('Order ready for another attempt', () => api('/orders/' + id + '/retry', { method: 'POST' }));
    else if (x === 'cancel') confirmD('Cancel order ' + esc(row(id).invoice_number) + '? This cannot be undone.', () => mutate('Order cancelled', () => api('/orders/' + id + '/cancel', { method: 'POST' })), 'Cancel order');
    else if (x === 'verify') verifyDlg(row(id));
    else if (x === 'pg') { O.pg = Math.max(1, O.pg + +t.dataset.d); loadOrders(); }
    else if (x === 'hpg') { P.hpg = Math.max(1, P.hpg + +t.dataset.d); partnerView('hist'); }
    else if (x === 'refresh') partnerView(S.view);
    else if (x === 'duty') { t.disabled = true; try { const r = await api('/me/duty', { method: 'POST', body: { on: !AS.user.dutyOn } }); AS.user.dutyOn = r.data.dutyOn ?? r.data.duty_on ?? !AS.user.dutyOn; toast('Duty ' + (AS.user.dutyOn ? 'ON' : 'OFF')); } catch (er) { toast(msgOf(er)); } partnerView(S.view); }
    else if (x === 'act') { const a = t.dataset.a; t.disabled = true; try { await api('/deliveries/' + id + '/' + a, { method: 'POST', body: await getPos() }); toast({ accept: 'Accepted', reject: 'Rejected', pickup: 'Picked up', start: 'Out for delivery', arrive: 'Marked arrived' }[a]); } catch (er) { toast(msgOf(er)); } partnerView(S.view); }
    else if (x === 'out') { const o = P.active.find(v => v.id === id); outcomeDlg(o, t.dataset.k); }
    else if (x === 'pw') {
      const a = g('axp0').value, n = g('axp1').value, c = g('axp2').value, er = g('axpe'); er.textContent = '';
      if (!a) er.textContent = 'Enter your current password.'; else if (!/^(?=.*[A-Z])(?=.*\d).{8,}$/.test(n)) er.textContent = 'New password needs 8+ characters, a capital letter and a number.'; else if (n !== c) er.textContent = 'Passwords do not match.';
      else { t.disabled = true; try { await api('/auth/change-password', { method: 'POST', body: { currentPassword: a, newPassword: n } }); toast('Password updated'); accApi(); } catch (err) { er.textContent = msgOf(err); t.disabled = false; } }
    }
  });

  // restore a session after a page reload (refresh token lives in sessionStorage only; the access token stays in memory)
  (async () => {
    if (!getRT()) return;
    if (await refresh()) { try { enterApp((await raw('/auth/me')).data); } catch { hardLogout(''); } } else setRT(null);
  })();
  // New assignments reach the partner without a manual reload: refresh the partner's list every 20 s while the tab is visible and no dialog is open.
  setInterval(() => { if (AS.user && S.role === 'partner' && ['home', 'deliv', 'cur'].includes(S.view) && !document.hidden && !(g('dlg') && g('dlg').hasAttribute('open'))) partnerView(S.view); }, 20000);
  window.__dms = { api, AS, T, exportReport, RP, ownerExport, OW };
})();
