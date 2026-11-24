// Excel workbook helpers: inspect an existing workbook, append rows to a day's tab, export a new file.
import ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import { COLUMNS, normWaybill } from '../public/shared.js';

const require = createRequire(import.meta.url);
const { slideFormula } = require('exceljs/lib/utils/shared-formula.js');

const normHeader = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result ?? '');
    if (v instanceof Date) return v.toISOString();
    if (v.formula || v.sharedFormula) return '';
    return '';
  }
  return String(v);
}

function hasFormula(cell) {
  const v = cell?.value;
  return !!(v && typeof v === 'object' && (v.formula || v.sharedFormula));
}

// Header matchers, most specific first. Each returns true for a normalised header string.
const HEADER_RULES = [
  ['ordered', (h) => h.startsWith('ORDERED')],
  ['loaded', (h) => h.startsWith('LOADED') && !h.includes('20') && !h.includes('COMP')],
  ['waybill', (h) => h.includes('WAYBILL')],
  ['orderNo', (h) => h === 'ORDERNO' || h === 'ORDERNUMBER' || h === 'CUSTOMERORDERNO' || (h.startsWith('ORDER') && h.includes('NO'))],
  ['truck', (h) => h.includes('TRUCK') || h === 'VEHICLENO'],
  ['date', (h) => h === 'DATE'],
  ['product', (h) => h.startsWith('PRODUCT')],
  ['transporter', (h) => h.startsWith('TRANSPORTER')],
  ['depot', (h) => h.startsWith('DEPOT')],
  ['bdc', (h) => h === 'BDC' || h === 'SUPPLIER'],
  ['omc', (h) => h === 'OMC' || h === 'CUSTOMER'],
  ['no', (h) => h === 'NO' || h === 'SN' || h === 'SNO' || h === 'SERIALNO'],
];

/** Find the header row and the column number for each output field. */
export function detectColumns(ws) {
  const maxScan = Math.min(ws.rowCount || 0, 30);
  for (let r = 1; r <= maxScan; r++) {
    const row = ws.getRow(r);
    const map = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = normHeader(cellText(cell));
      if (!h) return;
      for (const [key, test] of HEADER_RULES) {
        if (!map[key] && test(h)) {
          map[key] = col;
          break;
        }
      }
    });
    if (map.waybill && Object.keys(map).length >= 6) return { headerRow: r, columns: map, positional: false };
  }
  // Fallback: assume the 12 columns start in column A in the standard order.
  const columns = {};
  COLUMNS.forEach((c, i) => (columns[c.key] = i + 1));
  return { headerRow: 0, columns, positional: true };
}

/** Last row that has a waybill (or truck) number, at or below the header row. */
export function findLastDataRow(ws, det) {
  const keyCols = [det.columns.waybill, det.columns.truck].filter(Boolean);
  let last = det.headerRow;
  for (let r = det.headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (keyCols.some((c) => cellText(row.getCell(c)).trim() !== '')) last = r;
  }
  return last;
}

export async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    throw Object.assign(new Error(`Could not open the workbook (.xlsx only): ${e.message}`), { status: 400 });
  }
  return wb;
}

/** Sheets, detected columns and every waybill number already in the workbook. */
export async function inspectWorkbook(buffer) {
  const wb = await loadWorkbook(buffer);
  const sheets = [];
  const waybills = {}; // normalised -> ["23-11!E7", ...]
  wb.eachSheet((ws) => {
    const det = detectColumns(ws);
    const lastRow = findLastDataRow(ws, det);
    sheets.push({ name: ws.name, headerRow: det.headerRow, positional: det.positional, lastRow, columns: det.columns });
    // Waybill numbers can be anywhere: scan every cell for SORL-like values.
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const t = normWaybill(cellText(cell));
        if (/^SORL\d{5,}$/.test(t)) (waybills[t] ||= []).push(`${ws.name}!${cell.address}`);
      });
    });
  });
  return { sheets, waybills };
}

function dateFromDayMonth(text, yearHint) {
  const m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(String(text || '').trim());
  if (!m) return null;
  const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  if (idx < 0) return null;
  return new Date(Date.UTC(yearHint, idx, Number(m[1])));
}

/**
 * Append rows below the last used row of a sheet.
 * - Cell styles (fonts, borders, fills, number formats) are copied from the last data row when the new row has none.
 * - Formulas in columns we do not fill (e.g. temperature compensation) are copied down with their row references shifted.
 * - Rows that are already pre-formatted / pre-filled with formulas keep what they have; only our 12 columns are written.
 */
export async function appendToWorkbook(buffer, sheetName, rows, { year = new Date().getFullYear() } = {}) {
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw Object.assign(new Error(`Sheet "${sheetName}" not found`), { status: 400 });

  const det = detectColumns(ws);
  const lastRow = findLastDataRow(ws, det);
  const templateRowNo = lastRow > det.headerRow ? lastRow : null;
  const template = templateRowNo ? ws.getRow(templateRowNo) : null;
  const ourCols = new Set(Object.values(det.columns));
  const maxCol = Math.max(ws.columnCount || 0, ...ourCols);

  const dateCol = det.columns.date;
  const templateDateIsDate = template && template.getCell(dateCol).value instanceof Date;

  // Never write over a totals row or other content below the data (pre-filled per-row formulas are fine).
  for (let i = 0; i < rows.length; i++) {
    const r = lastRow + 1 + i;
    const row = ws.getRow(r);
    for (const col of ourCols) {
      const cell = row.getCell(col);
      const v = cell.value;
      const isSum = hasFormula(cell) && /\b(SUM|SUBTOTAL)\s*\(/i.test(cell.formula || '');
      const isText = v !== null && v !== undefined && v !== '' && !hasFormula(cell);
      if (isSum || isText) {
        throw Object.assign(new Error(
          `Row ${r} of "${sheetName}" already has content (${cell.address}: ${isSum ? cell.formula : cellText(cell)}). ` +
          `Insert ${rows.length} blank row(s) above the totals row in Excel, then try again.`), { status: 409 });
      }
    }
  }

  rows.forEach((cells, i) => {
    const r = lastRow + 1 + i;
    const row = ws.getRow(r);
    if (template && template.height) row.height = template.height;

    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c);
      const tCell = template ? template.getCell(c) : null;
      const cellIsEmpty = cell.value === null || cell.value === undefined || cell.value === '';
      if (tCell && cellIsEmpty && (!cell.style || Object.keys(cell.style).length === 0)) {
        cell.style = JSON.parse(JSON.stringify(tCell.style || {}));
      }
      if (!ourCols.has(c) && cellIsEmpty && tCell && hasFormula(tCell)) {
        const f = tCell.formula;
        if (f) cell.value = { formula: slideFormula(f, tCell.address, cell.address) };
      }
    }

    for (const { key } of COLUMNS) {
      const col = det.columns[key];
      if (!col) continue;
      let v = cells[key];
      if (v === undefined || v === null) v = '';
      if (key === 'date' && templateDateIsDate) {
        const d = dateFromDayMonth(v, year);
        if (d) v = d;
      }
      if ((key === 'ordered' || key === 'loaded' || key === 'no') && v !== '' && Number.isFinite(Number(v))) v = Number(v);
      row.getCell(col).value = v === '' ? null : v;
    }
    row.commit();
  });

  // Copied-down formulas have no cached result yet: ask Excel/WPS to recalculate when the file opens.
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  const out = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(out), firstRow: lastRow + 1, lastRow: lastRow + rows.length, columns: det.columns, positional: det.positional };
}

/** A fresh workbook with a header row and the given rows. */
export async function exportWorkbook(rows, sheetName = 'Waybills') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Waybills');
  ws.columns = COLUMNS.map((c) => ({ header: c.label, key: c.key, width: Math.max(10, c.label.length + 4) }));
  ws.getRow(1).font = { bold: true };
  for (const cells of rows) {
    const r = {};
    for (const { key } of COLUMNS) {
      const v = cells[key];
      r[key] = (key === 'ordered' || key === 'loaded' || key === 'no') && v !== '' && Number.isFinite(Number(v)) ? Number(v) : (v ?? '');
    }
    ws.addRow(r);
  }
  ws.getColumn('ordered').numFmt = '#,##0';
  ws.getColumn('loaded').numFmt = '#,##0';
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
