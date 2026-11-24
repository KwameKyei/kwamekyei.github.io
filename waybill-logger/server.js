// Waybill Logger: local web server. Run with `npm start` and open http://localhost:3000
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWaybill, describeError, MODEL, EFFORT } from './lib/extract.js';
import {
  ensureDirs, getSettings, saveSettings, getHistory, saveHistory, listHistoryDays,
  imagePath, detectMediaType,
} from './lib/store.js';
import { inspectWorkbook, appendToWorkbook, exportWorkbook } from './lib/workbook.js';
import { createAuth } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000; // PORT=0 picks a free port
const HOST = process.env.HOST || '0.0.0.0';

const ON_RENDER = !!process.env.RENDER;
const auth = createAuth();
if ((ON_RENDER || process.env.REQUIRE_PIN === '1') && !auth.required) {
  console.error('ACCESS_PIN is not set. Refusing to start on a public host without a PIN.');
  process.exit(1);
}
if (auth.required && String(process.env.ACCESS_PIN).trim().length < 6) {
  console.warn('WARNING: ACCESS_PIN is shorter than 6 characters. Use a longer PIN on a public host.');
}

const app = express();
// Behind Render's (or any) HTTPS proxy: trust X-Forwarded-* so req.ip and req.secure are right.
if (ON_RENDER || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/session', auth.session);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.use(auth.middleware);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Claude accepts images up to 5 MB (base64). The browser downsizes photos first, so this is a backstop.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function runExtraction(id, buf, res) {
  const mediaType = detectMediaType(buf);
  if (!mediaType) return res.status(400).json({ error: 'Unsupported image type. Use JPEG, PNG or WebP.' });
  if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Image is larger than 5 MB.' });
  const started = Date.now();
  try {
    const { extraction, model, usage } = await extractWaybill(buf, mediaType);
    res.json({ id, extraction, model, usage, ms: Date.now() - started, imageUrl: `/api/images/${id}` });
  } catch (err) {
    const { status, message } = describeError(err);
    console.error(`[extract ${id}]`, message);
    res.status(status).json({ id, error: message, imageUrl: `/api/images/${id}` });
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    effort: EFFORT,
    hasKey: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    mock: process.env.MOCK_EXTRACTION === '1',
    pin: auth.required,
  });
});

// Upload one image and read it.
app.post('/api/extract', upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (field "image").' });
  const id = /^[A-Za-z0-9_-]{6,64}$/.test(req.body?.id || '') ? req.body.id : crypto.randomUUID();
  await fs.writeFile(imagePath(id), req.file.buffer);
  await runExtraction(id, req.file.buffer, res);
}));

// Re-run a stored image.
app.post('/api/extract/:id/rerun', wrap(async (req, res) => {
  let buf;
  try {
    buf = await fs.readFile(imagePath(req.params.id));
  } catch {
    return res.status(404).json({ error: 'The stored image for this row was not found. Upload it again.' });
  }
  await runExtraction(req.params.id, buf, res);
}));

app.get('/api/images/:id', wrap(async (req, res) => {
  let buf;
  try {
    buf = await fs.readFile(imagePath(req.params.id));
  } catch {
    return res.status(404).end();
  }
  res.type(detectMediaType(buf) || 'application/octet-stream').send(buf);
}));

app.get('/api/settings', wrap(async (req, res) => res.json(await getSettings())));
app.put('/api/settings', wrap(async (req, res) => res.json(await saveSettings(req.body))));

app.get('/api/history', wrap(async (req, res) => res.json({ days: await listHistoryDays() })));
app.get('/api/history/:day', wrap(async (req, res) => res.json(await getHistory(req.params.day))));
app.put('/api/history/:day', wrap(async (req, res) => res.json(await saveHistory(req.params.day, req.body))));

app.post('/api/workbook/inspect', upload.single('workbook'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No workbook uploaded.' });
  res.json(await inspectWorkbook(req.file.buffer));
}));

function safeFileName(name, fallback) {
  const n = String(name || '').replace(/[^\w .()-]+/g, '_').trim();
  return n || fallback;
}

app.post('/api/workbook/append', upload.single('workbook'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No workbook uploaded.' });
  const rows = JSON.parse(req.body.rows || '[]');
  if (!rows.length) return res.status(400).json({ error: 'No rows to append.' });
  const year = Number(req.body.year) || new Date().getFullYear();
  const result = await appendToWorkbook(req.file.buffer, req.body.sheet, rows, { year });
  const name = safeFileName(req.file.originalname, 'workbook.xlsx');
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}"`,
    'X-Appended-Rows': `${result.firstRow}-${result.lastRow}`,
    'X-Positional': String(result.positional),
  });
  res.send(result.buffer);
}));

app.post('/api/export', wrap(async (req, res) => {
  const rows = req.body?.rows || [];
  const sheet = String(req.body?.sheet || 'Waybills');
  const buf = await exportWorkbook(rows, sheet);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${safeFileName(`waybills-${sheet}.xlsx`, 'waybills.xlsx')}"`,
  });
  res.send(buf);
}));

app.use((err, req, res, next) => {
  const status = err.status || (err instanceof SyntaxError ? 400 : 500);
  console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

await ensureDirs();
const server = app.listen(PORT, HOST, () => {
  const port = server.address().port;
  console.log(`\nWaybill Logger is running.`);
  console.log(`  On this PC:     http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On your phone:  http://${a.address}:${port}  (same Wi-Fi)`);
    }
  }
  if (process.env.MOCK_EXTRACTION === '1') console.log('  MOCK_EXTRACTION=1: images are NOT sent to Claude; sample data is returned.');
  else if (!process.env.ANTHROPIC_API_KEY) console.log('  WARNING: ANTHROPIC_API_KEY is not set. Add it to .env');
  console.log(`  PIN: ${auth.required ? 'required' : 'off (set ACCESS_PIN in .env to require one)'}`);
  console.log(`  Model: ${MODEL} (effort ${EFFORT})\n`);
});
