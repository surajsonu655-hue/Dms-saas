import { afterAll, beforeAll, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { buildWorld, closeDb, type World } from './helpers.js';
import { openApp, until } from './uiHelper.js';
let W: World, base = '', server: any;
beforeAll(async () => { W = await buildWorld(); server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { server?.close(); await closeDb(); });
it('dbg', async () => {
  const ui = await openApp(base); await ui.signIn('admin@alpha.test'); ui.go('settings'); await until(() => ui.$('[data-x2="stab"][data-t2="keys"]'), 'tabs');
  console.log('tabs=', [...ui.d.querySelectorAll('[data-x2="stab"]')].map((b: any) => b.dataset.t2).join());
  ui.click('[data-x2="stab"][data-t2="keys"]'); await new Promise(r => setTimeout(r, 1500));
  console.log('tab text=', (ui.$('#axtab')?.textContent ?? 'NO AXTAB').slice(0, 200), '| view=', ui.view().slice(0, 150), '| errors=', ui.errors.slice(0, 2));
});
