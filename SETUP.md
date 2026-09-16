# Daily-refresh automation

Goal: keep `data/summary.json` in sync with the OneDrive spreadsheet every day,
without an Azure app registration, without a paid Power Automate connector, and
without ever making the raw fish-level file public.

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
                                                     aggregates + pushes data/summary.json
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
   Set **Columns → Custom**, and include only these four columns (this also
   keeps the exported file small and free of anything sensitive):
   `Objektnavn`, `Vassdragsnr_hovedvassdrag`, `Feltaar`, `Bilde_skjell`.
3. **List rows present in a table** — same as step 1, for the 2SW workbook /
   `Data2SW` table.
4. **Create CSV table** — same four columns, from step 3's output.
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

  const summary = aggregate(rows1sw, rows2sw);
  pushToGitHub(summary, token, repo, branch);
}

function findAttachment(attachments, needle) {
  return attachments.find((a) => a.getName().toUpperCase().indexOf(needle) !== -1);
}

// Parses the CSV into {Objektnavn, Vassdragsnr_hovedvassdrag, Feltaar, Bilde_skjell} rows.
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
    const hasImage = (row[idx["Bilde_skjell"]] || "").trim() !== "";
    if (!river || !year || !watershed.trim()) continue;
    rows.push({ river: river.trim(), watershed: watershed.trim(), year, hasImage });
  }
  return rows;
}

// Per-river, per-year imaging target. The candidate pool is usually larger
// (up to 15) -- the remainder are reserve fish. Must match PER_YEAR_TARGET
// in scripts/build_summary.py.
const PER_YEAR_TARGET = { sw1: 10, sw2: 10 };
const FIELDS = ["sw1Required", "sw1Analyzed", "sw1Excess", "sw2Required", "sw2Analyzed", "sw2Excess"];

function emptyFields() {
  const o = {};
  FIELDS.forEach((k) => { o[k] = 0; });
  return o;
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
// Required = min(target, candidate pool size) for that watershed/year.
// Analyzed = min(imaged count, required) -- imaged candidates counted toward the target.
// Excess   = max(0, imaged count - required) -- already-imaged candidates beyond the target.
function aggregate(rows1sw, rows2sw) {
  const watersheds = {}; // watershed id -> { watershedId, nameCounts, byYear: { year: {...} } }
  const allYears = new Set();

  function add(rows, swKey) {
    const target = PER_YEAR_TARGET[swKey];
    // Group first: required/analyzed/excess depend on the whole watershed+year pool.
    const groups = {}; // "watershed||year" -> [{river, hasImage}, ...]
    rows.forEach(({ river, watershed, year, hasImage }) => {
      const gKey = watershed + "||" + year;
      if (!groups[gKey]) groups[gKey] = { watershed, year, entries: [] };
      groups[gKey].entries.push({ river, hasImage });
    });

    Object.values(groups).forEach(({ watershed, year, entries }) => {
      allYears.add(year);
      if (!watersheds[watershed]) {
        watersheds[watershed] = { watershedId: watershed, nameCounts: {}, byYear: {} };
      }
      const wsEntry = watersheds[watershed];
      entries.forEach(({ river }) => {
        wsEntry.nameCounts[river] = (wsEntry.nameCounts[river] || 0) + 1;
      });
      const key = String(year);
      if (!wsEntry.byYear[key]) wsEntry.byYear[key] = emptyFields();

      const candidateCount = entries.length;
      const imagedCount = entries.filter((e) => e.hasImage).length;
      const required = Math.min(target, candidateCount);
      const analyzed = Math.min(imagedCount, required);
      const excess = Math.max(0, imagedCount - required);

      wsEntry.byYear[key][swKey + "Required"] += required;
      wsEntry.byYear[key][swKey + "Analyzed"] += analyzed;
      wsEntry.byYear[key][swKey + "Excess"] += excess;
    });
  }

  add(rows1sw, "sw1");
  add(rows2sw, "sw2");

  function bestName(nameCounts) {
    return Object.entries(nameCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
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

function pushToGitHub(summary, token, repo, branch) {
  const path = "data/summary.json";
  const apiBase = "https://api.github.com/repos/" + repo + "/contents/" + path;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
  };

  // Need the current file's sha to update it.
  let sha = null;
  const getResp = UrlFetchApp.fetch(apiBase + "?ref=" + branch, {
    headers, muteHttpExceptions: true,
  });
  if (getResp.getResponseCode() === 200) {
    sha = JSON.parse(getResp.getContentText()).sha;
  }

  const content = Utilities.base64Encode(JSON.stringify(summary, null, 2), Utilities.Charset.UTF_8);
  const payload = {
    message: "Automated daily refresh: " + summary.generatedAt,
    content: content,
    branch: branch,
  };
  if (sha) payload.sha = sha;

  const putResp = UrlFetchApp.fetch(apiBase, {
    method: "put",
    contentType: "application/json",
    headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (putResp.getResponseCode() >= 300) {
    throw new Error("GitHub push failed: " + putResp.getResponseCode() + " " + putResp.getContentText());
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
   Gmail read + external requests. Approve it, then confirm `data/summary.json`
   updated in GitHub and the Pages site picked it up.
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
