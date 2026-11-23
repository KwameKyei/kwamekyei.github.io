// End-to-end: start the server in mock mode and exercise the HTTP API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dataDir;

// Smallest valid JPEG header is enough for type sniffing in mock mode.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waybill-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MOCK_EXTRACTION: '1', DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(async () => {
  proc?.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('extract, rerun, image, settings and history round trip', async () => {
  const fd = new FormData();
  fd.append('id', 'testrow01');
  fd.append('image', new Blob([JPEG], { type: 'image/jpeg' }), 'a.jpg');
  const r = await (await fetch(`${BASE}/api/extract`, { method: 'POST', body: fd })).json();
  assert.equal(r.id, 'testrow01');
  assert.equal(r.extraction.waybill_no, 'SORL00061973');

  const again = await (await fetch(`${BASE}/api/extract/testrow01/rerun`, { method: 'POST' })).json();
  assert.equal(again.extraction.waybill_no, 'SORL00061970');

  const img = await fetch(`${BASE}/api/images/testrow01`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');

  const bad = new FormData();
  bad.append('image', new Blob([Buffer.from('not an image at all')]), 'x.txt');
  assert.equal((await fetch(`${BASE}/api/extract`, { method: 'POST', body: bad })).status, 400);

  const s = await (await fetch(`${BASE}/api/settings`)).json();
  assert.equal(s.products['GASOIL 50PPM'], 'AGO');
  s.companies['NEWCO ENERGY GHANA LIMITED'] = 'NEWCO';
  await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
  assert.equal((await (await fetch(`${BASE}/api/settings`)).json()).companies['NEWCO ENERGY GHANA LIMITED'], 'NEWCO');

  await fetch(`${BASE}/api/history/2026-11-23`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startNo: 12, rows: [{ id: 'testrow01' }] }) });
  const h = await (await fetch(`${BASE}/api/history/2026-11-23`)).json();
  assert.equal(h.startNo, 12);
  assert.deepEqual((await (await fetch(`${BASE}/api/history`)).json()).days, ['2026-11-23']);
  assert.equal((await fetch(`${BASE}/api/history/..%2Fx`)).status, 400);
});
