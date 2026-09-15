# NASCO Salmon Growth — Sample Progress Dashboard

A small static dashboard tracking scale-sample progress by river for NINA project
132668 ("NASCO: Salmon growth"). Shows, per river and year, how many fish were
selected as scale-sample candidates ("required") versus how many already have a
scale image on file ("imaged").

**Live (unlisted) URL:** filled in after the first `gh api .../pages` call — see
below, or check the repo's *Settings → Pages*.

## How it works

- `data/summary.json` is the only thing the page reads at runtime — a small,
  pre-aggregated file (river × year × age-class counts), not the raw fish-level
  spreadsheet.
- `index.html` / `style.css` / `app.js` are a plain static site — no build step,
  no framework, so GitHub Pages can serve the repo directly.
- `scripts/build_summary.py` regenerates `data/summary.json` from the two source
  workbooks (`d_1SW_top15.xlsx`, `d_2SW_top15.xlsx`). Run it locally whenever you
  want to refresh the numbers by hand:

  ```bash
  pip install openpyxl
  python scripts/build_summary.py /path/to/d_1SW_top15.xlsx /path/to/d_2SW_top15.xlsx data/summary.json
  git add data/summary.json && git commit -m "Refresh sample data" && git push
  ```

  Pushing to `main` is enough — GitHub Pages redeploys automatically.

## Definitions used in this dashboard

- **Required** — a fish selected as a scale-sample candidate for that river/year
  (the NASCO design randomly selects up to 15 1SW and up to 10 2SW fish per
  river per year).
- **Imaged** — a candidate row where `Bilde_skjell` (the scale image filename)
  is filled in. Many of these images predate this project — NASCO's own imaging
  (task: "Image scale samples") starts October 2026 — so this tracks *total*
  photographic coverage, not only new NASCO-funded imaging. If you'd rather track
  only new project imaging once that starts, that needs a cutoff date or a
  separate flag in the source data — not available yet.

## Keeping it updated automatically

The source spreadsheet lives in OneDrive and gets edited daily. The intended
pipeline to keep `data/summary.json` fresh without any Azure app registration or
paid connectors is documented in [`SETUP.md`](SETUP.md) — a small Power Automate
flow plus a Google Apps Script bridge that pushes the refreshed JSON straight to
this repo via the GitHub API. That part is **not wired up yet** — this prototype's
data is a one-off snapshot generated on 2026-09-15.

## Project structure

```
index.html / style.css / app.js   the dashboard (static, no build step)
data/summary.json                 pre-aggregated data the page reads
scripts/build_summary.py          regenerates data/summary.json from the xlsx sources
SETUP.md                          daily-refresh automation plan (Power Automate + Apps Script)
```
