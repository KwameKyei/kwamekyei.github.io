// PIN protection: API locked until the right PIN is entered; brute force is throttled.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, spawnServer } from './helpers.js';

let proc;
let BASE;
let dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waybill-auth-'));
  ({ proc, base: BASE } = await startServer({ DATA_DIR: dataDir, ACCESS_PIN: '482913', SESSION_SECRET: 'test-secret' }));
});
after(async () => {
  proc?.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const post = (url, body, headers = {}) =>
  fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('API is locked without the PIN, the page and health check are not', async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
  const r = await fetch(`${BASE}/api/settings`);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).needPin, true);
  assert.deepEqual(await (await fetch(`${BASE}/api/session`)).json(), { required: true, ok: false });
  assert.equal((await fetch(`${BASE}/api/images/abcdef123`)).status, 401);
});

test('correct PIN sets a cookie that unlocks the API; a forged cookie does not', async () => {
  const r = await post('/api/login', { pin: '482913' });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /wl_auth=.+; Path=\/; HttpOnly; SameSite=Lax/);
  const value = cookie.split(';')[0];
  assert.equal((await fetch(`${BASE}/api/settings`, { headers: { cookie: value } })).status, 200);
  assert.deepEqual(await (await fetch(`${BASE}/api/session`, { headers: { cookie: value } })).json(), { required: true, ok: true });
  assert.equal((await fetch(`${BASE}/api/settings`, { headers: { cookie: 'wl_auth=forged' } })).status, 401);
});

test('wrong PINs are throttled after 5 attempts, even before the right one', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { pin: '000000' })).status, 401);
  const blocked = await post('/api/login', { pin: '482913' });
  assert.equal(blocked.status, 429);
});

test('refuses to start on Render without a PIN', async () => {
  const p = spawnServer({ DATA_DIR: dataDir, RENDER: 'true' });
  const code = await new Promise((resolve) => p.on('exit', resolve));
  assert.equal(code, 1);
});
