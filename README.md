# NASCO Salmon Growth — Sample Progress Dashboard

A small static dashboard tracking scale-sample progress by river for NINA project
132668 ("NASCO: Salmon growth"). Shows, per river and year, progress toward the
project's imaging target ("required" vs. "imaged") plus any already-imaged
samples beyond that target ("excess"). Images come from two institutions: NINA
(the project's own source workbooks) and RB, a collaborator whose fish come from
a separate workbook and whose images are counted from its image folder — see
*Institutions* below.

**Live (unlisted) URL:** https://maltewillmes.github.io/scale_dash/

## How it works

- `data/summary.json` is the current-state snapshot the page mostly reads at
  runtime — a small, pre-aggregated file (river × year × age-class counts),
  not the raw fish-level spreadsheet.
- `data/history.json` is a small time series alongside it: one `{date,
  ...totals, regions}` entry per calendar day the pipeline has run (`regions`
  repeats the totals for each region), upserted (not appended) so
  re-running the same day updates that day's entry rather than duplicating it.
  The dashboard turns this into the "Images added per day" chart — see below.
- `index.html` / `style.css` / `app.js` are a plain static site — no build step,
  no framework, so GitHub Pages can serve the repo directly. GitHub Pages lets
  browsers cache these files for ~10 minutes, and a plain reload re-fetches only
  `index.html`, so an old `app.js` can end up paired with a new page (panels stuck
  on "Loading…"). To prevent that, `index.html` links them as `style.css?v=…` /
  `app.js?v=…` — **bump that date whenever `style.css` or `app.js` changes.**
- **Updating the dashboard after new imaging — one command.** Operators record
  what they have imaged in the `Skjell_lister` folder (see *Imaging lists* below);
  to merge those lists and publish the new numbers:

  ```bash
  Rscript scripts/update_dashboard.R
  ```

  It (1) merges all lists into one file, (2) rebuilds `data/summary.json` and
  `data/history.json`, and (3) if the numbers changed, commits just those two files
  and pushes to `master`, and GitHub Pages redeploys within a minute or two. Run it
  as often as you like — several times a day is fine; when nothing changed it says so
  and publishes nothing. `--no-push` stops after step 2 so you can look first.
  It needs R (packages `readxl`, `dplyr`, `writexl`, `jsonlite`), Python with
  `openpyxl`, and git with push access to this repo.
- `scripts/merge_skjell_lister.R` is step 1 on its own: it merges the lists into
  `Skjell_lister/merged/scale_data_merged.xlsx` (see *Imaging lists*).
- `scripts/build_summary.py` regenerates both `data/summary.json` and
  `data/history.json` from the two source workbooks (`d_1SW_top15.xlsx` for
  1SW, `d_2SW_top15.xlsx` for 2SW — the 15 fish selected per river per year),
  the merged imaging list, and RB's fish and images from `data/rb_pictures.json`
  (if that file is there). The workbooks live in `data/` (git-ignored via
  `data/*.xlsx`, since they hold raw fish-level records and must never be
  published). `update_dashboard.R` runs it for you; by hand it is:

  ```bash
  pip install openpyxl
  python scripts/build_summary.py data/d_1SW_top15.xlsx data/d_2SW_top15.xlsx data/summary.json --imaged-list "<Skjell_lister>/merged/scale_data_merged.xlsx"
  git add data/summary.json data/history.json && git commit -m "Refresh sample data" && git push
  ```

  **Always pass `--imaged-list`**: without it the images recorded by operators
  are not counted and the numbers drop back. Stage the two JSON files by name as
  above rather than `git add -A`. Pushing to `master` is enough.
- `scripts/extract_rb.py` builds `data/rb_pictures.json` from RB's appendix
  workbook and RB's image folder. **Re-run it whenever RB has imaged more fish**
  (then run `build_summary.py` again, and stage `data/rb_pictures.json` too). It
  needs to run on a computer that can see the image folder; the output holds only
  counts, no file names:

  ```bash
  python scripts/extract_rb.py data/Vedlegg1_materiale_1989_2024.xlsx "P:/132453_digital_skjell/images/RB" data/rb_pictures.json
  ```

## Imaging lists (Skjell_lister)

The project's new imaging is recorded in
`…/132668 - NASCO Skjellvekst - Documents/Skjell_lister`. Each file there
(`scale_data_<date>_<operator>.xlsx`) is a copy of the **same master list** — one
row per fish, 18 columns, 7,515 fish (the 2016–2026 candidates of 32 NINA rivers,
each flagged `selected` or `backup`; `selected` is exactly the 10 per river, year and
age class that the dashboard counts as Required). When an operator has imaged a fish
they write their name and the date (e.g. `Gunnel_23.10.26`) in its `Operator` column,
and optionally a note in `Comments` (and blank `Bildnavn_B` when only one scale could
be imaged). So the files differ only in which fish are marked, and the same fish
appears in every file.

`scripts/merge_skjell_lister.R` merges them into one file with one row per fish
(`Skjell_lister/merged/scale_data_merged.xlsx`, the same 18 columns, so it can also be
used as a master). It reads every `.xlsx` in the folder each time, so it can be re-run
any time, and:

- a fish marked in one file and unmarked in the others is taken from the marked row
  (which also carries that operator's other edits);
- the same fish marked in several files by the same operator and date is a duplicate,
  and the most recently saved file wins;
- a fish marked by **different** operators keeps the latest operator date, and is
  listed in `merged/merge_conflicts.csv` for someone to check;
- a comment on any copy is kept; a file that is open in Excel (`~$…`) is skipped; files
  in the `backup` sub-folder are ignored unless you pass `--include-backup`;
- it stops without writing anything if a file can't be read or lacks one of the 18
  columns, and **if fish that were marked in the previous merged file are no longer
  marked** (typically because a list file was moved or deleted — nothing is carried
  over between runs, so keep every list in the folder). Pass `--allow-decrease` if
  the drop is intended, e.g. after correcting a mistakenly marked fish.

```bash
Rscript scripts/merge_skjell_lister.R                  # default folder -> merged/scale_data_merged.xlsx
Rscript scripts/merge_skjell_lister.R "<folder>" "<output.xlsx>"
```

The dashboard only uses the set of marked fish: `build_summary.py --imaged-list`
matches them to the top-15 workbooks by `EnkeltfiskID` and counts each as imaged
(see *Definitions*). The merged file holds fish-level records, so it stays in
SharePoint/OneDrive; only the counts reach this public repo.

## Definitions used in this dashboard

Rivers are grouped by `Vassdragsnr_hovedvassdrag` (the canonical watershed id),
not by the free-text `Objektnavn` — a couple of watersheds are recorded under
more than one `Objektnavn` spelling (e.g. "Etneelva" / "Etneelva/Sørelva"),
which would otherwise split one river into two rows. The name shown is just
the most common `Objektnavn` seen for that watershed id.

Each river also carries its **region** from the source `region` column — Midt
(11 rivers), Nord (10), Sør (10) and Vest (12) in the current data (43 rivers);
every watershed maps to exactly one. It's stored in `summary.json` exactly as
written in the source (`Sor`, without the ø) and shown as "Sør" in the table's
Region column. The river sort menu has a "Region, then name" option that groups
the table by region.

## Institutions (NINA and RB)

Everything that was in the dashboard before — the NINA source workbooks — is
institution **NINA**. A second institution, **RB** (the collaborator), images
its own fish from 11 rivers. RB's imaging is not finished, so the two parts come
from different places:

- **What has to be imaged** (Required) comes from the project appendix workbook
  "Vedlegg 1 – materiale 1989–2024": the rows with `Institusjon = RB` (sheets 1SW
  and 2SW) list, for each river and year 1989–2024, how many fish RB has (at most
  10) — 2,397 in 1SW and 2,468 in 2SW.
- **What has been imaged so far** (Imaged) is counted from RB's image folder
  (`132453_digital_skjell/images/RB`). So far that is 1,100 fish, all from
  1999–2004 (677 in 1SW, 423 in 2SW), from 8 of RB's 11 rivers — nothing yet from
  Bjerkreimselva, Espedalselva or Suldalslågen, and nothing for 2005 onwards.

- **Institution filter** (All / NINA / RB) — works like the other filters: it
  drives the stat tiles, both charts, the map and both tables, and combines with
  Age class, Years and Region. The river table has an *Institution* column that
  says where a river's numbers come from (`NINA`, `RB` or `NINA + RB`), and map
  popups repeat it.
- **All counts each river-year once.** If NINA and RB both have fish for a river
  and year, that river-year still has one target of at most 10 per age class (not
  20): the fish available are NINA's selected fish + RB's fish, `required` is
  `min(10, available)`, and `imaged` = NINA's imaged candidates + RB's images, so
  a river-year can be completed (or go into Excess) by either or both. The NINA
  and RB views are each computed on their own with the same rule, so they don't
  add up to *All* where both cover the same river-year. That happens in only two
  river-years today (Gloppenelva 2000 and 2001); everywhere else *All* is NINA
  plus RB.
- **In the RB view a river-year exists only if RB has fish for it** (material in
  the appendix, or images in the folder). 8 of RB's 11 rivers are not in the NINA
  data — they show up as new rows and map markers (Bjerkreimselva, Suldalslågen,
  Storelva (Arna), Frøysetelva, Vikja, Sogndalselva, Flekkeelva, Eidselva). Because
  RB's imaging is unfinished the RB view is mostly *Required* with little *Imaged*
  yet: about 12% of the target overall, and 0% in the default "last 10 years"
  window, since no image from 2005 onwards exists yet.
- **More images than fish is normal for RB.** In many river-years RB imaged
  more fish than the appendix lists (the appendix caps a river-year at 10, the
  imaging covered every fish available), so those river-years are 100% and the
  rest count as Excess. In others fewer fish are imaged than listed so far.
  A river-year with images but no appendix entry (e.g. Vikja 2000, 2003 and 2004)
  needs 10, like any other.

How RB's images are read (`scripts/extract_rb.py`). The image folder has one
sub-folder per year with the Leica exports (`<River><Year>-<fish no>.jpg`; some
years also have `.tif` or BandTracer `.png` files) and a `DNV <year>.xlsx` with one
row per imaged fish. Each row's *ID nr.* is the image name, and it gives the
watershed id (*Vassdragsnr.*) and the number of sea winters (*Sjø*), so every
image is assigned to a river, a year and an age class from the data, not from the
file name. An image counts once however many files it has. Not counted:
58 images of fish with 3 or more sea winters (the dashboard tracks 1SW and 2SW; the
appendix's 3SW sheet is ignored too) and 12 images with no row in the DNV
workbook (no age class to assign them to). Folders that aren't a year (e.g. a
staging folder) are ignored. The script stops with an error rather than guess if
a file doesn't fit (a DNV year or species that doesn't match, a watershed that
isn't one of RB's rivers, a missing DNV workbook).

An earlier version of the dashboard took the appendix's *Eksisterande
bildemateriale* column (a sum over 2016–2024) to mean "pictures that already exist"
and counted 1,827 RB fish as imaged. That was wrong: no image from those years
exists yet, and the column's formulas are not consistent across rows. Those years
are RB material still to be imaged, like every other year the appendix lists.

RB's images are a snapshot of the folder when the script last ran, so each re-run
shows up in the daily timeline as new images on the day of the next dashboard update
(the 1,100 images counted when tracking began are in the starting total, not a bar).

In `summary.json` every river-year carries 18 numbers: Required / Analyzed /
Excess for 1SW and 2SW, each three ways — all institutions combined
(`sw1Required`), NINA only (`sw1NinaRequired`) and RB only (`sw1RbRequired`).
The Institution filter just picks which set of fields the page reads;
`history.json` stores the same 18 fields per day (and per region), so the
timeline follows the filter too.

Region has two more roles on the page:

- **Region filter** (All regions plus one button per region in the data — Midt /
  Nord / Sør / Vest at the moment): narrows the stat tiles, the *Samples by year* chart,
  the daily *Images added per day* timeline and the *Progress by river* table
  to that region, and combines with the Age class and Institution filters (and,
  for everything but the timeline, the Years filter).
- **Progress by region** table: the per-region subtotals (rivers, required,
  imaged, %, excess) plus an *All regions* total row, for the current Age class
  and Years selection. It deliberately ignores the Region filter so the regions
  stay comparable side by side; the selected region just gets a highlight.

**Year by year.** Click a river in the *Progress by river* table (anywhere on the
row, or Tab to it and press Enter/Space) to open a breakdown of that river's years,
newest first, with the same Required / Imaged / % / Excess columns:

- It follows the Age class, Institution and Years filters, so its rows add up to the
  river's own row above it.
- It starts at the river's first year with candidates in the selected window. A
  later year with **no candidates at all** is listed as "no candidates selected"
  rather than skipped — such river-years aren't counted anywhere in the percentages,
  so this is where the gaps become visible (for most rivers 2026 shows up this way,
  since this year's selection isn't complete).
- Several rivers can be open at once, and they stay open (with updated numbers)
  when you change a filter or sort order. Long "All years" lists scroll inside the
  box; the default windows show in full.

Each river/year has a candidate pool of up to 15 randomly-selected fish (the
NASCO sampling design), of which **up to 10 per river per year** need imaging —
the rest are kept in reserve in case of poor scale quality. Some river-years have
fewer than 10 fish selected at all (348 of the NINA river-year/age-class
combinations, in 33 rivers); for those, every selected fish needs imaging.
`imaged` below means a
candidate row where the 0/1 `bilde` flag is 1, **or** a `Bilde_skjell` (scale
image filename) is filled in, **or** an operator has marked the fish in the imaging
lists (see above). A fish counts once however many of these apply. `bilde` is the
broader of the first two: every row with a filename also has `bilde = 1`, but images
from 2019–2025 are flagged by `bilde` alone with no filename recorded, so counting
filenames only badly undercounts recent imaging. Backup fish count as imaged just
like selected ones (2 of the first 38 marked fish are backups), as before: Required
is the number of fish to image, and any imaged fish in the pool counts toward it.

- **Required** — all the fish selected for that river/year and age class, **up
  to a maximum of 10**: `min(10, selected fish)`. A river/year with 7 selected
  fish needs 7 images and reaches 100% when all 7 are imaged; one with 12–15
  needs 10. (So 20 per river per year, combined, is the most it can be.) An
  earlier version fixed Required at 10 regardless, which left river-years with
  fewer than 10 selected fish unable to ever reach 100%.
- **Imaged** — however many already-imaged fish count toward that:
  `min(imaged count, required)`. Required + Imaged always describes a 0–100%
  target.
- **Excess** — imaged fish beyond what is required:
  `max(0, imaged count − required)`. It can only be non-zero where more than 10
  fish were selected. Extra coverage that isn't needed to hit 100% but exists
  anyway — reported separately, never folded into the percentage.

Many images predate this project — NASCO's own imaging (task: "Image scale
samples") starts October 2026 — so this tracks *total* photographic coverage,
not only new NASCO-funded imaging. If you'd rather track only new project
imaging once that starts, that needs a cutoff date or a separate flag in the
source data — not available yet. The maximum of 10 per river/year applies equally to
1SW and 2SW; adjust `PER_YEAR_TARGET` in `scripts/build_summary.py` (and the
matching constant in `SETUP.md`'s Apps Script) if that's ever confirmed to
differ by age class.

## Images-added-per-day timeline

The source spreadsheet has no "date image added" column — the image flag only
says whether an image exists *now*, not when it appeared — so there's no way
to reconstruct history retroactively. Instead, every pipeline run (manual or
automated) upserts today's totals into `data/history.json` — one entry per day,
so running it several times a day just updates that day's entry — and the
dashboard turns that log into a daily timeline itself (nothing is pre-aggregated
by day in the data files, so the logic lives in one place:
`computeDailyTimeline` in `app.js`):

- One bar per calendar day, from the day *after* the first logged snapshot to the
  most recent one. A bar is that day's imaged count (`Analyzed + Excess`, i.e.
  every imaged candidate regardless of the target) minus the previous day's.
- **The first snapshot is not a bar.** It is everything that was already imaged
  when tracking began (5,536 images on 19 October), which would dwarf the daily
  progress (usually a few dozen images), so it is reported in the caption above the
  chart instead ("Tracking began Oct 19, when 5,536 images were already imaged").
  It changes with the filters like the bars do.
- A day with no snapshot (the pipeline wasn't run) carries the previous total
  forward, so it shows as zero *added* — and the next day that is refreshed gets the
  images of both days. Run the update every working day to keep the bars honest.
- A fall in the imaged count (e.g. a fish un-marked after a mistake) shows as a
  negative bar rather than being hidden.
- Respects the Age class and Institution filters like the rest of the
  dashboard; not affected by the Years filter, since that filters by sampling
  year (`Feltaar`), not by when an image was actually added.
- Follows the Region filter: each history entry stores the project-wide totals
  *and* the same totals per region (`regions`), so selecting a region shows that
  region's daily additions. An entry without a `regions` breakdown is skipped
  when a region is selected rather than guessed at. Rivers with no region count
  only toward the project-wide numbers.
- **The log is restarted whenever the set of rivers changes**, because totals
  over different river sets aren't comparable and the chart would show the
  difference as a bogus burst of "added" images. It was restarted on 2026-10-05
  (per-region totals added; river set had shrunk), again on 2026-10-16, when
  10 rivers came back into the data: only +90 of the ~1,970 extra imaged rows
  that week were new imaging in the existing rivers (all Numedalslågen) — the
  rest were already-imaged samples in the returning rivers — and a third time
  on 2026-10-19, when RB's 8 extra rivers and its 1,100 images were added and every
  entry gained the per-institution fields. To restart, delete
  `data/history.json` before running `build_summary.py`.

This only tracks forward from whenever logging started — it does **not**
retroactively reconstruct how the current backlog of already-imaged samples
accumulated before this feature existed.

## Map of rivers

A panel above *Progress by region* with one circle marker per river:

- **Colour = region** (Nord blue, Sør orange, Vest aqua, Midt violet). Each
  region keeps its own colour, keyed by name in `app.js`, so a region appearing or
  disappearing never repaints the others. The four colours pass the palette
  validator for every pairing on a white background, in normal vision and under
  colour-blind simulation; they're the same in light and dark mode because the
  map is always white (the dark-mode palette doesn't hold up at four colours).
  Size and the popups carry the same information, so colour is never the only
  cue. A fifth region would need a new colour and a fresh validator run.
  **Size = % of target imaged.** Click or tap a marker for that river's numbers.
- It follows the Age class, Institution, Years and Region filters, with the same
  "has candidates in the selected range" rule as the tables, and reframes to whatever
  is shown (so picking a region zooms to it) — without animation, because Leaflet
  ignores a new zoom while one is still animating and quick clicks could otherwise
  leave the map framed on the wrong rivers.
- Base map: Kartverket's open grayscale topographic tiles, drawn with Leaflet
  1.9.4 (both loaded from CDNs; no build step). The tiles only draw land (the sea
  is transparent), so the white background is the map box's own `background` in
  `style.css`, in light and dark mode alike. Scroll-wheel zoom is off so the page
  still scrolls — use the +/− buttons or pinch.

**Positions are approximate, and are not sampling sites.** The spreadsheets
have no coordinates, so `data/rivers.json` holds one representative point per
river (keyed by `Vassdragsnr_hovedvassdrag`) taken from Kartverket's place-name
register (`ws.geonorge.no/stedsnavn`). That point isn't necessarily the outlet:
on long rivers it can be tens of km away. Names that match many rivers in Norway
were resolved by hand — e.g. the Lakselva by its source lake Trollbuvatnet on
Senja, Espedalselva via Espedalsvatnet in Rogaland, Åelva via Roksdalen on
Andøy, Buksnesvassdraget via Teinvatnet next to Buksnes on Andøy, Varpavassdraget
via Varpvatnet in Hamarøy — and the finished set was checked against the data:
all 43 rivers located, all inside Norway, the points follow the coast in
vassdragsnummer order with no strays (largest step 235 km, across a stretch of
numbers with no rivers in the data), and the four regions come out as clean
latitude bands (Sør 58.1–59.5°N, Vest 59.7–61.9°, Midt 62.2–68.9°, Nord
69.0–70.6°) — an independent confirmation that each river sits where its region
says. Each entry's `from` field records exactly which register object was used.
Three of RB's rivers are less certain than the rest: **Storelva (Arna)** is the
Storelva about 2 km from Arna centre (other Storelvas exist nearby),
**Frøysetelva** has no river object in the register so its point is the Frøyset
farm in Masfjorden, and **Flekkeelva** is a point on the river at the Flekke bridge.
If real sampling-site coordinates become available, replace the lat/lon there.

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
`data/`; the current snapshot was generated on 2026-10-19. (The Apps Script in
`SETUP.md` mirrors `build_summary.py`, RB institution included: it reads
`data/rb_pictures.json` from the repo on every run.)

## Project structure

```
index.html / style.css / app.js   the dashboard (static, no build step)
data/summary.json                 pre-aggregated current-state data the page reads
data/history.json                 daily-snapshot log the page turns into the daily timeline
data/rivers.json                  approximate map position per river (static, hand-curated)
data/rb_pictures.json             RB's fish (material) and images so far, by river/age class/year (from extract_rb.py)
scripts/update_dashboard.R        merge the lists, rebuild the data files, commit + push (one command)
scripts/merge_skjell_lister.R     merges the Skjell_lister files into one (one row per fish)
scripts/build_summary.py          regenerates both data files from the xlsx sources + imaging list + rb_pictures.json
scripts/extract_rb.py             builds data/rb_pictures.json from RB's appendix workbook + image folder
SETUP.md                          daily-refresh automation plan (Power Automate + Apps Script)
```
