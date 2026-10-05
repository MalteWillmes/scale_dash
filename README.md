# NASCO Salmon Growth — Sample Progress Dashboard

A small static dashboard tracking scale-sample progress by river for NINA project
132668 ("NASCO: Salmon growth"). Shows, per river and year, progress toward the
project's imaging target ("required" vs. "imaged") plus any already-imaged
samples beyond that target ("excess").

**Live (unlisted) URL:** https://maltewillmes.github.io/scale_dash/

## How it works

- `data/summary.json` is the current-state snapshot the page mostly reads at
  runtime — a small, pre-aggregated file (river × year × age-class counts),
  not the raw fish-level spreadsheet.
- `data/history.json` is a small time series alongside it: one `{date,
  ...totals, regions}` entry per calendar day the pipeline has run (`regions`
  repeats the totals for each of Nord / Sor / Vest), upserted (not appended) so
  re-running the same day updates that day's entry rather than duplicating it.
  The dashboard buckets this into the "Images added per week" chart — see below.
- `index.html` / `style.css` / `app.js` are a plain static site — no build step,
  no framework, so GitHub Pages can serve the repo directly. GitHub Pages lets
  browsers cache these files for ~10 minutes, and a plain reload re-fetches only
  `index.html`, so an old `app.js` can end up paired with a new page (panels stuck
  on "Loading…"). To prevent that, `index.html` links them as `style.css?v=…` /
  `app.js?v=…` — **bump that date whenever `style.css` or `app.js` changes.**
- `scripts/build_summary.py` regenerates both `data/summary.json` and
  `data/history.json` from the two source workbooks (`d_1SW_top15.xlsx` for
  1SW, `d_2SW_top15.xlsx` for 2SW — the 15 fish selected per river per year).
  Drop the current workbooks into `data/` (they're git-ignored via
  `data/*.xlsx`, since they hold raw fish-level records and must never be
  published) and run it whenever you want to refresh the numbers by hand:

  ```bash
  pip install openpyxl
  python scripts/build_summary.py data/d_1SW_top15.xlsx data/d_2SW_top15.xlsx data/summary.json
  git add data/summary.json data/history.json && git commit -m "Refresh sample data" && git push
  ```

  Stage the two JSON files by name as above rather than `git add -A`. Pushing
  to `master` is enough — GitHub Pages redeploys automatically.

## Definitions used in this dashboard

Rivers are grouped by `Vassdragsnr_hovedvassdrag` (the canonical watershed id),
not by the free-text `Objektnavn` — a couple of watersheds are recorded under
more than one `Objektnavn` spelling (e.g. "Etneelva" / "Etneelva/Sørelva"),
which would otherwise split one river into two rows. The name shown is just
the most common `Objektnavn` seen for that watershed id.

Each river also carries its **region** from the source `region` column — Nord
(10 rivers), Sør (8) and Vest (7) in the current data; every watershed maps to
exactly one. It's stored in `summary.json` exactly as written in the source
(`Sor`, without the ø) and shown as "Sør" in the table's Region column. The
river sort menu has a "Region, then name" option that groups the table by region.

Region has two more roles on the page:

- **Region filter** (All regions / Nord / Sør / Vest, built from whatever
  regions are in the data): narrows the stat tiles, the *Samples by year* chart,
  the weekly *Images added per week* timeline and the *Progress by river* table
  to that region, and combines with the Age class filter (and, for everything
  but the timeline, the Years filter).
- **Progress by region** table: the per-region subtotals (rivers, required,
  imaged, %, excess) plus an *All regions* total row, for the current Age class
  and Years selection. It deliberately ignores the Region filter so the regions
  stay comparable side by side; the selected region just gets a highlight.

Each river/year has a candidate pool of up to 15 randomly-selected fish (the
NASCO sampling design), of which **10 per river per year** need imaging — the
rest are kept in reserve in case of poor scale quality. `imaged` below means a
candidate row where the 0/1 `bilde` flag is 1 **or** a `Bilde_skjell` (scale
image filename) is filled in. `bilde` is the broader flag: every row with a
filename also has `bilde = 1`, but images from 2019–2025 are flagged by `bilde`
alone with no filename recorded, so counting filenames only badly undercounts
recent imaging.

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

## Images-added-per-week timeline

The source spreadsheet has no "date image added" column — the image flag only
says whether an image exists *now*, not when it appeared — so there's no way
to reconstruct history retroactively. Instead, every pipeline run (manual or
automated) upserts today's totals into `data/history.json`, and the dashboard
buckets that log into a continuous weekly timeline itself (nothing is
pre-aggregated by week in the data files, so the bucketing logic lives in one
place: `computeWeeklyTimeline` in `app.js`):

- Weeks run Monday–Sunday. Each week's value is the imaged count (`Analyzed +
  Excess`, i.e. every imaged candidate regardless of the target) from the
  *last* snapshot logged that week.
- The timeline spans every week from the first logged snapshot to the most
  recent — a week with no snapshot (the pipeline didn't run, or didn't run
  before the site was loaded) carries the prior known total forward, so it
  shows as zero *added* that week rather than a gap.
- The first bar is the total imaged count discovered when tracking began, not
  a real "this week" delta — there's no prior snapshot to diff against.
- Respects the Age class filter (Combined / 1SW / 2SW) like the rest of the
  dashboard; not affected by the Years filter, since that filters by sampling
  year (`Feltaar`), not by when an image was actually added.
- Follows the Region filter: each history entry stores the project-wide totals
  *and* the same totals per region (`regions`), so selecting a region shows that
  region's weekly additions. An entry without a `regions` breakdown is skipped
  when a region is selected rather than guessed at. The log was restarted
  (2026-10-05) when this breakdown was added, because history can't be rebuilt
  after the fact — every entry has to carry it from the start. Rivers with no
  region count only toward the project-wide numbers.

This only tracks forward from whenever logging started — it does **not**
retroactively reconstruct how the current backlog of already-imaged samples
accumulated before this feature existed.

## Map of rivers

A panel above *Progress by region* with one circle marker per river:

- **Colour = region** (Nord blue, Sør orange, Vest aqua — the first three slots
  of a colour-blind-safe palette; size and the popups carry the same
  information, so colour is never the only cue). **Size = % of target imaged.**
  Click or tap a marker for that river's numbers.
- It follows the Age class, Years and Region filters, with the same "has
  candidates in the selected range" rule as the tables, and zooms to whatever is
  shown (so picking a region zooms to it).
- Base map: Kartverket's open grayscale topographic tiles, drawn with Leaflet
  1.9.4 (both loaded from CDNs; no build step). Scroll-wheel zoom is off so the
  page still scrolls — use the +/− buttons or pinch.

**Positions are approximate, and are not sampling sites.** The spreadsheets
have no coordinates, so `data/rivers.json` holds one representative point per
river (keyed by `Vassdragsnr_hovedvassdrag`) taken from Kartverket's place-name
register (`ws.geonorge.no/stedsnavn`). That point isn't necessarily the outlet:
on long rivers it can be tens of km away. Names that match many rivers in Norway
were resolved by hand — e.g. the Lakselva by its source lake Trollbuvatnet on
Senja, Espedalselva via Espedalsvatnet in Rogaland, Åelva via Roksdalen on
Andøy — and the finished set was checked against the data: all rivers located,
all inside Norway, Nord entirely north of Sør/Vest, and the points follow the
coast in vassdragsnummer order with no strays. Each entry's `from` field records
exactly which register object was used. If real sampling-site coordinates
become available, replace the lat/lon there.

`rivers.json` is static (the refresh pipeline doesn't touch it). A river that
shows up in the data later but isn't in that file still appears in the tables;
the map skips it and its legend says how many were left off.

## Keeping it updated automatically

The source spreadsheet lives in OneDrive and gets edited daily. The intended
pipeline to keep `data/summary.json` fresh without any Azure app registration or
paid connectors is documented in [`SETUP.md`](SETUP.md) — a small Power Automate
flow plus a Google Apps Script bridge that pushes the refreshed JSON straight to
this repo via the GitHub API. That part is **not wired up yet** (and the approach
is still undecided) — for now the data is refreshed by hand from the workbooks in
`data/`; the current snapshot was generated on 2026-10-05.

## Project structure

```
index.html / style.css / app.js   the dashboard (static, no build step)
data/summary.json                 pre-aggregated current-state data the page reads
data/history.json                 daily-snapshot log the page buckets into the weekly timeline
data/rivers.json                  approximate map position per river (static, hand-curated)
scripts/build_summary.py          regenerates both data files from the xlsx sources
SETUP.md                          daily-refresh automation plan (Power Automate + Apps Script)
```
