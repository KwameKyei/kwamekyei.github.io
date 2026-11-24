// Compare model settings on your own photos, using your filled-in spreadsheet as the answer key.
//
// Usage:
//   npm run compare -- --photos test\images --truth "C:\path\LOADING NOV.xlsx" ^
//     --configs "claude-opus-5-5:high,claude-opus-5-5:low,claude-haiku-5-5:medium>claude-opus-5-5:high"
//
// A config is model:effort, or first>second for "cheap first, re-check failures with the second".
// Each photo is read once per config, so this spends real API money: start with ~20 photos.
// Prints accuracy, "silent errors" (wrong values that were NOT highlighted) and cost per photo,
// and writes every wrong field to compare-results.csv.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { extractWaybill, describeError } from '../lib/extract.js';
import { getSettings, detectMediaType } from '../lib/store.js';
import { detectColumns } from '../lib/workbook.js';
import { buildRow, validateRow, countWaybills, normWaybill } from '../public/shared.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const photosDir = opt('photos');
const truthFile = opt('truth');
const configs = (opt('configs') || 'claude-opus-5-5:high,claude-opus-5-5:low,claude-haiku-5-5:medium>claude-opus-5-5:high')
  .split(',').map((c) => c.trim()).filter(Boolean);
const limit = Number(opt('limit', 0));

if (!photosDir || !truthFile) {
  console.log('Usage: npm run compare -- --photos <folder> --truth <workbook.xlsx> [--configs "model:effort,..."] [--limit 20]');
  process.exit(1);
}

const FIELDS = ['date', 'truck', 'orderNo', 'waybill', 'product', 'transporter', 'bdc', 'omc', 'ordered', 'loaded'];
const NUMERIC = new Set(['ordered', 'loaded']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function cellValue(cell) {
  let v = cell?.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (v.richText) v = v.richText.map((r) => r.text).join('');
    else if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
  }
  if (v instanceof Date) return `${v.getUTCDate()}-${MONTHS[v.getUTCMonth()]}`;
  return v ?? '';
}

function norm(key, v) {
  if (v === null || v === undefined || v === '') return '';
  if (NUMERIC.has(key)) {
    const n = Number(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : String(v);
  }
  if (key === 'date') {
    const m = /^(\d{1,2})-([a-z]{3})/i.exec(String(v).trim());
    return m ? `${Number(m[1])}-${m[2].toLowerCase()}` : String(v).toLowerCase();
  }
  return String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function loadTruth(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const rows = [];
  wb.eachSheet((ws) => {
    const det = detectColumns(ws);
    if (det.positional) return; // only sheets with a recognisable header row
    for (let r = det.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const t = { where: `${ws.name}!${r}` };
      for (const k of FIELDS) t[k] = det.columns[k] ? cellValue(row.getCell(det.columns[k])) : '';
      if (normWaybill(t.waybill)) rows.push(t);
    }
  });
  return rows;
}

// Find the answer-key row: by waybill number, else by two of (loaded, truck, order no.).
function matchTruth(truth, cells) {
  const w = normWaybill(cells.waybill);
  const byWaybill = truth.find((t) => w && normWaybill(t.waybill) === w);
  if (byWaybill) return byWaybill;
  return truth.find((t) => ['loaded', 'truck', 'orderNo'].filter((k) => norm(k, t[k]) !== '' && norm(k, t[k]) === norm(k, cells[k])).length >= 2);
}

const truth = await loadTruth(truthFile);
const settings = await getSettings();
let files = (await fs.readdir(photosDir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (limit) files = files.slice(0, limit);
console.log(`${files.length} photo(s), ${truth.length} answer-key rows, ${configs.length} config(s): ${configs.join(' | ')}\n`);

const wrongLines = [['config', 'photo', 'field', 'read', 'expected', 'highlighted', 'answer_key_cell'].join(',')];
const results = [];

for (const config of configs) {
  const [first, second] = config.split('>');
  const [model, effort = 'high'] = first.split(':');
  const [escalateModel = '', escalateEffort = 'high'] = (second || '').split(':');
  const r = { config, photos: 0, unmatched: 0, failed: 0, fields: 0, correct: 0, rowsAllCorrect: 0, silent: 0, escalated: 0, cost: 0, seconds: 0 };

  for (const f of files) {
    const buf = await fs.readFile(path.join(photosDir, f));
    const type = detectMediaType(buf);
    if (!type || buf.length > 5 * 1024 * 1024) { console.log(`  skip ${f}: not an image or over 5 MB`); continue; }
    r.photos++;
    const t0 = Date.now();
    let out;
    try {
      out = await extractWaybill(buf, type, { model, effort, escalateModel, escalateEffort, onPass: (p) => { r.cost += p.cost || 0; } });
    } catch (e) {
      r.failed++;
      console.log(`  ${config} ${f}: FAILED ${describeError(e).message}`);
      continue;
    }
    r.seconds += (Date.now() - t0) / 1000;
    if (out.passes.some((p) => p.stage === 'escalation')) r.escalated++;
    const { cells, flags } = buildRow(out.extraction, settings);
    const issues = validateRow(out.extraction, cells, { sessionWaybills: countWaybills([cells]) });
    const rowFlagged = issues.some((i) => i.level === 'error' && !i.field);
    const t = matchTruth(truth, cells);
    if (!t) {
      r.unmatched++;
      wrongLines.push([config, f, '(whole row)', `"${cells.waybill}"`, '(no answer-key row found)', 'n/a', ''].join(','));
      continue;
    }
    let allOk = true;
    for (const k of FIELDS) {
      if (norm(k, t[k]) === '') continue; // nothing in the answer key to compare against
      r.fields++;
      if (norm(k, cells[k]) === norm(k, t[k])) { r.correct++; continue; }
      allOk = false;
      const highlighted = !!flags[k] || rowFlagged || issues.some((i) => i.field === k);
      if (!highlighted) r.silent++;
      wrongLines.push([config, f, k, JSON.stringify(String(cells[k])), JSON.stringify(String(t[k])), highlighted ? 'yes' : 'NO', t.where].join(','));
    }
    if (allOk) r.rowsAllCorrect++;
    process.stdout.write(`  ${config}: ${r.photos}/${files.length}  $${r.cost.toFixed(3)}\r`);
  }
  results.push(r);
  console.log('');
}

console.log('\nResults (fields = the 10 read columns; "silent" = wrong AND not highlighted)\n');
console.table(results.map((r) => {
  const done = r.photos - r.failed;
  return {
    config: r.config,
    photos: r.photos,
    'field accuracy': r.fields ? `${((100 * r.correct) / r.fields).toFixed(1)}%` : '-',
    'rows fully right': `${r.rowsAllCorrect}/${done}`,
    'silent errors': r.silent,
    'no key match': r.unmatched,
    failed: r.failed,
    're-checked': r.escalated,
    'cost/photo': done ? `$${(r.cost / done).toFixed(4)}` : '-',
    'sec/photo': done ? (r.seconds / done).toFixed(1) : '-',
    'total cost': `$${r.cost.toFixed(3)}`,
  };
}));
await fs.writeFile('compare-results.csv', `${wrongLines.join('\n')}\n`);
console.log('Every wrong field is listed in compare-results.csv');
