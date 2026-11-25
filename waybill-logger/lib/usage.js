// API cost tracking: one JSON line per model call in DATA_DIR/usage/YYYY-MM-DD.jsonl.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const USAGE_DIR = path.join(DATA_DIR, 'usage');

// US$ per million tokens, from the Claude pricing page (checked 2026-11-24).
// Haiku 5.5 rates are for prompts up to 100K tokens, which every waybill request is.
// Cache writes use the 5-minute rate (1.25x input).
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Estimated cost in US$ of one response's usage, or null for a model without a price entry. */
export function estimateCost(model, usage) {
  if (!usage) return 0;
  const key = Object.keys(PRICES).find((k) => String(model || '').startsWith(k));
  if (!key) return null;
  const p = PRICES[key];
  const m = 1e6;
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.output_tokens || 0) * p.output +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / m
  );
}

const dayOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function logUsage(entry) {
  await fs.mkdir(USAGE_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await fs.appendFile(path.join(USAGE_DIR, `${dayOf()}.jsonl`), `${line}\n`);
}

/** Totals for one calendar day (server's local time). */
export async function usageSummary(day = dayOf()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error('Bad day'), { status: 400 });
  let text = '';
  try {
    text = await fs.readFile(path.join(USAGE_DIR, `${day}.jsonl`), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const sum = { day, calls: 0, waybills: 0, escalations: 0, cachedHits: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, unpriced: 0, byModel: {}, checkFailures: {} };
  const images = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.cached) { sum.cachedHits++; continue; }
    sum.calls++;
    if (e.id) images.add(e.id);
    if (e.stage === 'escalation') sum.escalations++;
    sum.inputTokens += (e.usage?.input_tokens || 0) + (e.usage?.cache_read_input_tokens || 0) + (e.usage?.cache_creation_input_tokens || 0);
    sum.outputTokens += e.usage?.output_tokens || 0;
    sum.cacheReadTokens += e.usage?.cache_read_input_tokens || 0;
    // Which checks first readings fail, grouped by the kind of check ("unreadable", "uncertain", ...).
    if (e.stage === 'first') {
      for (const r of e.reasons || []) {
        const m = /^(unreadable|uncertain|blank): (.*)$/.exec(String(r));
        // "unreadable: driver, loading_end" counts once per field; other checks are grouped with numbers removed.
        const kinds = m ? m[2].split(', ').map((f) => `${m[1]}: ${f}`) : [String(r).replace(/\d[\d,.]*/g, '#').slice(0, 100)];
        for (const k of kinds) sum.checkFailures[k] = (sum.checkFailures[k] || 0) + 1;
      }
    }
    if (typeof e.cost === 'number') sum.cost += e.cost;
    else sum.unpriced++;
    const m = (sum.byModel[e.model] ||= { calls: 0, cost: 0 });
    m.calls++;
    m.cost += e.cost || 0;
  }
  sum.waybills = images.size;
  sum.costPerWaybill = sum.waybills ? sum.cost / sum.waybills : 0;
  return sum;
}
