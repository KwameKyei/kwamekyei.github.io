// Cost controls: escalation checks, two-pass flow, cost estimates and daily spend totals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'waybill-cost-'));
const { escalationReasons, extractWaybill } = await import('../lib/extract.js');
const { estimateCost, logUsage, usageSummary } = await import('../lib/usage.js');

const load = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const ok = load('extraction-ok.json');
const problems = load('extraction-problems.json');
const usage = { input_tokens: 6000, output_tokens: 1000 };

test('a clean reading passes every check; a problem reading is sent for re-check', () => {
  assert.deepEqual(escalationReasons(ok), []);
  const reasons = escalationReasons(problems).join(' | ');
  assert.match(reasons, /unreadable: customer_order_number/);
  assert.match(reasons, /uncertain: truck_number/);
  assert.match(reasons, /add up to 45,040/);
  // An unknown company is a mapping job, not a reading problem.
  assert.ok(!/NEWCO/.test(reasons));
});

test('cost estimate uses each model\'s price per million tokens', () => {
  assert.equal(estimateCost('claude-opus-5-5', usage).toFixed(4), '0.0440'); // 6000*4 + 1000*20
  assert.equal(estimateCost('claude-haiku-5-5', usage).toFixed(5), '0.00110'); // 6000*0.1 + 1000*0.5
  assert.equal(estimateCost('some-unknown-model', usage), null);
});

test('two-pass: clean cheap reading is kept, a failed one is re-read by the stronger model', async () => {
  const calls = [];
  const reader = (answer) => async (buf, type, { model, effort }) => {
    calls.push(`${model}:${effort}`);
    return { extraction: model === 'claude-haiku-5-5' ? answer : ok, model, usage };
  };
  const opts = { model: 'claude-haiku-5-5', effort: 'medium', escalateModel: 'claude-opus-5-5', escalateEffort: 'high' };

  const kept = await extractWaybill(Buffer.alloc(1), 'image/jpeg', { ...opts, reader: reader(ok) });
  assert.deepEqual(calls, ['claude-haiku-5-5:medium']);
  assert.equal(kept.model, 'claude-haiku-5-5');
  assert.equal(kept.passes.length, 1);

  calls.length = 0;
  const rechecked = await extractWaybill(Buffer.alloc(1), 'image/jpeg', { ...opts, reader: reader(problems) });
  assert.deepEqual(calls, ['claude-haiku-5-5:medium', 'claude-opus-5-5:high']);
  assert.equal(rechecked.model, 'claude-opus-5-5');
  assert.equal(rechecked.extraction.waybill_no, ok.waybill_no);
  assert.equal(rechecked.cost.toFixed(4), (0.0011 + 0.044).toFixed(4));
  assert.ok(rechecked.passes[0].reasons.length > 0);
});

test('without a re-check model, only one call is made even for a problem reading', async () => {
  let n = 0;
  const reader = async (b, t, { model }) => { n++; return { extraction: problems, model, usage }; };
  await extractWaybill(Buffer.alloc(1), 'image/jpeg', { model: 'claude-opus-5-5', effort: 'high', escalateModel: '', reader });
  assert.equal(n, 1);
});

test('daily spend totals count photos, re-checks and cached repeats', async () => {
  await logUsage({ id: 'a1', stage: 'first', model: 'claude-haiku-5-5', usage, cost: 0.0011 });
  await logUsage({ id: 'a1', stage: 'escalation', model: 'claude-opus-5-5', usage, cost: 0.044 });
  await logUsage({ id: 'b2', stage: 'first', model: 'claude-haiku-5-5', usage, cost: 0.0011 });
  await logUsage({ id: 'c3', cached: true, cost: 0 });
  const s = await usageSummary();
  assert.equal(s.calls, 3);
  assert.equal(s.waybills, 2);
  assert.equal(s.escalations, 1);
  assert.equal(s.cachedHits, 1);
  assert.equal(s.cost.toFixed(4), '0.0462');
  assert.equal(s.costPerWaybill.toFixed(4), '0.0231');
});

test('every reading records which checks it failed, even with re-checks off', async () => {
  const logged = [];
  const reader = async (b, t, { model }) => ({ extraction: problems, model, usage });
  await extractWaybill(Buffer.alloc(1), 'image/jpeg', { model: 'claude-opus-5-5', effort: 'low', escalateModel: '', reader, onPass: (p) => logged.push(p) });
  assert.equal(logged.length, 1);
  assert.ok(logged[0].reasons.some((r) => r.startsWith('unreadable:')));
});

test('daily summary counts failed checks per field', async () => {
  await logUsage({ id: 'd4', stage: 'first', model: 'claude-opus-5-5', usage, cost: 0.04, reasons: ['unreadable: driver, loading_end', 'Compartment actual loads add up to 45,040 but LOADED GROSS is 45,100.'] });
  await logUsage({ id: 'e5', stage: 'first', model: 'claude-opus-5-5', usage, cost: 0.04, reasons: ['unreadable: driver'] });
  const s = await usageSummary();
  assert.equal(s.checkFailures['unreadable: driver'], 2);
  assert.equal(s.checkFailures['unreadable: loading_end'], 1);
  assert.equal(s.checkFailures['Compartment actual loads add up to # but LOADED GROSS is #'], 1);
});

test('an uncertain field alone does not trigger a re-check; a failed check does', async () => {
  const onlyUncertain = { ...ok, uncertain_fields: ['waybill_no', 'customer_order_number'] };
  const calls = [];
  const reader = (answer) => async (b, t, { model, effort }) => { calls.push(effort); return { extraction: answer, model, usage }; };
  const opts = { model: 'claude-opus-5-5', effort: 'low', escalateModel: 'claude-opus-5-5', escalateEffort: 'high' };
  await extractWaybill(Buffer.alloc(1), 'image/jpeg', { ...opts, reader: reader(onlyUncertain) });
  assert.deepEqual(calls, ['low']);
  calls.length = 0;
  await extractWaybill(Buffer.alloc(1), 'image/jpeg', { ...opts, reader: reader(problems) });
  assert.deepEqual(calls, ['low', 'high']);
});
