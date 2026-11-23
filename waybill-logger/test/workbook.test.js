// Appending to an existing workbook keeps formatting and copies formulas down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { appendToWorkbook, inspectWorkbook, exportWorkbook } from '../lib/workbook.js';

async function sampleWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('22-11').addRow(['NO.', 'DATE', 'TRUCK NUM', 'ORDER NO.', 'WAYBILL NO.', 'PRODUCT', 'TRANSPORTER', 'DEPOT', 'BDC', 'OMC', 'ORDERED @20 (L)', 'LOADED (L)', 'TEMP COMP (L)'])
    .commit();
  wb.getWorksheet('22-11').addRow([1, '22-Nov', 'GT1-20', '45', 'SORL00061900', 'AGO', 'X', 'SORL', 'SAGE', 'MPB', 1000, 1001]);
  const ws = wb.addWorksheet('23-11');
  ws.getCell('A1').value = 'DAILY LOADING 23-11';
  ws.addRow([]);
  ws.addRow(['NO.', 'DATE', 'TRUCK NUM', 'ORDER NO.', 'WAYBILL NO.', 'PRODUCT', 'TRANSPORTER', 'DEPOT', 'BDC', 'OMC', 'ORDERED @20 (L)', 'LOADED (L)', 'TEMP COMP (L)']);
  const r4 = ws.addRow([7, '23-Nov', 'GM100-24', '4500000001', 'SORL00061950', 'PMS', 'ABC', 'SORL', 'SAGE', 'MPB', 40000, 40100]);
  r4.getCell(13).value = { formula: 'L4-K4', result: 100 };
  r4.getCell(11).numFmt = '#,##0';
  r4.getCell(5).font = { bold: true, color: { argb: 'FF1F4E79' } };
  r4.getCell(5).border = { bottom: { style: 'thin' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const newRows = [
  { no: 8, date: '23-Nov', truck: 'GM131-25', orderNo: '4500123456', waybill: 'SORL00061973', product: 'AGO', transporter: 'KOFI', depot: 'SORL', bdc: 'SAGE', omc: 'MPB', ordered: 54000, loaded: 54210 },
  { no: 9, date: '23-Nov', truck: 'GT 4521-19', orderNo: '', waybill: 'SORL00061974', product: 'PMS', transporter: 'NH', depot: 'SORL', bdc: 'NEWCO', omc: 'SAGE', ordered: 45000, loaded: 45040 },
];

test('inspect finds tabs, header rows, last rows and existing waybills', async () => {
  const info = await inspectWorkbook(await sampleWorkbook());
  const s = info.sheets.find((x) => x.name === '23-11');
  assert.equal(s.headerRow, 3);
  assert.equal(s.lastRow, 4);
  assert.equal(s.columns.waybill, 5);
  assert.equal(s.columns.loaded, 12, 'LOADED (L), not TEMP COMP');
  assert.deepEqual(Object.keys(info.waybills).sort(), ['SORL00061900', 'SORL00061950']);
  assert.deepEqual(info.waybills.SORL00061900, ['22-11!E2']);
});

test('append goes below the last used row, keeps formatting and copies formulas', async () => {
  const { buffer, firstRow, lastRow } = await appendToWorkbook(await sampleWorkbook(), '23-11', newRows, { year: 2026 });
  assert.equal(firstRow, 5);
  assert.equal(lastRow, 6);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('23-11');
  assert.equal(ws.getCell('E5').value, 'SORL00061973');
  assert.equal(ws.getCell('K5').value, 54000);
  assert.equal(ws.getCell('D6').value, null, 'blank stays blank');
  assert.equal(ws.getCell('M5').formula, 'L5-K5');
  assert.equal(ws.getCell('M6').formula, 'L6-K6');
  assert.equal(ws.getCell('K6').numFmt, '#,##0');
  assert.equal(ws.getCell('E6').font.bold, true);
  assert.equal(ws.getCell('E6').border.bottom.style, 'thin');
  // other sheets untouched
  assert.equal(wb.getWorksheet('22-11').rowCount, 2);
  assert.equal(ws.getCell('M4').formula, 'L4-K4');
});

test('export creates a header plus rows', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await exportWorkbook(newRows, '23-11'));
  const ws = wb.getWorksheet('23-11');
  assert.equal(ws.getCell('A1').value, 'NO.');
  assert.equal(ws.getCell('L3').value, 45040);
  assert.equal(ws.columnCount, 12);
});

test('refuses to overwrite a totals row below the data', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await sampleWorkbook());
  const ws = wb.getWorksheet('23-11');
  ws.getCell('J6').value = 'TOTAL';
  ws.getCell('L6').value = { formula: 'SUM(L4:L5)' };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  await assert.rejects(appendToWorkbook(buf, '23-11', newRows), /Row 6 .*already has content/);
});
