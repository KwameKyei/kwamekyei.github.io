// Local storage on disk: mapping settings and per-day history (JSON files under DATA_DIR).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
  products: {
    'GASOIL 50PPM': 'AGO',
    'PREMIUM/GASOLINE': 'PMS',
    PREMIUM: 'PMS',
    GASOLINE: 'PMS',
    'HEAVY FUEL OIL': 'HFO',
  },
  companies: {
    'MPB PETROLEUM LIMITED': 'MPB',
    'SAGE DISTRIBUTION LIMITED': 'SAGE',
  },
};

export async function ensureDirs() {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

function cleanTable(t) {
  const out = {};
  for (const [k, v] of Object.entries(t || {})) {
    const key = String(k).trim();
    const val = String(v ?? '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

export async function getSettings() {
  try {
    const s = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    return { products: cleanTable(s.products), companies: cleanTable(s.companies) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await writeJsonAtomic(SETTINGS_FILE, DEFAULT_SETTINGS);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(s) {
  const clean = { products: cleanTable(s?.products), companies: cleanTable(s?.companies) };
  await writeJsonAtomic(SETTINGS_FILE, clean);
  return clean;
}

const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function getHistory(day) {
  if (!DAY_RX.test(day)) throw Object.assign(new Error('Bad day'), { status: 400 });
  try {
    return JSON.parse(await fs.readFile(path.join(HISTORY_DIR, `${day}.json`), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { day, startNo: 1, rows: [] };
    throw e;
  }
}

export async function saveHistory(day, data) {
  if (!DAY_RX.test(day)) throw Object.assign(new Error('Bad day'), { status: 400 });
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const doc = { day, startNo: Number(data?.startNo) || 1, savedAt: new Date().toISOString(), rows };
  await writeJsonAtomic(path.join(HISTORY_DIR, `${day}.json`), doc);
  return doc;
}

export async function listHistoryDays() {
  const files = await fs.readdir(HISTORY_DIR).catch(() => []);
  return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
}

const ID_RX = /^[A-Za-z0-9_-]{6,64}$/;

export function imagePath(id) {
  if (!ID_RX.test(id)) throw Object.assign(new Error('Bad image id'), { status: 400 });
  return path.join(IMAGE_DIR, `${id}.img`);
}

/** Detect an image type from its first bytes. Returns null for anything Claude cannot read. */
export function detectMediaType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}
