# Waybill Logger

Turns photos of Sentuo Oil Refinery (SORL) waybills into rows for the daily loading spreadsheet.

1. Take or choose photos of one or many waybills (phone camera, file picker, or drag and drop on a PC).
2. Each photo is downsized in the browser and sent to a small local server. The server sends it to the Claude API, which returns strict JSON. **The API key stays on the server and never reaches the browser.**
3. The results appear in an editable table, one row per waybill, sorted by waybill number. Unreadable cells and failed checks are highlighted.
4. When you have reviewed the rows, you can:
   - **Copy rows**: tab-separated with no header, ready to paste into Excel or WPS.
   - **Download .xlsx**: a new file with a header row.
   - **Append to an existing workbook**: upload the workbook, pick the day's tab (for example `23-11`), and the rows are added below the last used row. Formatting is kept and formulas are copied down. You get the updated file back as a download.

Output columns, in this order:

`NO. | DATE | TRUCK NUM | ORDER NO. | WAYBILL NO. | PRODUCT | TRANSPORTER | DEPOT | BDC | OMC | ORDERED @20 (L) | LOADED (L)`

There is no temperature-compensation column. The spreadsheet calculates it.

The row details (tap ▸) also show what is not copied: driver, destination(s), loading start and end, the compartment table (ordered, actual load, temperature), average temperature, density, and the original photo.

---

## Run it on Windows

### One-time setup

1. Install **Node.js LTS** (version 22 or newer) from <https://nodejs.org>. Accept the defaults.
2. Copy the `waybill-logger` folder to the PC, for example `C:\WaybillLogger`.
3. Double-click **`start.bat`**. The first time, it creates a `.env` file and opens it in Notepad.
4. Replace `sk-ant-your-key-here` with your Claude API key (from <https://console.anthropic.com>). Save the file and close Notepad.
5. Double-click **`start.bat`** again. It installs the dependencies (about a minute, only the first time), starts the server and opens <http://localhost:3000>.

Keep the black window open while you use the app. Closing it stops the server.

### Every day

Double-click `start.bat`.

### Use it from a phone

1. Connect the phone to the same Wi-Fi as the PC.
2. The black window prints a line such as `On your phone: http://192.168.1.23:3000`. Open that address in the phone's browser.
3. If Windows Firewall asks, allow Node.js on **private networks**.
4. Optional: in the browser menu, choose "Add to Home screen".

On a phone opened through the network address, the browser does not let pages write to the clipboard directly. "Copy rows" then shows the rows in a text box with the text selected. Use the phone's Copy command.

> Without a PIN, anyone on the same network who can reach the PC can use the app, and through it your API key. Set `ACCESS_PIN` in `.env` to require a PIN on every device, or set `HOST=127.0.0.1` to allow only the PC itself.

### Command-line alternative

```bat
cd C:\WaybillLogger
copy .env.example .env
notepad .env
npm install
npm start
```

### Try it without an API key

```bat
npm install
npm run demo
```

Demo mode does not send anything to Claude. Each photo returns one of two sample waybills, so you can try the table, the highlights, mapping, copying and exporting.

---

## Host it online on Render (with a PIN)

This gives you a permanent `https://…onrender.com` link that works from any phone or PC, with no PC left running. The repository root has a `render.yaml` Blueprint that sets everything up.

**Cost:** saving settings, history and photos needs a persistent disk, and Render only offers disks on paid instances. The Blueprint uses the **Starter** instance with a 1 GB disk, about US$7–8 a month at the time of writing (check Render's pricing page). Claude API usage is billed separately by Anthropic.

1. Sign up at <https://render.com> and connect your GitHub account.
2. In the Render dashboard, choose **New → Blueprint** and pick the `kwamekyei.github.io` repository. Render reads `render.yaml` and shows a `waybill-logger` web service with a disk.
3. Render asks for two values:
   - `ANTHROPIC_API_KEY`: your Claude API key.
   - `ACCESS_PIN`: the PIN everyone will type to open the app. Use at least 6 digits, and don't reuse a bank or phone PIN.
4. Click **Apply**. The first build takes a few minutes. When it's live, your link is at the top of the service page, for example `https://waybill-logger.onrender.com` (Render may add a suffix if the name is taken).
5. Open the link on your phone, enter the PIN, and add it to your home screen.

How the PIN works:

- Every API call (reading photos, settings, history, workbooks, images) needs the PIN. The PIN screen appears on first use, and each device stays signed in for 30 days.
- After 5 wrong PINs from one device, that device has to wait 15 minutes. After 30 wrong PINs from all devices together, every login pauses for 15 minutes.
- To change the PIN, edit `ACCESS_PIN` under the service's **Environment** tab in Render. Render redeploys, and every device must enter the new PIN.
- **Settings → Lock this device** signs the current device out.
- On Render the server refuses to start without `ACCESS_PIN`, so it can't go public unprotected by accident.

Notes for the hosted version:

- Render deploys again automatically every time `main` changes on GitHub.
- The site uses HTTPS, so **Copy rows** writes to the phone's clipboard directly.
- Your data lives on the Render disk (`/var/data`). Render takes daily disk snapshots. You can also download files with the service's **Shell** tab.
- The workbook-append feature works the same: upload the workbook, and download the updated file.
- To run it for free instead, change `plan: starter` to `plan: free` in `render.yaml` and delete the `disk:` block and the `DATA_DIR` entry. Be aware that free services sleep after 15 minutes idle (the first visit then takes about a minute), and **settings, history and photos are wiped on every restart or deploy**.

---

## Daily workflow

1. Set **Day**. The sheet tab name (for example `23-11`) is worked out from the day. Set **Start NO.** to the next number in your sheet.
2. Tap **Take photo** (one at a time) or **Choose photos** (many at once). Each row shows its own progress: Preparing, Uploading %, Reading, then Done or Failed.
3. Review the rows. Colours:
   - **Red outline**: unreadable or blank. The app never guesses, so type the value in from the paper.
   - **Yellow**: the model read it but was not sure. Check it against the photo.
   - **Orange, italic**: a full company or product name with no short name yet. Tap it and enter the short name (for example `NEWCO`). It is saved in Settings and used automatically from then on.
   - **Red fill**: a failed check (totals mismatch or duplicate).
   - The coloured bar on the left of each row is red (needs attention), amber (warnings) or green (all good).
4. Tap **▸** to see the photo, compartments, checks and extra fields. Use **↻** to re-read one photo, or **✕** to remove a row.
5. Copy, download, or append.

Each day's rows (including your edits and the photos) are saved on the PC automatically. Reopen any day from **History**, or pick the date.

## Checks

- The sum of compartment **actual loads** must equal **LOADED GROSS**, and the sum of compartment **ordered** quantities must equal **Order Quantity@20°C**. Compartments showing 0 are empty trailer compartments and are ignored. If any compartment value is unreadable, the total is not checked and you get a warning.
- **Duplicate waybill numbers** in the current batch, and in the uploaded workbook (all tabs), are flagged.
- A warning appears when the **waybill date differs from the selected day**.
- Waybill numbers that do not look like `SORL` followed by 8 digits get a warning.
- A warning appears when LOADED differs from ORDERED by more than 5%.
- If the photo is not a SORL waybill, the row is flagged.
- When there are several destinations, the waybill stays one row and all destinations are listed in **NOTES**. NOTES is shown in the app but not copied or exported.

Copy, download and append still work when some rows have problems, but the app asks you to confirm first.

## Settings (mapping tables)

The **Settings** tab has two editable tables, saved to `data/settings.json`:

- **Products**: `GASOIL 50PPM → AGO`, `PREMIUM/GASOLINE → PMS` (plus `PREMIUM` and `GASOLINE` on their own), `HEAVY FUEL OIL → HFO`.
- **Companies**: `MPB PETROLEUM LIMITED → MPB`, `SAGE DISTRIBUTION LIMITED → SAGE`, and every short name you add while reviewing.

Matching ignores letter case, extra spaces and punctuation, but otherwise must be exact, so a name is never mapped by guesswork.

## Appending to the workbook

- The app looks for the header row (the row containing `WAYBILL NO.` and the other headings) in the first 30 rows of the tab and writes each value under its matching heading. If no header is found, it writes to columns A–L in the standard order and tells you so.
- The "last used row" is the last row with a waybill or truck number. Blank pre-formatted rows below it, even ones with formulas already filled in, are used. If a TOTAL row or other text is in the way, the append stops and asks you to insert blank rows above it first. Existing text and totals are never overwritten.
- New rows take the cell formatting of the last data row. Formulas in other columns (such as temperature compensation) are copied down with their row references adjusted. Excel and WPS recalculate them when the file opens.
- If the existing DATE column holds real dates, DATE is written as a date (keeping the `d-mmm` format). Otherwise it is written as the text `23-Nov`.
- The download has the same file name as your workbook. Save it over the old one, or keep both. Your original file is not changed.
- Use `.xlsx` files. `.xls` and `.et` must be saved as `.xlsx` first. Charts, pivot tables and macros may not survive the round trip, so keep a backup of complex workbooks.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Claude API key |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Vision model used to read the waybills |
| `CLAUDE_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max`. Higher is more careful, slower and costlier. |
| `PORT` | `3000` | Port number |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to block other devices |
| `DATA_DIR` | `./data` | Where settings, history and photos are stored |
| `ACCESS_PIN` | (off) | PIN required on every device. Required on Render. |
| `SESSION_SECRET` | (random) | Signs the login cookie. If unset, a restart signs devices out. |
| `MOCK_EXTRACTION` | (off) | `1` = demo mode with no API calls |

Requests include Claude's server-side refusal fallback (`fallbacks: "default"`). If the main model declines an image, a fallback model reads it within the same call.

## Data stored on the PC (or the Render disk)

```
data/
  settings.json          mapping tables
  history/2026-11-23.json one file per day: rows, edits, start number
  images/<id>.img        downsized photos (used for re-run and review)
```

Back up the `data` folder to keep your history and mappings. Delete old files in `data/images` to free space.

## Tests

```bat
npm test
```

The automated sample cases (`test/`) cover:

- `shared.test.js`: a clean waybill to the exact 12 copied columns (including the TSV line); an empty compartment being ignored; unreadable fields left blank and highlighted; an unknown company shown in full, then mapped once a short name is saved; a compartment total mismatch; a wrong-day warning; multiple destinations in NOTES; duplicates in the batch and in the workbook; user edits overriding values; no totals check when a compartment is unreadable; sorting; and date formats.
- `workbook.test.js`: header and last-row detection, appending below the last row, keeping fonts, borders and number formats, copying a formula column down, and the new-file export.
- `auth.test.js`: the API is locked without the PIN, the right PIN unlocks it, forged cookies are rejected, wrong PINs are throttled, and the server refuses to start on Render without a PIN.
- `server.test.js`: starts the server in demo mode and exercises upload, re-run, image serving, rejecting a non-image, settings and history.

The sample extractions are in `test/fixtures/`. To test real photos against the live API, put them in `test/images/` and run:

```bat
npm run try-image -- test\images\photo1.jpg test\images\photo2.jpg --day 2026-11-23
```

This prints the raw JSON, the row, the highlights and the checks for each photo. Good photos to keep as regression cases: a clean one, a tilted one, one with pen marks, one with ghost text from a sheet underneath, one with empty compartments, and one with more than one destination.

## Project layout

```
server.js            Express server and API routes
lib/extract.js       Claude prompt, JSON schema, API call
lib/workbook.js      Read, append and export .xlsx (ExcelJS)
lib/store.js         Settings, history and photo files
lib/auth.js          Optional PIN login
public/              Web app (index.html, app.js, style.css)
public/shared.js     Mapping, validation and TSV (shared with the tests)
scripts/             demo.js, try-image.js
test/                Automated tests and sample fixtures
start.bat            Windows launcher
../render.yaml       Render Blueprint (at the repository root)
```
