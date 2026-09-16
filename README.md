# NASCO Salmon Growth — Sample Progress Dashboard

A small static dashboard tracking scale-sample progress by river for NINA project
132668 ("NASCO: Salmon growth"). Shows, per river and year, progress toward the
project's imaging target ("required" vs. "imaged") plus any already-imaged
samples beyond that target ("excess").

**Live (unlisted) URL:** https://maltewillmes.github.io/scale_dash/

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

  Pushing to `master` is enough — GitHub Pages redeploys automatically.

## Definitions used in this dashboard

Rivers are grouped by `Vassdragsnr_hovedvassdrag` (the canonical watershed id),
not by the free-text `Objektnavn` — a couple of watersheds are recorded under
more than one `Objektnavn` spelling (e.g. "Etneelva" / "Etneelva/Sørelva"),
which would otherwise split one river into two rows. The name shown is just
the most common `Objektnavn` seen for that watershed id.

Each river/year has a candidate pool of up to 15 randomly-selected fish (the
NASCO sampling design), of which **10 per river per year** need imaging — the
rest are kept in reserve in case of poor scale quality. `imaged` below means a
candidate row where `Bilde_skjell` (the scale image filename) is filled in.

- **Required** — a fixed **10** for every river/year, for each age class (so
  20 total per river per year, combined) — the imaging target itself, not
  capped or reduced by how many candidates happen to exist that year. A
  river/year with fewer than 10 candidates selected simply can't reach 100% —
  that shortfall is real and intentionally visible rather than hidden by
  shrinking the target to match.
- **Imaged** — however many already-imaged candidates count toward that
  target: `min(imaged count, required)`. Required + Imaged always describes a
  0–100% target.
- **Excess** — already-imaged candidates beyond the target:
  `max(0, imaged count − required)`. Extra coverage that isn't needed to hit
  100% but exists anyway — reported separately, never folded into the
  percentage.

Many images predate this project — NASCO's own imaging (task: "Image scale
samples") starts October 2026 — so this tracks *total* photographic coverage,
not only new NASCO-funded imaging. If you'd rather track only new project
imaging once that starts, that needs a cutoff date or a separate flag in the
source data — not available yet. The 10/river/year target applies equally to
1SW and 2SW; adjust `PER_YEAR_TARGET` in `scripts/build_summary.py` (and the
matching constant in `SETUP.md`'s Apps Script) if that's ever confirmed to
differ by age class.

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
