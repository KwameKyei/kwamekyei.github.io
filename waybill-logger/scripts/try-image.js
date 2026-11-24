// Read one or more waybill photos from the command line and print the extracted row and checks.
// Usage: npm run try-image -- path\to\photo1.jpg [photo2.jpg ...] [--day 2026-11-23]
import 'dotenv/config';
import fs from 'node:fs/promises';
import { extractWaybill, describeError } from '../lib/extract.js';
import { getSettings, detectMediaType } from '../lib/store.js';
import { buildRow, validateRow, countWaybills, toTSV, buildNotes } from '../public/shared.js';

const args = process.argv.slice(2);
const dayIdx = args.indexOf('--day');
const day = dayIdx >= 0 ? args.splice(dayIdx, 2)[1] : undefined;
if (!args.length) {
  console.log('Usage: npm run try-image -- photo.jpg [more.jpg ...] [--day YYYY-MM-DD]');
  process.exit(1);
}
const settings = await getSettings();
for (const file of args) {
  const buf = await fs.readFile(file);
  const type = detectMediaType(buf);
  if (!type) { console.log(`${file}: not a JPEG/PNG/WebP image`); continue; }
  if (buf.length > 5 * 1024 * 1024) { console.log(`${file}: larger than 5 MB; resize it first (the web app does this automatically)`); continue; }
  try {
    const { extraction } = await extractWaybill(buf, type);
    const { cells, flags } = buildRow(extraction, settings);
    const issues = validateRow(extraction, cells, { selectedDay: day, sessionWaybills: countWaybills([cells]) });
    console.log(`\n=== ${file}`);
    console.log(JSON.stringify(extraction, null, 2));
    console.log('Row:', toTSV([cells]).replace(/\t/g, ' | '));
    console.log('Flags:', flags);
    console.log('Notes:', buildNotes(extraction));
    console.log('Issues:', issues.length ? issues.map((i) => `${i.level}: ${i.msg}`).join('\n        ') : 'none');
  } catch (e) {
    console.log(`${file}: ${describeError(e).message}`);
  }
}
