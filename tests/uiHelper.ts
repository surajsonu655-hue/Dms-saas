import jsdomPkg from 'jsdom';
import { webcrypto } from 'node:crypto';
import { png } from './helpers.js';
const { JSDOM, VirtualConsole } = jsdomPkg as any;

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until(fn: () => any, what = 'condition', ms = 12000) {
  const t = Date.now(); let last: any;
  while (Date.now() - t < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(25); }
  throw new Error('Timed out waiting for ' + what + (last instanceof Error ? ': ' + last.message : ''));
}
/** Opens the REAL frontend exactly as the backend serves it (page script, then the API-mode layer) inside jsdom. */
export async function openApp(base: string) {
  const errors: string[] = [], vc = new VirtualConsole(); vc.on('jsdomError', (e: any) => errors.push(String(e.message)));
  const html = (await (await fetch(base + '/')).text()).replace(/<script src="[^"]*"><\/script>/g, '');
  const apiJs = await (await fetch(base + '/dms-api-mode.js')).text();
  const dom = new JSDOM(html, {
    url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w: any) {
      Object.defineProperty(w, 'crypto', { value: webcrypto });
      w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
      w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
      w.fetch = (u: string, o: any) => fetch(new URL(u, base), o); w.FormData = FormData; w.Blob = Blob; w.File = File; w.scrollTo = () => {};
    },
  });
  dom.window.eval(apiJs);
  const w: any = dom.window, d = w.document, $ = (s: string) => d.querySelector(s) as any;
  const ui = {
    w, d, $, errors, ev: (c: string) => w.eval(c),
    text: () => { const c = d.body.cloneNode(true) as any; c.querySelectorAll('script,style').forEach((n: any) => n.remove()); return c.textContent.replace(/\s+/g, ' '); }, view: () => ($('#view')?.textContent ?? '').replace(/\s+/g, ' '),
    type(sel: string, v: string) { const el = $(sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    click(sel: any) { const el = typeof sel === 'string' ? $(sel) : sel; if (!el) throw new Error('no element ' + sel); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); },
    select(el: any, v: string) { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    file(sel: string) { Object.defineProperty($(sel), 'files', { value: [new File([png], 'proof.png', { type: 'image/png' })], configurable: true }); },
    nav: () => [...d.querySelectorAll('nav button[data-v]')].map((b: any) => b.textContent.trim()),
    navKeys: () => [...d.querySelectorAll('nav button[data-v]')].map((b: any) => b.dataset.v as string),
    async signIn(email: string, pw = 'Demo@1234') {
      ui.type('#le', email); ui.type('#lp', pw);
      $('#lf').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
      await until(() => ui.ev('S.user') && $('#login').hidden, 'sign-in as ' + email);
    },
    go(view: string) { w.eval(`S.view='${view}';render()`); },
    close: () => dom.window.close(),
  };
  return ui;
}
