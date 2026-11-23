// Shared logic for Waybill Logger: mapping, row building, validation, TSV.
// Plain ES module with no dependencies, used by the browser UI and by the Node tests.

export const COLUMNS = [
  { key: 'no', label: 'NO.' },
  { key: 'date', label: 'DATE' },
  { key: 'truck', label: 'TRUCK NUM' },
  { key: 'orderNo', label: 'ORDER NO.' },
  { key: 'waybill', label: 'WAYBILL NO.' },
  { key: 'product', label: 'PRODUCT' },
  { key: 'transporter', label: 'TRANSPORTER' },
  { key: 'depot', label: 'DEPOT' },
  { key: 'bdc', label: 'BDC' },
  { key: 'omc', label: 'OMC' },
  { key: 'ordered', label: 'ORDERED @20 (L)' },
  { key: 'loaded', label: 'LOADED (L)' },
];

export const NUMERIC_KEYS = new Set(['no', 'ordered', 'loaded']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Normalise a name for lookups: upper case, & -> AND, punctuation removed, single spaces. */
export function normName(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9/ ]+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookup(table, name) {
  if (!name) return null;
  const n = normName(name);
  for (const [k, v] of Object.entries(table || {})) {
    if (normName(k) === n && String(v ?? '').trim()) return String(v).trim();
  }
  return null;
}

/** Product name -> code. Exact (normalised) match only, so nothing is guessed. */
export function mapProduct(settings, name) {
  return lookup(settings?.products, name);
}

/** Company full name -> short name. Exact (normalised) match only. */
export function mapCompany(settings, name) {
  return lookup(settings?.companies, name);
}

/** ISO date (YYYY-MM-DD) -> "23-Nov". Returns '' for anything invalid. */
export function formatDayMonth(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day}-${MONTHS[month - 1]}`;
}

/** ISO date -> sheet tab name "23-11". */
export function tabNameForDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}` : '';
}

export function normWaybill(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function waybillSortKey(w) {
  const n = normWaybill(w);
  const digits = n.replace(/\D/g, '');
  return { has: n.length > 0, num: digits ? Number(digits) : Infinity, str: n };
}

export function compareWaybills(a, b) {
  const ka = waybillSortKey(a);
  const kb = waybillSortKey(b);
  if (ka.has !== kb.has) return ka.has ? -1 : 1; // blanks last
  if (ka.num !== kb.num) return ka.num - kb.num;
  return ka.str < kb.str ? -1 : ka.str > kb.str ? 1 : 0;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Compartments that actually carry product (a 0/0 or empty compartment is an empty trailer compartment). */
export function activeCompartments(extraction) {
  return (extraction?.compartments || []).filter((c) => {
    const o = num(c.ordered);
    const a = num(c.actual_load);
    // 0/0, 0/blank or blank/0 = empty trailer compartment. Fully blank rows are kept so they get flagged.
    return !((o === 0 || a === 0) && (o || 0) === 0 && (a || 0) === 0);
  });
}

/**
 * Build the computed row from an extraction, the mapping settings and the user's edits.
 * Returns { cells, flags, mapped } where flags[key] is one of:
 *  'blank'      field could not be read (left blank)
 *  'uncertain'  model read it but marked it as uncertain
 *  'unmapped'   full name shown because there is no short name yet
 *  'error'      a validation check failed on this cell
 */
export function buildRow(extraction, settings, edits = {}) {
  const x = extraction || {};
  const unreadable = new Set((x.unreadable_fields || []).map(String));
  const uncertain = new Set((x.uncertain_fields || []).map(String));

  const productCode = mapProduct(settings, x.product_name);
  const bdcShort = mapCompany(settings, x.supplier);
  const omcShort = mapCompany(settings, x.customer);

  const cells = {
    no: '',
    date: formatDayMonth(x.date_iso),
    truck: x.truck_number || '',
    orderNo: x.customer_order_number || '',
    waybill: x.waybill_no || '',
    product: productCode || x.product_name || '',
    transporter: x.transporter || '',
    depot: 'SORL',
    bdc: bdcShort || x.supplier || '',
    omc: omcShort || x.customer || '',
    ordered: num(x.order_qty_20c) ?? '',
    loaded: num(x.loaded_gross) ?? '',
  };

  const sourceField = {
    date: 'date',
    truck: 'truck_number',
    orderNo: 'customer_order_number',
    waybill: 'waybill_no',
    product: 'product_name',
    transporter: 'transporter',
    bdc: 'supplier',
    omc: 'customer',
    ordered: 'order_qty_20c',
    loaded: 'loaded_gross',
  };

  const flags = {};
  for (const [key, field] of Object.entries(sourceField)) {
    if (cells[key] === '' || unreadable.has(field)) flags[key] = 'blank';
    else if (uncertain.has(field)) flags[key] = 'uncertain';
  }
  if (x.date && !cells.date) flags.date = 'blank';
  if (x.product_name && !productCode) flags.product = 'unmapped';
  if (x.supplier && !bdcShort) flags.bdc = 'unmapped';
  if (x.customer && !omcShort) flags.omc = 'unmapped';

  for (const [k, v] of Object.entries(edits || {})) {
    if (k in cells) {
      cells[k] = NUMERIC_KEYS.has(k) ? (num(v) ?? (v === '' ? '' : v)) : String(v);
      if (cells[k] === '') flags[k] = 'blank';
      else delete flags[k];
    }
  }

  return {
    cells,
    flags,
    mapped: { productCode, bdcShort, omcShort },
  };
}

/**
 * Validation checks for one row. Returns a list of { level: 'error'|'warn', field?, msg }.
 * ctx: { selectedDay: 'YYYY-MM-DD', sessionWaybills: Map<normWaybill, count>, sheetWaybills: Map<normWaybill, [where]> }
 */
export function validateRow(extraction, cells, ctx = {}) {
  const issues = [];
  const x = extraction || {};

  if (x.is_sorl_waybill === false) {
    issues.push({ level: 'error', msg: 'This does not look like a SORL waybill.' });
  }

  // Compartment totals
  const comps = activeCompartments(x);
  if (comps.length) {
    const actuals = comps.map((c) => num(c.actual_load));
    const ordereds = comps.map((c) => num(c.ordered));
    const loaded = num(cells.loaded);
    const ordered = num(cells.ordered);
    if (actuals.some((v) => v === null)) {
      issues.push({ level: 'warn', field: 'loaded', msg: 'A compartment actual load is unreadable, so the LOADED total could not be checked.' });
    } else if (loaded !== null) {
      const sum = actuals.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - loaded) > 0.5) {
        issues.push({ level: 'error', field: 'loaded', msg: `Compartment actual loads add up to ${fmt(sum)} but LOADED GROSS is ${fmt(loaded)}.` });
      }
    }
    if (ordereds.some((v) => v === null)) {
      issues.push({ level: 'warn', field: 'ordered', msg: 'A compartment ordered quantity is unreadable, so the ORDERED total could not be checked.' });
    } else if (ordered !== null) {
      const sum = ordereds.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - ordered) > 0.5) {
        issues.push({ level: 'error', field: 'ordered', msg: `Compartment ordered quantities add up to ${fmt(sum)} but Order Quantity@20°C is ${fmt(ordered)}.` });
      }
    }
  } else if (x.compartments) {
    issues.push({ level: 'warn', msg: 'No loaded compartments were read, so totals could not be checked.' });
  }

  // Duplicates
  const wb = normWaybill(cells.waybill);
  if (wb) {
    if ((ctx.sessionWaybills?.get(wb) || 0) > 1) {
      issues.push({ level: 'error', field: 'waybill', msg: `Waybill ${cells.waybill} appears more than once in this batch.` });
    }
    const inSheet = ctx.sheetWaybills?.get(wb);
    if (inSheet && inSheet.length) {
      issues.push({ level: 'error', field: 'waybill', msg: `Waybill ${cells.waybill} is already in the workbook (${inSheet.join(', ')}).` });
    }
    if (!/^SORL\d{8}$/.test(wb)) {
      issues.push({ level: 'warn', field: 'waybill', msg: `Waybill number "${cells.waybill}" does not match the usual SORL######## pattern.` });
    }
  }

  // Date vs selected day
  if (ctx.selectedDay && cells.date && cells.date !== formatDayMonth(ctx.selectedDay)) {
    issues.push({ level: 'warn', field: 'date', msg: `Waybill date ${cells.date} differs from the selected day ${formatDayMonth(ctx.selectedDay)}.` });
  }

  // Ordered vs loaded sanity
  const o = num(cells.ordered);
  const l = num(cells.loaded);
  if (o !== null && l !== null && o > 0 && Math.abs(l - o) / o > 0.05) {
    issues.push({ level: 'warn', field: 'loaded', msg: `LOADED (${fmt(l)}) differs from ORDERED (${fmt(o)}) by more than 5%.` });
  }

  return issues;
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/** Count normalised waybill numbers across rows. */
export function countWaybills(cellRows) {
  const m = new Map();
  for (const c of cellRows) {
    const w = normWaybill(c.waybill);
    if (w) m.set(w, (m.get(w) || 0) + 1);
  }
  return m;
}

/** Assign NO. from the start number, in the given order. */
export function numberRows(cellRows, startNo) {
  const start = Number.isFinite(Number(startNo)) ? Number(startNo) : 1;
  cellRows.forEach((c, i) => {
    c.no = start + i;
  });
  return cellRows;
}

/** Tab-separated, no header, one line per row, ready to paste into Excel/WPS. */
export function toTSV(cellRows) {
  return cellRows
    .map((c) =>
      COLUMNS.map(({ key }) => {
        const v = c[key];
        if (v === null || v === undefined) return '';
        return String(v).replace(/[\t\r\n]+/g, ' ').trim();
      }).join('\t'),
    )
    .join('\r\n');
}

/** Notes shown in the UI (not copied): all destinations plus anything the model flagged. */
export function buildNotes(extraction) {
  const x = extraction || {};
  const parts = [];
  const dests = (x.destinations || []).filter(Boolean);
  if (dests.length > 1) parts.push(`Destinations: ${dests.join('; ')}`);
  else if (dests.length === 1) parts.push(`Destination: ${dests[0]}`);
  if (x.notes) parts.push(x.notes);
  return parts.join(' | ');
}
