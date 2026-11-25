import {
  COLUMNS, NUMERIC_KEYS, buildRow, validateRow, countWaybills, numberRows, toTSV, buildNotes,
  compareWaybills, tabNameForDay, formatDayMonth, activeCompartments, normWaybill,
} from './shared.js';

const $ = (sel) => document.querySelector(sel);
const CONCURRENCY = 3;
const MAX_EDGE = 2400; // px, long edge after downsizing
const JPEG_QUALITY = 0.88;

const state = {
  day: todayISO(),
  startNo: 1,
  rows: [], // { id, fileName, status, progress, error, extraction, edits, imageUrl, appended }
  settings: { products: {}, companies: {} },
  workbook: null, // { file, info, sheet }
  sheetWaybills: new Map(),
  openDetails: new Set(),
};

// ---------- utilities ----------
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let body = {};
    try { body = await res.clone().json(); } catch { /* not JSON */ }
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res;
}

const fmtNum = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? (v ?? '') : Number(v).toLocaleString('en-US'));

// ---------- image downsizing ----------
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file is not an image the browser can open (try JPEG/PNG).'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('Network error: is the Waybill Logger server still running?'));
    xhr.send(formData);
  });
}

// ---------- processing queue ----------
const queue = [];
let active = 0;

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!files.length) return toast('No images found in that selection.');
  for (const file of files) {
    const row = { id: newId(), fileName: file.name, status: 'queued', progress: 0, error: '', extraction: null, edits: {}, imageUrl: '' };
    state.rows.push(row);
    queue.push({ row, file });
  }
  render();
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).finally(() => {
      active--;
      pump();
    });
  }
}

async function runJob({ row, file, rerun }) {
  const update = (patch) => {
    Object.assign(row, patch);
    renderRowStatus(row);
  };
  try {
    let res;
    if (rerun) {
      update({ status: 'reading', progress: 1, error: '' });
      res = await fetch(`/api/extract/${row.id}/rerun`, { method: 'POST' }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));
    } else {
      update({ status: 'preparing', progress: 0 });
      const blob = await prepareImage(file);
      const fd = new FormData();
      fd.append('id', row.id);
      fd.append('image', blob, `${row.id}.jpg`);
      update({ status: 'uploading', progress: 0 });
      res = await uploadWithProgress('/api/extract', fd, (p) => {
        row.progress = p;
        if (p >= 1) row.status = 'reading';
        renderRowStatus(row);
      });
    }
    if (res.body.imageUrl) row.imageUrl = res.body.imageUrl;
    if (!res.ok) throw new Error(res.body.error || 'Extraction failed');
    row.extraction = res.body.extraction;
    row.model = res.body.model;
    row.cost = res.body.cost;
    row.escalated = !!res.body.escalated;
    row.status = 'done';
    row.error = '';
  } catch (e) {
    row.status = 'error';
    row.error = e.message;
  }
  render();
  scheduleSave();
  refreshUsage();
}

// ---------- API spend ----------
let usageTimer;
function refreshUsage() {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(async () => {
    try {
      state.usage = await (await api('/api/usage')).json();
      render();
      renderUsageStats();
    } catch { /* not important */ }
  }, 300);
}
const money = (n) => `$${(n || 0).toFixed(n >= 1 ? 2 : 3)}`;

function renderUsageStats() {
  const u = state.usage;
  if (!u || !u.calls) return;
  const fails = Object.entries(u.checkFailures || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const firsts = u.calls - u.escalations;
  $('#usageStats').innerHTML = `
    <p>${u.waybills} photo(s), ${u.calls} API call(s), ≈ ${money(u.cost)} (${money(u.costPerWaybill)} per photo).
      ${u.escalations ? `${u.escalations} re-checked.` : ''} ${u.cachedHits ? `${u.cachedHits} repeat photo(s) reused for free.` : ''}</p>
    <p>Tokens: ${u.inputTokens.toLocaleString()} in (${u.cacheReadTokens.toLocaleString()} from cache), ${u.outputTokens.toLocaleString()} out.</p>
    ${fails.length ? `<p><b>Most common failed checks</b> (out of ${firsts} first reading(s)):</p>
    <ul>${fails.map(([k, n]) => `<li>${esc(k)}: <b>${n}</b></li>`).join('')}</ul>` : ''}`;
}

function rerunRow(id) {
  const row = state.rows.find((r) => r.id === id);
  if (!row) return;
  if (Object.keys(row.edits).length && !confirm('Re-running will discard your edits on this row. Continue?')) return;
  row.edits = {};
  row.status = 'queued';
  queue.push({ row, rerun: true });
  render();
  pump();
}

function removeRow(id) {
  const row = state.rows.find((r) => r.id === id);
  if (!row) return;
  if (!confirm(`Remove ${row.extraction?.waybill_no || row.fileName} from the list?`)) return;
  state.rows = state.rows.filter((r) => r.id !== id);
  const qi = queue.findIndex((j) => j.row.id === id);
  if (qi >= 0) queue.splice(qi, 1);
  render();
  scheduleSave();
}

// ---------- computed rows ----------
function computeAll() {
  const built = state.rows.map((row) => {
    const b = row.extraction ? buildRow(row.extraction, state.settings, row.edits) : null;
    return { row, built: b };
  });
  // Sort: rows with data by waybill number, then rows still processing / failed.
  built.sort((a, b) => {
    if (!!a.built !== !!b.built) return a.built ? -1 : 1;
    if (!a.built) return 0;
    return compareWaybills(a.built.cells.waybill, b.built.cells.waybill);
  });
  const cellRows = built.filter((x) => x.built).map((x) => x.built.cells);
  numberRows(cellRows, state.startNo);
  const sessionWaybills = countWaybills(cellRows);
  for (const x of built) {
    if (!x.built) continue;
    if ('no' in x.row.edits && x.row.edits.no !== '') x.built.cells.no = Number(x.row.edits.no) || x.row.edits.no;
    x.issues = validateRow(x.row.extraction, x.built.cells, { selectedDay: state.day, sessionWaybills, sheetWaybills: state.sheetWaybills });
    for (const i of x.issues) if (i.level === 'error' && i.field) x.built.flags[i.field] = 'error';
    // A cell the model could not read stays "blank" even if a check also failed on it.
    for (const [k, v] of Object.entries(x.built.flags)) if (v === 'error' && x.built.cells[k] === '') x.built.flags[k] = 'blank';
  }
  return built;
}

// ---------- rendering ----------
function renderHead() {
  $('#gridHead').innerHTML =
    '<th class="sticky">Row</th>' +
    COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('') +
    '<th class="notes-col">NOTES (not copied)</th>';
}

const STATUS_TEXT = {
  queued: 'Waiting…', preparing: 'Preparing…', uploading: 'Uploading', reading: 'Reading…', done: 'Done', error: 'Failed',
};

function statusHtml(row) {
  const pct = Math.round((row.progress || 0) * 100);
  let bar = '';
  if (row.status === 'uploading') bar = `<div class="progress"><div style="width:${pct}%"></div></div>`;
  else if (row.status === 'reading' || row.status === 'preparing') bar = '<div class="progress indeterminate"><div></div></div>';
  const label = row.status === 'uploading' ? `Uploading ${pct}%` : STATUS_TEXT[row.status] || row.status;
  return `<span class="status">${esc(label)}${bar}</span>`;
}

function renderRowStatus(row) {
  const el = document.querySelector(`[data-status-for="${row.id}"]`);
  if (el) el.innerHTML = statusHtml(row);
}

function render() {
  const built = computeAll();
  const hasRows = state.rows.length > 0;
  $('#tableWrap').hidden = !hasRows;
  $('#legend').hidden = !hasRows;
  $('#actions').hidden = !built.some((x) => x.built);
  $('#summary').hidden = !hasRows;

  let errors = 0;
  let warns = 0;
  let loaded = 0;
  const html = [];
  for (const x of built) {
    const { row, built: b } = x;
    const issues = x.issues || [];
    const hasErr = issues.some((i) => i.level === 'error') || (b && Object.values(b.flags).some((f) => f === 'blank' || f === 'unmapped'));
    const hasWarn = issues.some((i) => i.level === 'warn');
    if (b) {
      if (hasErr) errors++;
      else if (hasWarn) warns++;
      if (Number.isFinite(Number(b.cells.loaded)) && b.cells.loaded !== '') loaded += Number(b.cells.loaded);
    }
    const rowClass = !b ? (row.status === 'error' ? 'row-error' : '') : hasErr ? 'row-error' : hasWarn ? 'row-warn' : 'row-ok';
    const busy = !['done', 'error'].includes(row.status);
    const ctrl = `<td class="sticky"><div class="row-ctrl">
        <span data-status-for="${row.id}">${statusHtml(row)}</span>
        ${b ? `<button class="icon-btn" data-act="details" data-id="${row.id}" title="Details">${state.openDetails.has(row.id) ? '▾' : '▸'}</button>` : ''}
        <button class="icon-btn" data-act="rerun" data-id="${row.id}" title="Re-run" ${busy || !row.imageUrl ? 'disabled' : ''}>↻</button>
        <button class="icon-btn" data-act="remove" data-id="${row.id}" title="Remove">✕</button>
        ${row.appended ? `<span class="badge" title="${esc(row.appended)}">appended</span>` : ''}
      </div></td>`;

    if (!b) {
      const msg = row.status === 'error' ? `⚠️ ${esc(row.error)}` : esc(row.fileName);
      html.push(`<tr class="${rowClass}">${ctrl}<td colspan="${COLUMNS.length + 1}" class="muted">${msg}</td></tr>`);
      continue;
    }

    const tds = COLUMNS.map(({ key }) => {
      const flag = b.flags[key];
      const cls = [flag ? `c-${flag}` : '', NUMERIC_KEYS.has(key) ? 'num' : ''].join(' ');
      const title = flag === 'unmapped' ? 'No short name saved for this. Tap to set one.' : flag === 'blank' ? 'Could not be read. Check the photo and type it in.' : '';
      const val = b.cells[key];
      const label = COLUMNS.find((c) => c.key === key).label;
      return `<td class="${cls}" data-label="${esc(label)}" title="${esc(title)}"><input data-id="${row.id}" data-key="${key}" value="${esc(val)}" ${NUMERIC_KEYS.has(key) ? 'inputmode="numeric"' : ''} size="${Math.max(6, String(val).length + 1)}"></td>`;
    }).join('');
    const notes = row.edits.__notes ?? buildNotes(row.extraction);
    html.push(`<tr class="${rowClass}">${ctrl}${tds}<td class="notes-col" data-label="NOTES (not copied)"><input data-id="${row.id}" data-key="__notes" value="${esc(notes)}" size="${Math.max(16, notes.length)}"></td></tr>`);
    if (state.openDetails.has(row.id)) html.push(detailsHtml(row, b, issues));
  }
  $('#gridBody').innerHTML = html.join('');

  const done = built.filter((x) => x.built).length;
  const pending = state.rows.filter((r) => !['done', 'error'].includes(r.status)).length;
  const failed = state.rows.filter((r) => r.status === 'error' && !r.extraction).length;
  $('#summary').innerHTML = [
    `<span class="chip">${done} waybill${done === 1 ? '' : 's'}</span>`,
    pending ? `<span class="chip">${pending} in progress</span>` : '',
    failed ? `<span class="chip bad">${failed} failed</span>` : '',
    errors ? `<span class="chip bad">${errors} need attention</span>` : '',
    warns ? `<span class="chip warn">${warns} with warnings</span>` : '',
    `<span class="chip">Loaded total ${fmtNum(loaded)} L</span>`,
    state.usage && state.usage.calls
      ? `<span class="chip" title="Estimated from token counts; your Anthropic bill is the final figure.">API today ≈ ${money(state.usage.cost)} · ${state.usage.waybills} photo(s) · ${money(state.usage.costPerWaybill)} each${state.usage.escalations ? ` · ${state.usage.escalations} re-checked` : ''}</span>`
      : '',
  ].join('');
}

function detailsHtml(row, b, issues) {
  const x = row.extraction || {};
  const active = new Set(activeCompartments(x));
  const comps = x.compartments || [];
  let sumO = 0;
  let sumA = 0;
  const compRows = comps.map((c) => {
    const isActive = active.has(c);
    if (isActive) { sumO += Number(c.ordered) || 0; sumA += Number(c.actual_load) || 0; }
    return `<tr class="${isActive ? '' : 'empty'}"><td>${esc(c.number ?? '')}</td><td>${c.ordered === null ? '<b>?</b>' : fmtNum(c.ordered)}</td><td>${c.actual_load === null ? '<b>?</b>' : fmtNum(c.actual_load)}</td><td>${c.temperature ?? '?'}</td></tr>`;
  }).join('');
  const list = (a) => (a && a.length ? a.map(esc).join(', ') : '—');
  return `<tr class="details"><td colspan="${COLUMNS.length + 2}"><div class="details-inner">
    <div>${row.imageUrl ? `<a href="${row.imageUrl}" target="_blank" rel="noopener"><img src="${row.imageUrl}" alt="Waybill photo" loading="lazy"></a>` : ''}
      <p class="muted">${esc(row.fileName)}</p></div>
    <div>
      ${issues.length ? `<ul class="issues">${issues.map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>` : '<p class="muted">✅ All checks passed.</p>'}
      <dl>
        <dt>Driver</dt><dd>${esc(x.driver) || '<b>?</b>'}</dd>
        <dt>Destination(s)</dt><dd>${list(x.destinations)}</dd>
        <dt>Loading start</dt><dd>${esc(x.loading_start) || '—'}</dd>
        <dt>Loading end</dt><dd>${esc(x.loading_end) || '—'}</dd>
        <dt>Waybill date</dt><dd>${esc(x.date) || '<b>?</b>'}</dd>
        <dt>Product</dt><dd>${esc(x.product_name) || '?'}</dd>
        <dt>Supplier (BDC)</dt><dd>${esc(x.supplier) || '?'}</dd>
        <dt>Customer (OMC)</dt><dd>${esc(x.customer) || '?'}</dd>
        <dt>Avg temperature</dt><dd>${x.average_temperature ?? '—'} °C</dd>
        <dt>Density</dt><dd>${x.density ?? '—'}</dd>
        <dt>Unreadable</dt><dd>${list(x.unreadable_fields)}</dd>
        <dt>Uncertain</dt><dd>${list(x.uncertain_fields)}</dd>
      </dl>
      <table class="comp-table">
        <thead><tr><th>Comp.</th><th>Ordered</th><th>Actual load</th><th>Temp °C</th></tr></thead>
        <tbody>${compRows || '<tr><td colspan="4">No compartments read</td></tr>'}</tbody>
        <tfoot><tr><td>Sum</td><td>${fmtNum(sumO)}</td><td>${fmtNum(sumA)}</td><td></td></tr>
        <tr><td>Totals</td><td>${fmtNum(x.order_qty_20c ?? '?')}</td><td>${fmtNum(x.loaded_gross ?? '?')}</td><td></td></tr></tfoot>
      </table>
      <p class="muted">Struck-through compartments are empty (0) and ignored.</p>
    </div></div></td></tr>`;
}

// ---------- table events ----------
$('#gridBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const { act, id } = btn.dataset;
    if (act === 'rerun') rerunRow(id);
    if (act === 'remove') removeRow(id);
    if (act === 'details') {
      state.openDetails.has(id) ? state.openDetails.delete(id) : state.openDetails.add(id);
      render();
    }
    return;
  }
  const input = e.target.closest('td.c-unmapped input');
  if (input) promptShortName(input.dataset.id, input.dataset.key);
});

$('#gridBody').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-key]');
  if (!input) return;
  const row = state.rows.find((r) => r.id === input.dataset.id);
  if (!row) return;
  const key = input.dataset.key;
  const value = input.value.trim();
  const fullName = { product: row.extraction?.product_name, bdc: row.extraction?.supplier, omc: row.extraction?.customer }[key];
  const td = input.closest('td');
  // Typing a short name over an unmapped full name: offer to remember it.
  if (fullName && td.classList.contains('c-unmapped') && value && value !== fullName) {
    if (confirm(`Remember "${value}" as the short name for "${fullName}"?`)) {
      await saveMapping(key === 'product' ? 'products' : 'companies', fullName, value);
      render();
      scheduleSave();
      return;
    }
  }
  row.edits[key] = value;
  render();
  scheduleSave();
});

async function promptShortName(id, key) {
  const row = state.rows.find((r) => r.id === id);
  const fullName = { product: row?.extraction?.product_name, bdc: row?.extraction?.supplier, omc: row?.extraction?.customer }[key];
  if (!fullName) return;
  const label = key === 'product' ? 'product code (e.g. AGO, PMS)' : 'short name';
  const value = prompt(`Enter the ${label} for:\n${fullName}`, '');
  if (!value || !value.trim()) return;
  await saveMapping(key === 'product' ? 'products' : 'companies', fullName, value.trim().toUpperCase());
  render();
  scheduleSave();
}

async function saveMapping(table, fullName, short) {
  state.settings[table][fullName] = short;
  try {
    const res = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.settings) });
    state.settings = await res.json();
    toast(`Saved: ${fullName} → ${short}`);
    renderSettings();
  } catch (e) {
    toast(`Could not save mapping: ${e.message}`);
  }
}

// ---------- export ----------
function exportRows() {
  const built = computeAll().filter((x) => x.built);
  const problems = built.filter((x) => (x.issues || []).some((i) => i.level === 'error') || Object.values(x.built.flags).some((f) => f === 'blank' || f === 'unmapped'));
  return { cells: built.map((x) => x.built.cells), built, problems };
}

function confirmProblems(problems, action) {
  if (!problems.length) return true;
  return confirm(`${problems.length} row(s) still have highlighted problems (blank, unmapped or failed checks). ${action} anyway?`);
}

$('#copyBtn').addEventListener('click', async () => {
  const { cells, problems } = exportRows();
  if (!cells.length) return toast('Nothing to copy yet.');
  if (!confirmProblems(problems, 'Copy')) return;
  const tsv = toTSV(cells);
  const fb = $('#copyFallback');
  try {
    await navigator.clipboard.writeText(tsv);
    fb.hidden = true;
    toast(`Copied ${cells.length} row(s). Paste into Excel/WPS.`);
  } catch {
    // Phones on http:// (not localhost) have no clipboard API: fall back to a selectable box.
    fb.hidden = false;
    fb.value = tsv;
    fb.focus();
    fb.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    toast(ok ? `Copied ${cells.length} row(s).` : 'Select the text below and copy it.');
  }
});

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$('#xlsxBtn').addEventListener('click', async () => {
  const { cells, problems } = exportRows();
  if (!cells.length) return toast('Nothing to export yet.');
  if (!confirmProblems(problems, 'Download')) return;
  try {
    const sheet = tabNameForDay(state.day) || 'Waybills';
    const res = await api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: cells, sheet }) });
    downloadBlob(await res.blob(), `waybills-${sheet}.xlsx`);
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  }
});

// ---------- workbook append ----------
$('#workbookInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append('workbook', file);
    const info = await (await api('/api/workbook/inspect', { method: 'POST', body: fd })).json();
    state.workbook = { file, info, sheet: null };
    state.sheetWaybills = new Map(Object.entries(info.waybills));
    const sel = $('#sheetSelect');
    sel.innerHTML = info.sheets.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    const want = tabNameForDay(state.day);
    const match = info.sheets.find((s) => s.name.trim() === want) || info.sheets.find((s) => s.name.replace(/[.\s/]/g, '-').startsWith(want));
    sel.value = (match || info.sheets[info.sheets.length - 1]).name;
    if (!match) toast(`No tab named "${want}" found. Pick the right tab.`, 4000);
    $('#workbookName').textContent = `📄 ${file.name} — ${Object.keys(info.waybills).length} waybill numbers found`;
    $('#workbookPanel').hidden = false;
    updateSheetInfo();
    render();
  } catch (err) {
    toast(`Could not read workbook: ${err.message}`, 4000);
  }
});

function updateSheetInfo() {
  const wb = state.workbook;
  if (!wb) return;
  wb.sheet = $('#sheetSelect').value;
  const s = wb.info.sheets.find((x) => x.name === wb.sheet);
  const n = exportRows().cells.length;
  const header = s.positional
    ? '⚠️ Header row not recognised: rows will be written to columns A–L in the standard order.'
    : `Header found on row ${s.headerRow}.`;
  $('#sheetInfo').textContent = `${header} Last used row: ${s.lastRow}. ${n} row(s) will go to rows ${s.lastRow + 1}–${s.lastRow + n}.`;
}
$('#sheetSelect').addEventListener('change', updateSheetInfo);

$('#appendBtn').addEventListener('click', async () => {
  const wb = state.workbook;
  if (!wb) return;
  const { cells, built, problems } = exportRows();
  if (!cells.length) return toast('Nothing to append yet.');
  const dupes = built.filter((x) => state.sheetWaybills.has(normWaybill(x.built.cells.waybill)));
  if (dupes.length && !confirm(`${dupes.length} waybill(s) are already in this workbook. Append them again?`)) return;
  if (!confirmProblems(problems, 'Append')) return;
  if (wb.sheet !== tabNameForDay(state.day) && !confirm(`You picked tab "${wb.sheet}" but the selected day is ${tabNameForDay(state.day)}. Continue?`)) return;
  try {
    const fd = new FormData();
    fd.append('workbook', wb.file);
    fd.append('sheet', wb.sheet);
    fd.append('rows', JSON.stringify(cells));
    fd.append('year', state.day.slice(0, 4));
    const res = await api('/api/workbook/append', { method: 'POST', body: fd });
    const range = res.headers.get('X-Appended-Rows');
    downloadBlob(await res.blob(), wb.file.name);
    for (const x of built) x.row.appended = `${wb.file.name} / ${wb.sheet} rows ${range}`;
    toast(`Appended ${cells.length} row(s) to "${wb.sheet}" (rows ${range}). Save the downloaded file over the old one.`, 6000);
    render();
    scheduleSave();
  } catch (e) {
    toast(`Append failed: ${e.message}`, 5000);
  }
});

// ---------- history ----------
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveHistoryNow, 800);
}
function historyPayload() {
  const rows = state.rows.map(({ id, fileName, status, error, extraction, edits, imageUrl, appended, model, cost, escalated }) => ({
    id, fileName, status: ['done', 'error'].includes(status) ? status : 'error',
    error: ['done', 'error'].includes(status) ? error : 'Interrupted. Press ↻ to re-run.',
    extraction, edits, imageUrl, appended, model, cost, escalated,
  }));
  return JSON.stringify({ startNo: state.startNo, rows });
}
async function saveHistoryNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await api(`/api/history/${state.day}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: historyPayload() });
    if (!document.querySelector(`#historyDays [data-day="${state.day}"]`)) loadHistoryDays();
  } catch (e) {
    toast(`Could not save history: ${e.message}`);
  }
}

// Leaving or hiding the page (closing the tab, switching apps on a phone): save at once.
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const body = historyPayload();
  // Browsers cap keepalive requests at 64 KB; larger days use a normal request.
  fetch(`/api/history/${state.day}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 }).catch(() => {});
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushSave());
window.addEventListener('pagehide', flushSave);

async function loadDay(day) {
  if (state.rows.some((r) => !['done', 'error'].includes(r.status))) {
    toast('Wait for the current images to finish first.');
    $('#day').value = state.day;
    return;
  }
  clearTimeout(saveTimer);
  if (state.rows.length) await saveHistoryNow();
  state.day = day;
  $('#day').value = day;
  $('#tabName').textContent = tabNameForDay(day) || '--';
  try {
    const h = await (await api(`/api/history/${day}`)).json();
    state.rows = (h.rows || []).map((r) => ({ progress: 1, edits: {}, ...r }));
    state.startNo = h.startNo || 1;
  } catch {
    state.rows = [];
    state.startNo = 1;
  }
  $('#startNo').value = state.startNo;
  state.openDetails.clear();
  render();
  updateSheetInfo();
  loadHistoryDays();
}

async function loadHistoryDays() {
  try {
    const { days } = await (await api('/api/history')).json();
    $('#historyDays').innerHTML = days.length
      ? days.slice(0, 30).map((d) => `<button class="btn btn-small" data-day="${d}" ${d === state.day ? 'disabled' : ''}>${formatDayMonth(d)} ${d.slice(0, 4)}</button>`).join('')
      : '<span class="muted">No saved days yet.</span>';
  } catch { /* ignore */ }
}
$('#historyDays').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]');
  if (b) loadDay(b.dataset.day);
});

// ---------- settings page ----------
function mapRowHtml(table, k, v) {
  return `<tr data-table="${table}"><td><input value="${esc(k)}" data-f="k"></td><td><input value="${esc(v)}" data-f="v"></td>
    <td><button class="icon-btn" data-del title="Delete">✕</button></td></tr>`;
}
function renderSettings() {
  const p = Object.entries(state.settings.products).sort(([a], [b]) => a.localeCompare(b));
  const c = Object.entries(state.settings.companies).sort(([a], [b]) => a.localeCompare(b));
  $('#productTable tbody').innerHTML = p.map(([k, v]) => mapRowHtml('products', k, v)).join('');
  $('#companyTable tbody').innerHTML = c.map(([k, v]) => mapRowHtml('companies', k, v)).join('');
  applyCompanyFilter();
}
function readSettingsForm() {
  const out = { products: {}, companies: {} };
  document.querySelectorAll('.map-table tbody tr').forEach((tr) => {
    const k = tr.querySelector('[data-f=k]').value.trim();
    const v = tr.querySelector('[data-f=v]').value.trim();
    if (k && v) out[tr.dataset.table][k] = v;
  });
  return out;
}
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
  const table = b.dataset.add;
  const tbody = $(table === 'products' ? '#productTable tbody' : '#companyTable tbody');
  tbody.insertAdjacentHTML('beforeend', mapRowHtml(table, '', ''));
  tbody.lastElementChild.querySelector('input').focus();
}));
document.querySelectorAll('.map-table').forEach((t) => t.addEventListener('click', (e) => {
  if (e.target.closest('[data-del]')) e.target.closest('tr').remove();
}));
function applyCompanyFilter() {
  const q = $('#companyFilter').value.trim().toUpperCase();
  document.querySelectorAll('#companyTable tbody tr').forEach((tr) => {
    const text = [...tr.querySelectorAll('input')].map((i) => i.value).join(' ').toUpperCase();
    tr.hidden = q && !text.includes(q);
  });
}
$('#companyFilter').addEventListener('input', applyCompanyFilter);
$('#saveSettings').addEventListener('click', async () => {
  try {
    const res = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readSettingsForm()) });
    state.settings = await res.json();
    renderSettings();
    render();
    $('#settingsStatus').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    toast('Settings saved');
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  }
});

// ---------- tabs, inputs, drag & drop ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${t.dataset.page}`));
}));
$('#cameraInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#day').addEventListener('change', (e) => e.target.value && loadDay(e.target.value));
$('#startNo').addEventListener('change', (e) => {
  state.startNo = Math.max(1, parseInt(e.target.value, 10) || 1);
  e.target.value = state.startNo;
  render();
  scheduleSave();
});
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('over'); }));
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
window.addEventListener('beforeunload', (e) => {
  if (state.rows.some((r) => !['done', 'error'].includes(r.status))) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- startup ----------
(async function init() {
  renderHead();
  try {
    state.settings = await (await api('/api/settings')).json();
  } catch (e) {
    toast(`Could not load settings: ${e.message}`);
  }
  renderSettings();
  try {
    const h = await (await api('/api/health')).json();
    $('#serverInfo').textContent = `Model: ${h.model} · effort: ${h.effort}${h.escalateModel ? ` · re-check failed readings with ${h.escalateModel} (${h.escalateEffort})` : ''} · API key: ${h.hasKey ? 'set' : 'MISSING'}${h.mock ? ' · MOCK MODE (sample data, no API calls)' : ''}`;
    const w = $('#keyWarning');
    if (h.mock) { w.hidden = false; w.textContent = 'Mock mode is on: photos are not read, each image returns one of two sample waybills.'; }
    else if (!h.hasKey) { w.hidden = false; w.textContent = 'The Claude API key is missing. Add ANTHROPIC_API_KEY to the .env file and restart the server.'; }
  } catch { /* ignore */ }
  await loadDay(state.day);
  refreshUsage();
})();
