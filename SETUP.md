# Daily-refresh automation

Goal: keep `data/summary.json` (and `data/history.json`, the weekly-timeline
log) in sync with the OneDrive spreadsheet every day, without an Azure app
registration, without a paid Power Automate connector, and without ever
making the raw fish-level file public.

Bridge: **Power Automate** (reads the file under your own OneDrive sign-in,
standard connectors only) → **email attachment to your Gmail** → **Google Apps
Script** (reads the attachment, aggregates it, pushes the result straight to
this GitHub repo). Nothing in this chain needs Azure AD app consent or a
Power Automate premium license.

```
OneDrive Excel  →  Power Automate (daily)  →  email w/ 2 small CSVs  →  Gmail
                                                                            │
                                                          Apps Script (daily, time trigger)
                                                                            │
                                          aggregates + pushes data/summary.json + data/history.json
                                                                            ▼
                                                              GitHub repo → Pages redeploys
```

## 1. One-time: turn the data ranges into Excel Tables

Power Automate's standard "List rows present in a table" action needs a real
Excel *Table* object, not just a range.

In each workbook (`d_1SW_top15.xlsx`, `d_2SW_top15.xlsx`), in Excel Online or
desktop Excel:
1. Click any cell in the data, then **Insert → Table** (or Ctrl+T). Confirm
   "My table has headers".
2. Name the table (Table Design tab → Table Name) — e.g. `Data1SW` in the 1SW
   file, `Data2SW` in the 2SW file. Save.

## 2. Power Automate flow

At [make.powerautomate.com](https://make.powerautomate.com) → **Create → Scheduled
cloud flow**.

- **Name:** `NASCO daily export`
- **Recurrence:** every `1` `Day`, at a fixed time (e.g. 06:00) — comfortably
  before the Apps Script trigger in step 3.

Add these actions, in order:

1. **List rows present in a table** (Excel Online (Business)) — File: the 1SW
   workbook, Table: `Data1SW`.
2. **Create CSV table** (Data Operations) — From: the *value* output of step 1.
   Set **Columns → Custom**, and include only these six columns (this also
   keeps the exported file small and free of anything sensitive):
   `Objektnavn`, `Vassdragsnr_hovedvassdrag`, `Feltaar`, `Bilde_skjell`, `bilde`,
   `region`.
3. **List rows present in a table** — same as step 1, for the 2SW workbook /
   `Data2SW` table.
4. **Create CSV table** — same six columns, from step 3's output.
5. **Send an email (V2)** (Office 365 Outlook) —
   - To: your Gmail address
   - Subject: exactly `NASCO daily export` (the Apps Script below matches on
     this — keep it identical, or update `SEARCH_SUBJECT` in the script)
   - Attachments: two attachments, `1SW.csv` = step 2's output, `2SW.csv` =
     step 4's output. Content type `text/csv`.

Save, then **Run** once manually to confirm the email arrives with both
attachments.

## 3. Google Apps Script bridge

At [script.google.com](https://script.google.com) → **New project**. Name it
`NASCO GitHub sync`, then replace the default code with:

```javascript
// --- Configuration (set as Script Properties instead of hardcoding secrets) ---
// Project Settings -> Script Properties:
//   GITHUB_TOKEN   a fine-grained GitHub PAT, scoped to just this repo,
//                  permission "Contents: Read and write"
//   GITHUB_REPO    "MalteWillmes/scale_dash"
//   GITHUB_BRANCH  "master"
const SEARCH_SUBJECT = "NASCO daily export";

function syncDaily() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("GITHUB_TOKEN");
  const repo = props.getProperty("GITHUB_REPO");
  const branch = props.getProperty("GITHUB_BRANCH") || "master";
  if (!token || !repo) throw new Error("Set GITHUB_TOKEN and GITHUB_REPO in Script Properties first.");

  const threads = GmailApp.search('subject:"' + SEARCH_SUBJECT + '" newer_than:2d', 0, 5);
  if (threads.length === 0) throw new Error("No recent \"" + SEARCH_SUBJECT + "\" email found.");
  const messages = threads[0].getMessages();
  const latest = messages[messages.length - 1];

  const attachments = latest.getAttachments();
  const csv1sw = findAttachment(attachments, "1SW");
  const csv2sw = findAttachment(attachments, "2SW");
  if (!csv1sw || !csv2sw) throw new Error("Expected two attachments named like 1SW.csv / 2SW.csv.");

  const rows1sw = parseRows(csv1sw.getDataAsString());
  const rows2sw = parseRows(csv2sw.getDataAsString());

  // RB's pictures are a static file in the repo (made by scripts/extract_rb.py), not part of
  // the daily email, so read the current copy from GitHub.
  const rbDoc = fetchJsonFromGitHub("data/rb_pictures.json", token, repo, branch);
  const summary = aggregate(rows1sw, rows2sw, rbDoc ? rbDoc.rivers : {});
  const today = summary.generatedAt.slice(0, 10); // YYYY-MM-DD

  pushJsonToGitHub("data/summary.json", summary, "Automated daily refresh: " + summary.generatedAt, token, repo, branch);

  const history = fetchJsonFromGitHub("data/history.json", token, repo, branch) || [];
  const withoutToday = history.filter((h) => h.date !== today);
  // Project-wide totals plus the same totals per region, so the dashboard's
  // timeline can follow its Region filter (same shape as scripts/build_summary.py).
  withoutToday.push(Object.assign({ date: today }, summary.totals, { regions: regionTotals(summary.rivers) }));
  withoutToday.sort((a, b) => a.date.localeCompare(b.date));
  pushJsonToGitHub("data/history.json", withoutToday, "Automated history update: " + today, token, repo, branch);
}

function findAttachment(attachments, needle) {
  return attachments.find((a) => a.getName().toUpperCase().indexOf(needle) !== -1);
}

// Parses the CSV into {Objektnavn, Vassdragsnr_hovedvassdrag, Feltaar, Bilde_skjell, bilde, region} rows.
// An image exists when the 0/1 `bilde` flag is 1 or a Bilde_skjell filename is present
// (same rule as scripts/build_summary.py).
function parseRows(csvText) {
  const table = Utilities.parseCsv(csvText);
  if (table.length === 0) return [];
  const header = table[0];
  const idx = {};
  header.forEach((name, i) => { idx[name.trim()] = i; });
  const rows = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const river = row[idx["Objektnavn"]];
    const watershed = row[idx["Vassdragsnr_hovedvassdrag"]] || "";
    const year = parseInt(row[idx["Feltaar"]], 10);
    const hasImage = (row[idx["bilde"]] || "").trim() === "1" ||
      (row[idx["Bilde_skjell"]] || "").trim() !== "";
    const region = (row[idx["region"]] || "").trim();
    if (!river || !year || !watershed.trim()) continue;
    rows.push({ river: river.trim(), watershed: watershed.trim(), year, hasImage, region });
  }
  return rows;
}

// Per-river, per-year imaging target: at most this many fish per age class need
// imaging (a river-year with fewer fish selected needs all of them). The candidate
// pool is usually larger (up to 15) -- the remainder are reserve fish. Must match
// PER_YEAR_TARGET in scripts/build_summary.py.
const PER_YEAR_TARGET = { sw1: 10, sw2: 10 };

// Every river-year is computed three ways, field-name infix in brackets: all
// institutions combined [""], NINA only ["Nina"], RB only ["Rb"]. Same list, same
// order as FIELDS in scripts/build_summary.py.
const CLASSES = ["sw1", "sw2"];
const VIEW_INFIXES = ["", "Nina", "Rb"];
const MEASURES = ["Required", "Analyzed", "Excess"];
const FIELDS = [];
VIEW_INFIXES.forEach((infix) => CLASSES.forEach((c) => MEASURES.forEach((m) => FIELDS.push(c + infix + m))));

function emptyFields() {
  const o = {};
  FIELDS.forEach((k) => { o[k] = 0; });
  return o;
}

// Sums each river's totals by region (rivers without a region are skipped, so they
// only count toward the project-wide totals). Mirrors region_totals() in
// scripts/build_summary.py; keys sorted so the JSON matches byte for byte.
function regionTotals(rivers) {
  const byRegion = {};
  rivers.forEach((r) => {
    if (!r.region) return;
    if (!byRegion[r.region]) byRegion[r.region] = emptyFields();
    FIELDS.forEach((k) => { byRegion[r.region][k] += r.totals[k]; });
  });
  const sorted = {};
  Object.keys(byRegion).sort().forEach((k) => { sorted[k] = byRegion[k]; });
  return sorted;
}

// Mirrors scripts/build_summary.py's aggregate() exactly, so a manual regenerate
// and this automated path always agree on shape.
//
// Grouped by Vassdragsnr_hovedvassdrag (watershed id), not Objektnavn -- a
// couple of watersheds are recorded under more than one Objektnavn spelling,
// which would otherwise split one river into two rows. The displayed name is
// the most common Objektnavn seen for that watershed id (ties broken
// alphabetically).
//
// Required = the fish available for that river-year and age class, capped at the target:
//            min(target, selected fish). A river-year with only 7 fish selected needs 7
//            images and reaches 100% when all 7 are imaged.
// Analyzed = min(imaged count, required) -- imaged fish counted toward that.
// Excess   = max(0, imaged count - required) -- imaged fish beyond what is required.
//
// Institutions: everything in the NINA workbooks is institution NINA; RB's pictures
// come from `rb` (the `rivers` object of data/rb_pictures.json, made by
// scripts/extract_rb.py) and are the fish RB has available. A river-year counts ONCE
// toward the target in the combined view however many institutions contributed:
// available = NINA's selected fish + RB's pictures, imaged = NINA's imaged candidates +
// RB's pictures. In the RB view a river-year RB has no pictures for does not exist.
function aggregate(rows1sw, rows2sw, rb) {
  rb = rb || {};
  const watersheds = {}; // watershed id -> { watershedId, nameCounts, regionCounts, byYear: { year: {...} } }
  const allYears = new Set();

  function entryFor(ws) {
    if (!watersheds[ws]) watersheds[ws] = { watershedId: ws, nameCounts: {}, regionCounts: {}, byYear: {} };
    return watersheds[ws];
  }

  const nina = { sw1: {}, sw2: {} };     // class -> "ws||year" -> { ws, year, pool, imaged }
  const pictures = { sw1: {}, sw2: {} }; // class -> "ws||year" -> { ws, year, n }

  [["sw1", rows1sw], ["sw2", rows2sw]].forEach(([swKey, rows]) => {
    rows.forEach(({ river, watershed, year, hasImage, region }) => {
      const e = entryFor(watershed);
      e.nameCounts[river] = (e.nameCounts[river] || 0) + 1;
      if (region) e.regionCounts[region] = (e.regionCounts[region] || 0) + 1;
      const k = watershed + "||" + year;
      if (!nina[swKey][k]) nina[swKey][k] = { ws: watershed, year, pool: 0, imaged: 0 };
      nina[swKey][k].pool += 1; // candidate in the pool
      if (hasImage) nina[swKey][k].imaged += 1;
    });
  });

  Object.keys(rb).forEach((ws) => {
    const river = rb[ws];
    const e = entryFor(ws);
    e.nameCounts[river.name] = (e.nameCounts[river.name] || 0) + 1; // one vote: NINA's spelling wins on a shared river
    if (river.region) e.regionCounts[river.region] = (e.regionCounts[river.region] || 0) + 1;
    [["1SW", "sw1"], ["2SW", "sw2"]].forEach(([sheet, swKey]) => {
      const byYear = (river.pictures && river.pictures[sheet]) || {};
      Object.keys(byYear).forEach((year) => {
        pictures[swKey][ws + "||" + Number(year)] = { ws, year: Number(year), n: byYear[year] };
      });
    });
  });

  CLASSES.forEach((swKey) => {
    const target = PER_YEAR_TARGET[swKey];
    const keys = {};
    Object.keys(nina[swKey]).forEach((k) => { keys[k] = true; });
    Object.keys(pictures[swKey]).forEach((k) => { keys[k] = true; });
    Object.keys(keys).forEach((k) => {
      const n = nina[swKey][k], p = pictures[swKey][k];
      const ws = (n || p).ws, year = (n || p).year;
      const pool = n ? n.pool : 0, ninaImaged = n ? n.imaged : 0, rbN = p ? p.n : 0;
      allYears.add(year);
      const wsEntry = entryFor(ws);
      const key = String(year);
      if (!wsEntry.byYear[key]) wsEntry.byYear[key] = emptyFields();
      // [infix, fish available, fish imaged]; imaged never exceeds available
      [
        ["", pool + rbN, ninaImaged + rbN],
        ["Nina", pool, ninaImaged],
        ["Rb", rbN, rbN],
      ].forEach(([infix, available, imagedCount]) => {
        if (available === 0) return;
        // Every available fish needs imaging, up to the target: a river-year with
        // fewer than `target` fish selected can still reach 100%.
        const required = Math.min(target, available);
        wsEntry.byYear[key][swKey + infix + "Required"] += required;
        wsEntry.byYear[key][swKey + infix + "Analyzed"] += Math.min(imagedCount, required);
        wsEntry.byYear[key][swKey + infix + "Excess"] += Math.max(0, imagedCount - required);
      });
    });
  });

  function bestName(nameCounts) {
    return Object.entries(nameCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }

  // Most common non-empty region for the watershed ("" if none), ties alphabetical --
  // same rule as scripts/build_summary.py. Kept exactly as written in the source
  // ("Nord" / "Sor" / "Vest"); the dashboard does the display spelling.
  function bestRegion(regionCounts) {
    const entries = Object.entries(regionCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return entries.length ? entries[0][0] : "";
  }

  const totals = emptyFields();
  const riverList = Object.values(watersheds).map((wsEntry) => {
    const riverTotals = emptyFields();
    Object.values(wsEntry.byYear).forEach((yr) => {
      FIELDS.forEach((k) => { riverTotals[k] += yr[k]; });
    });
    FIELDS.forEach((k) => { totals[k] += riverTotals[k]; });
    return {
      name: bestName(wsEntry.nameCounts),
      watershedId: wsEntry.watershedId,
      region: bestRegion(wsEntry.regionCounts),
      byYear: wsEntry.byYear,
      totals: riverTotals,
    };
  });
  riverList.sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    years: Array.from(allYears).sort((a, b) => a - b),
    rivers: riverList,
    totals: totals,
  };
}

function githubHeaders(token) {
  return { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
}

// Returns the parsed JSON content of a repo file, or null if it doesn't exist yet.
function fetchJsonFromGitHub(path, token, repo, branch) {
  const apiBase = "https://api.github.com/repos/" + repo + "/contents/" + path;
  const resp = UrlFetchApp.fetch(apiBase + "?ref=" + branch, {
    headers: githubHeaders(token), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) return null;
  const body = JSON.parse(resp.getContentText());
  const decoded = Utilities.newBlob(Utilities.base64Decode(body.content)).getDataAsString();
  return JSON.parse(decoded);
}

// Writes (creating or updating) one JSON file in the repo.
function pushJsonToGitHub(path, data, message, token, repo, branch) {
  const apiBase = "https://api.github.com/repos/" + repo + "/contents/" + path;
  const headers = githubHeaders(token);

  // Need the current file's sha to update it (absent for a brand-new file).
  let sha = null;
  const getResp = UrlFetchApp.fetch(apiBase + "?ref=" + branch, {
    headers, muteHttpExceptions: true,
  });
  if (getResp.getResponseCode() === 200) {
    sha = JSON.parse(getResp.getContentText()).sha;
  }

  const content = Utilities.base64Encode(JSON.stringify(data, null, 2), Utilities.Charset.UTF_8);
  const payload = { message: message, content: content, branch: branch };
  if (sha) payload.sha = sha;

  const putResp = UrlFetchApp.fetch(apiBase, {
    method: "put",
    contentType: "application/json",
    headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (putResp.getResponseCode() >= 300) {
    throw new Error("GitHub push failed for " + path + ": " + putResp.getResponseCode() + " " + putResp.getContentText());
  }
}
```

Then:

1. **Project Settings (gear icon) → Script Properties**, add `GITHUB_TOKEN`,
   `GITHUB_REPO`, `GITHUB_BRANCH` as above.
2. Create the GitHub token at **github.com → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token**, scoped
   to **only this repository**, permission **Contents: Read and write**, no
   other permissions. Paste it into `GITHUB_TOKEN`.
3. Run `syncDaily` once manually from the Apps Script editor (after the Power
   Automate flow has sent at least one email) — it will ask you to authorize
   Gmail read + external requests. Approve it, then confirm both
   `data/summary.json` and `data/history.json` updated in GitHub and the
   Pages site picked it up.
4. **Triggers (clock icon) → Add Trigger** → function `syncDaily` → time-driven
   → day timer → pick an hour after the Power Automate flow's run time (e.g.
   07:00–08:00).

From then on the dashboard refreshes itself daily with no further action.

## Notes / things to revisit

- If NINA's Gmail/Workspace policy blocks `GmailApp` attachments or Apps
  Script's external requests, this bridge won't work as-is — the fallback is
  either getting Power Automate premium (for a direct HTTP action, skipping
  Gmail entirely) or the original Microsoft Graph API + Azure app registration
  route.
- The CSV in transit only ever contains river name, watershed ID, year, and
  whether an image exists — no fish-level measurements, IDs, or genetics data
  leave OneDrive.
- If the two source workbooks get renamed, moved, or restructured, this whole
  pipeline (Power Automate table references *and* `scripts/build_summary.py`)
  needs updating to match.
