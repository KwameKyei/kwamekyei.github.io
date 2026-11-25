// Waybill Logger: local web server. Run with `npm start` and open http://localhost:3000
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWaybill, describeError, MODEL, EFFORT, ESCALATE_MODEL, ESCALATE_EFFORT } from './lib/extract.js';
import {
  ensureDirs, getSettings, saveSettings, getHistory, saveHistory, listHistoryDays,
  imagePath, detectMediaType, DATA_DIR,
} from './lib/store.js';
import { logUsage, usageSummary } from './lib/usage.js';
import { inspectWorkbook, appendToWorkbook, exportWorkbook } from './lib/workbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000; // PORT=0 picks a free port
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Claude accepts images up to 5 MB (base64). The browser downsizes photos first, so this is a backstop.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Same photo uploaded again (same bytes, same model settings) -> reuse the earlier reading for free.
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CONFIG_KEY = `${MODEL}:${EFFORT}>${ESCALATE_MODEL || '-'}:${ESCALATE_EFFORT}`;
const cacheFile = (buf) => path.join(CACHE_DIR, `${crypto.createHash('sha256').update(buf).digest('hex')}.json`);

async function readCache(buf) {
  try {
    const c = JSON.parse(await fs.readFile(cacheFile(buf), 'utf8'));
    return c.config === CONFIG_KEY && process.env.MOCK_EXTRACTION !== '1' ? c : null;
  } catch {
    return null;
  }
}

async function runExtraction(id, buf, res, { useCache = true } = {}) {
  const mediaType = detectMediaType(buf);
  if (!mediaType) return res.status(400).json({ error: 'Unsupported image type. Use JPEG, PNG or WebP.' });
  if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Image is larger than 5 MB.' });
  const started = Date.now();
  if (useCache) {
    const hit = await readCache(buf);
    if (hit) {
      await logUsage({ id, cached: true, model: hit.model, cost: 0 });
      return res.json({ id, extraction: hit.extraction, model: hit.model, cached: true, cost: 0, ms: Date.now() - started, imageUrl: `/api/images/${id}` });
    }
  }
  try {
    const onPass = (p) => logUsage({ id, stage: p.stage, model: p.model, effort: p.effort, usage: p.usage, cost: p.cost, reasons: p.reasons, error: p.error });
    const { extraction, model, usage, cost, passes } = await extractWaybill(buf, mediaType, { onPass });
    if (process.env.MOCK_EXTRACTION !== '1') {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cacheFile(buf), JSON.stringify({ config: CONFIG_KEY, model, extraction, savedAt: new Date().toISOString() }));
    }
    const escalated = passes.some((p) => p.stage === 'escalation');
    res.json({ id, extraction, model, usage, cost, escalated, ms: Date.now() - started, imageUrl: `/api/images/${id}` });
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
    escalateModel: ESCALATE_MODEL,
    escalateEffort: ESCALATE_EFFORT,
    hasKey: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    mock: process.env.MOCK_EXTRACTION === '1',
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
  await runExtraction(req.params.id, buf, res, { useCache: false });
}));

app.get('/api/usage', wrap(async (req, res) => res.json(await usageSummary(req.query.day || undefined))));

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
  console.log(`  Model: ${MODEL} (effort ${EFFORT})${ESCALATE_MODEL ? `, re-checks with ${ESCALATE_MODEL} (effort ${ESCALATE_EFFORT})` : ''}\n`);
});
