// Sample test cases for mapping, validation and copy output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildRow, validateRow, countWaybills, numberRows, toTSV, buildNotes, formatDayMonth,
  tabNameForDay, compareWaybills, activeCompartments,
} from '../public/shared.js';
import { DEFAULT_SETTINGS } from '../lib/store.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const ok = load('extraction-ok.json');
const problems = load('extraction-problems.json');
const settings = structuredClone(DEFAULT_SETTINGS);

test('clean waybill maps to the 12 output columns', () => {
  const { cells, flags } = buildRow(ok, settings);
  numberRows([cells], 15);
  assert.deepEqual(cells, {
    no: 15, date: '23-Nov', truck: 'GM131-25', orderNo: '4500123456', waybill: 'SORL00061973',
    product: 'AGO', transporter: 'KOFI ASANTE TRANSPORT', depot: 'SORL', bdc: 'SAGE', omc: 'MPB',
    ordered: 54000, loaded: 54210,
  });
  assert.deepEqual(flags, {});
  assert.equal(toTSV([cells]), '15\t23-Nov\tGM131-25\t4500123456\tSORL00061973\tAGO\tKOFI ASANTE TRANSPORT\tSORL\tSAGE\tMPB\t54000\t54210');
});

test('clean waybill passes all checks for its own day; empty compartment 4 is ignored', () => {
  const { cells } = buildRow(ok, settings);
  assert.equal(activeCompartments(ok).length, 3);
  const issues = validateRow(ok, cells, { selectedDay: '2026-11-23', sessionWaybills: countWaybills([cells]) });
  assert.deepEqual(issues, []);
});

test('unreadable fields stay blank and are flagged; unknown company shows full name', () => {
  const { cells, flags } = buildRow(problems, settings);
  assert.equal(cells.orderNo, '');
  assert.equal(flags.orderNo, 'blank');
  assert.equal(flags.truck, 'uncertain');
  assert.equal(cells.product, 'PMS');
  assert.equal(cells.bdc, 'NEWCO ENERGY GHANA LIMITED');
  assert.equal(flags.bdc, 'unmapped');
  assert.equal(cells.omc, 'SAGE');
});

test('saving a short name makes it map next time (case/spacing insensitive)', () => {
  const s = structuredClone(settings);
  s.companies['Newco  Energy Ghana Limited'] = 'NEWCO';
  const { cells, flags } = buildRow(problems, s);
  assert.equal(cells.bdc, 'NEWCO');
  assert.equal(flags.bdc, undefined);
});

test('compartment sum mismatch, wrong day and multiple destinations', () => {
  const { cells } = buildRow(problems, settings);
  const issues = validateRow(problems, cells, { selectedDay: '2026-11-23', sessionWaybills: countWaybills([cells]) });
  const msgs = issues.map((i) => `${i.level}:${i.field}`);
  // 15020+15030+14990 = 45040, LOADED GROSS says 45100
  assert.ok(msgs.includes('error:loaded'), msgs.join());
  assert.ok(!msgs.includes('error:ordered'), 'ordered sum 45000 matches');
  assert.ok(msgs.includes('warn:date'));
  assert.equal(buildNotes(problems), 'Destinations: TAMALE; BOLGATANGA | Two destinations listed; pen mark over the order number.');
});

test('duplicates within the batch and in the uploaded workbook are flagged', () => {
  const a = buildRow(ok, settings).cells;
  const b = buildRow(ok, settings).cells;
  const sessionWaybills = countWaybills([a, b]);
  const sheetWaybills = new Map([['SORL00061973', ['22-11!E9']]]);
  const issues = validateRow(ok, a, { selectedDay: '2026-11-23', sessionWaybills, sheetWaybills });
  assert.equal(issues.filter((i) => i.field === 'waybill' && i.level === 'error').length, 2);
});

test('user edits override extracted values and clear the highlight', () => {
  const { cells, flags } = buildRow(problems, settings, { orderNo: '4500999111', loaded: '45,040' });
  assert.equal(cells.orderNo, '4500999111');
  assert.equal(cells.loaded, 45040);
  assert.equal(flags.orderNo, undefined);
  const issues = validateRow(problems, cells, { selectedDay: '2026-11-22', sessionWaybills: countWaybills([cells]) });
  assert.ok(!issues.some((i) => i.field === 'loaded' && i.level === 'error'));
});

test('missing compartment value means totals are not checked (no guessing)', () => {
  const x = structuredClone(ok);
  x.compartments[1].actual_load = null;
  const { cells } = buildRow(x, settings);
  const issues = validateRow(x, cells, { sessionWaybills: countWaybills([cells]) });
  assert.ok(issues.some((i) => i.level === 'warn' && i.field === 'loaded'));
  assert.ok(!issues.some((i) => i.level === 'error'));
});

test('sorting by waybill number, date formats and tab names', () => {
  const list = ['SORL00061973', '', 'SORL00061970', 'SORL00061999'].sort(compareWaybills);
  assert.deepEqual(list, ['SORL00061970', 'SORL00061973', 'SORL00061999', '']);
  assert.equal(formatDayMonth('2026-11-03'), '3-Nov');
  assert.equal(formatDayMonth('garbage'), '');
  assert.equal(tabNameForDay('2026-11-23'), '23-11');
});

test('unreadable date is blank, never guessed', () => {
  const x = { ...ok, date: '2?/11/2026', date_iso: null, unreadable_fields: ['date'] };
  const { cells, flags } = buildRow(x, settings);
  assert.equal(cells.date, '');
  assert.equal(flags.date, 'blank');
});
