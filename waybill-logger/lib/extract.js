// Sends one waybill image to Claude and returns strict JSON.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRow, validateRow, countWaybills } from '../public/shared.js';
import { estimateCost } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// First pass. Every photo is read with this model and effort.
export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
export const EFFORT = process.env.CLAUDE_EFFORT || 'high';
// Optional second pass: when set, a photo whose first reading fails any check (unreadable or
// uncertain fields, totals that don't add up, odd waybill number...) is read again with this model.
export const ESCALATE_MODEL = process.env.CLAUDE_ESCALATE_MODEL || '';
export const ESCALATE_EFFORT = process.env.CLAUDE_ESCALATE_EFFORT || 'high';

// Models that accept the server-side refusal fallback parameter. Others are called without it.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5-2'];

// Structured outputs allow at most 16 union-typed (nullable) fields per schema, so text fields
// use "" for "unreadable / not present" and only the numbers are nullable (7 unions in total).
const str = { type: 'string' };
const numOrNull = { type: ['number', 'null'] };

// JSON schema enforced by structured outputs. Every field is required; unreadable text is "" and
// unreadable numbers are null.
export const WAYBILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_sorl_waybill', 'waybill_no', 'date', 'date_iso', 'truck_number', 'customer_order_number',
    'product_name', 'transporter', 'supplier', 'customer', 'driver', 'destinations',
    'loading_start', 'loading_end', 'order_qty_20c', 'loaded_gross', 'compartments',
    'average_temperature', 'density', 'unreadable_fields', 'uncertain_fields', 'notes',
  ],
  properties: {
    is_sorl_waybill: { type: 'boolean' },
    waybill_no: str,
    date: str,
    date_iso: str,
    truck_number: str,
    customer_order_number: str,
    product_name: str,
    transporter: str,
    supplier: str,
    customer: str,
    driver: str,
    destinations: { type: 'array', items: { type: 'string' } },
    loading_start: str,
    loading_end: str,
    order_qty_20c: numOrNull,
    loaded_gross: numOrNull,
    compartments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'ordered', 'actual_load', 'temperature'],
        properties: {
          number: str,
          ordered: numOrNull,
          actual_load: numOrNull,
          temperature: numOrNull,
        },
      },
    },
    average_temperature: numOrNull,
    density: numOrNull,
    unreadable_fields: { type: 'array', items: { type: 'string' } },
    uncertain_fields: { type: 'array', items: { type: 'string' } },
    notes: str,
  },
};

export const SYSTEM_PROMPT = `You read photographs of Sentuo Oil Refinery Limited (SORL) loading waybills and transcribe them into JSON for a fuel loading log.

The photos are taken on a phone at a loading depot. Expect tilt, shadows, glare, creases, pen or marker marks written over the print, stamps, and faint "ghost" text showing through from other papers underneath or behind. Read ONLY the green SORL waybill that is the subject of the photo. Ignore any other document, carbon copy, or text that is mirrored, faded through from behind, or belongs to a different sheet.

Field guide (use the label printed on the waybill):
- waybill_no: the waybill number, normally "SORL" followed by 8 digits, e.g. "SORL00061973". Copy every digit including leading zeros.
- date: the DATE printed on the waybill, exactly as printed. date_iso: the same date as YYYY-MM-DD (day comes before month on these waybills). Empty string if any part is unreadable.
- truck_number: the truck / vehicle number in the header, e.g. "GM131-25" or "GT 4521-19". Keep letters, digits and the hyphen as printed.
- customer_order_number: the value labelled "Customer order Number".
- product_name: the product description as printed, e.g. "GASOIL 50PPM", "PREMIUM/GASOLINE", "HEAVY FUEL OIL".
- supplier: the SUPPLIER company name in full, as printed.
- customer: the CUSTOMER company name in full, as printed.
- transporter: under DELIVERED BY, the name after "Transporter:".
- driver: the driver's name under DELIVERED BY.
- destinations: every destination / delivery location listed, one string each, in printed order.
- loading_start / loading_end: loading start and end date-times as printed.
- compartments: one entry per row of the compartment table, with the compartment number, the Ordered quantity, the Actual Load and the Temperature. Include rows that show 0.
- order_qty_20c: "Order Quantity@20°C" in the PRODUCT TOTALS section.
- loaded_gross: "LOADED GROSS" in the PRODUCT TOTALS section.
- average_temperature: the average temperature in PRODUCT TOTALS (°C).
- density: the density in PRODUCT TOTALS, as printed (e.g. 0.8352 or 835.2).
- is_sorl_waybill: false if the photo is not a SORL waybill.

Rules:
- Never guess. If a value is unreadable, cut off, covered by a pen mark, or you cannot tell it apart from ghost text, leave it empty (an empty string "" for text, null for a number) and add the field name to unreadable_fields. Do not fill a value from what it "should" be, and do not compute a total from the compartments.
- If you can read a value but are not fully sure of a character or digit, give your best reading and add the field name to uncertain_fields.
- Quantities are litres. Return numbers without thousands separators or units (e.g. 40000, not "40,000 L"). Use a decimal point for decimals.
- Use the JSON field names exactly as given above in unreadable_fields and uncertain_fields.
- notes: one short sentence about anything a reviewer should know (handwritten corrections, a value crossed out, a second page, multiple destinations). Empty string if nothing.`;

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    const err = new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
    err.status = 500;
    throw err;
  }
  client ??= new Anthropic();
  return client;
}

// Mock mode cycles through the sample fixtures so the UI can be tried without an API key.
const MOCK_FILES = ['extraction-ok.json', 'extraction-problems.json'];
let mockCount = 0;
async function mockExtraction() {
  const name = MOCK_FILES[mockCount++ % MOCK_FILES.length];
  const file = path.join(__dirname, '..', 'test', 'fixtures', name);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** One model call: returns { extraction, model, usage }. */
export async function readWithModel(imageBuffer, mediaType, { model, effort }) {
  const params = {
    model,
    max_tokens: 16000,
    // Same instructions for every photo: cache them so photos read within 5 minutes of each other
    // pay the much lower cache-read price for this part. The photo itself comes after and is never cached.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: {
      effort,
      format: { type: 'json_schema', schema: WAYBILL_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
          { type: 'text', text: 'Transcribe this waybill into the JSON format.' },
        ],
      },
    ],
  };
  const response = FALLBACK_MODELS.includes(model)
    ? await getClient().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await getClient().messages.create(params);

  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('The model declined to read this image.'), { status: 422, usage: response.usage, model: response.model });
  }
  if (response.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('The response was cut off. Try re-running this image.'), { status: 502, usage: response.usage, model: response.model });
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let extraction;
  try {
    extraction = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('The model did not return valid JSON. Try re-running this image.'), { status: 502, usage: response.usage, model: response.model });
  }
  return { extraction, model: response.model, usage: response.usage };
}

const KEY_CELLS = ['date', 'truck', 'orderNo', 'waybill', 'product', 'transporter', 'bdc', 'omc', 'ordered', 'loaded'];

/** Why a reading should be checked by the stronger model (empty list = it passed every check). */
export function escalationReasons(x) {
  const reasons = [];
  if (!x || typeof x !== 'object') return ['no reading'];
  if (x.is_sorl_waybill === false) reasons.push('not a SORL waybill');
  if (x.unreadable_fields?.length) reasons.push(`unreadable: ${x.unreadable_fields.join(', ')}`);
  if (x.uncertain_fields?.length) reasons.push(`uncertain: ${x.uncertain_fields.join(', ')}`);
  // Mapping tables don't matter here: an unknown company name is not a reading problem.
  const { cells } = buildRow(x, { products: {}, companies: {} });
  const blank = KEY_CELLS.filter((k) => cells[k] === '' || cells[k] === null);
  if (blank.length) reasons.push(`blank: ${blank.join(', ')}`);
  for (const i of validateRow(x, cells, { sessionWaybills: countWaybills([cells]) })) reasons.push(i.msg);
  return reasons;
}

/**
 * Read a waybill: first pass with MODEL/EFFORT, then (if ESCALATE_MODEL is set and the first
 * reading fails a check) a second pass with ESCALATE_MODEL/ESCALATE_EFFORT.
 * Returns { extraction, model, usage, cost, passes: [{ stage, model, effort, usage, cost, reasons }] }.
 * onPass(pass) is called for every model call, including failed ones, so cost can be logged.
 */
export async function extractWaybill(imageBuffer, mediaType = 'image/jpeg', {
  onPass, model = MODEL, effort = EFFORT, escalateModel = ESCALATE_MODEL, escalateEffort = ESCALATE_EFFORT,
  reader = readWithModel, // tests pass a stand-in here
} = {}) {
  if (process.env.MOCK_EXTRACTION === '1' && reader === readWithModel) {
    return { extraction: await mockExtraction(), model: 'mock', usage: null, cost: 0, passes: [] };
  }
  const passes = [];
  const run = async (stage, model, effort) => {
    try {
      const r = await reader(imageBuffer, mediaType, { model, effort });
      const pass = {
        stage, model: r.model, effort, usage: r.usage, cost: estimateCost(r.model, r.usage),
        // Which checks this reading fails; logged for every pass so re-check decisions can be reviewed.
        reasons: escalationReasons(r.extraction),
      };
      passes.push(pass);
      await onPass?.(pass);
      return r;
    } catch (err) {
      if (err.usage) {
        const pass = { stage, model: err.model || model, effort, usage: err.usage, cost: estimateCost(err.model || model, err.usage), error: err.message };
        passes.push(pass);
        await onPass?.(pass);
      }
      throw err;
    }
  };

  let first;
  try {
    first = await run('first', model, effort);
  } catch (err) {
    // A failed cheap pass (refusal, cut off, bad JSON) goes straight to the stronger model.
    if (!escalateModel) throw err;
  }
  let result = first;
  if (escalateModel) {
    const reasons = first ? passes[0].reasons : ['first pass failed'];
    if (reasons.length) result = await run('escalation', escalateModel, escalateEffort);
  }
  const total = (k) => passes.reduce((n, p) => n + (p.usage?.[k] || 0), 0);
  const costs = passes.map((p) => p.cost);
  return {
    extraction: result.extraction,
    model: result.model,
    usage: { input_tokens: total('input_tokens'), output_tokens: total('output_tokens') },
    cost: costs.some((c) => c === null) ? null : costs.reduce((a, b) => a + b, 0),
    passes,
  };
}

/** Turn SDK errors into a short message for the UI. */
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return { status: 500, message: 'The API key was rejected. Check ANTHROPIC_API_KEY in .env.' };
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: 'Rate limited by the API. Wait a moment and re-run.' };
  if (err instanceof Anthropic.BadRequestError) return { status: 400, message: `API rejected the request: ${err.message}` };
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: 'Could not reach the Claude API. Check the internet connection.' };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `Claude API error: ${err.message}` };
  return { status: err.status || 500, message: err.message || String(err) };
}
