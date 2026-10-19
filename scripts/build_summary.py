#!/usr/bin/env python3
"""
Builds data/summary.json from the two NASCO scale-sample source files
(d_1SW_top15.xlsx, d_2SW_top15.xlsx).

Usage:
    python scripts/build_summary.py <path_to_1SW.xlsx> <path_to_2SW.xlsx> [output_path]

Rivers are grouped by Vassdragsnr_hovedvassdrag (the canonical watershed id),
not by the free-text Objektnavn -- a couple of watersheds are recorded under
more than one Objektnavn spelling, which would otherwise split one river into
two rows. The displayed name is just the most common Objektnavn for that id.

Each river also carries its `region` (Midt / Nord / Sor / Vest) from the source
`region` column, kept exactly as written. A watershed maps to a single region
in the data; if rows ever disagree, the most common non-empty value wins.

Institutions. Everything in the two NINA workbooks is institution NINA. The
collaborator RB's existing pictures come from data/rb_pictures.json (next to
the output file; made by scripts/extract_rb.py from the project appendix) and
are institution RB. Each river-year's Required / Analyzed / Excess is computed
three ways, with the field-name infix saying which:
    ""      all institutions combined (sw1Required, ...)  -- a river-year counts
            ONCE toward the target however many institutions contributed: the
            fish available are NINA's selected fish + RB's pictures, and
            imaged = NINA's imaged candidates + RB's pictures
    "Nina"  NINA only (sw1NinaRequired, ...)
    "Rb"    RB only   (sw1RbRequired, ...); RB's material is its pictures, so a
            river-year RB has no pictures for does not exist in this view
A river that only RB has pictures from (e.g. Bjerkreimselva) exists only in
the combined and RB views.

Each river/year has a candidate pool of up to 15 randomly-selected fish (per
the NASCO sampling design), of which up to PER_YEAR_TARGET need to be imaged
for that river/year -- the rest are kept in reserve in case of poor scale
quality. Some river-years have fewer than PER_YEAR_TARGET fish selected at all;
for those, every selected fish needs imaging.

"Required"  = the fish available for that river-year and age class, capped at
              PER_YEAR_TARGET (10 for 1SW, 10 for 2SW): min(10, selected fish).
              For NINA the available fish are the candidates selected that year
              (up to 15), for RB the fish it has pictures for. So a river-year
              with 7 selected fish needs 7 images and reaches 100% when all 7
              are imaged, instead of being stuck below 100% for ever.
"Analyzed"  = however many of the imaged fish count toward that, i.e.
              min(imaged count, required).
"Excess"    = imaged fish beyond what is required (imaged count minus
              required, floored at 0) -- extra coverage that isn't needed to
              hit the target but exists anyway. Imaged never exceeds the fish
              available, so this is only ever non-zero when more than 10 fish
              are available.
Required + Analyzed always describes a 0-100% target; Excess is reported
separately and is never part of that percentage.

This same logic is meant to be re-implemented by the daily refresh pipeline
(see SETUP.md) so a manual re-run of this script and the automated pipeline
always produce the identical JSON shape.

A candidate counts as "imaged" when the 0/1 `bilde` flag is 1 or a
`Bilde_skjell` filename is filled in. `bilde` is the broader of the two: every
row with a filename also has bilde = 1, but recent images (2019-2025) are
flagged by `bilde` alone with no filename recorded, so filename-only badly
undercounts them.

The source spreadsheet has no "date image added" column -- the image flag only
says whether an image exists *now*, not when it appeared -- so there is no way
to reconstruct history retroactively. Instead, every run of this script (or
the daily Apps Script pipeline) upserts today's totals as one entry in
data/history.json, keyed by date (one entry per calendar day; re-running the
same day overwrites that day's entry rather than duplicating it). Each entry
holds the project-wide totals plus a `regions` object with the same totals per
region, so the timeline can follow the dashboard's Region filter -- and because
history can't be rebuilt after the fact, every entry has to carry that
breakdown from the start. (Rivers with no region only count toward the
project-wide totals.) The dashboard buckets that log into a weekly timeline
itself -- nothing here is pre-aggregated by week, so the bucketing logic only
has to live in one place.
"""
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

import openpyxl

REQUIRED_COLUMNS = ["Objektnavn", "Vassdragsnr_hovedvassdrag", "Feltaar", "Bilde_skjell", "bilde", "region"]

# Per-river, per-year imaging target: at most this many fish per age class need
# imaging (a river-year with fewer fish selected needs all of them). The
# candidate pool itself is usually larger (up to 15) -- the remainder are
# reserve fish kept in case of poor scale quality. Confirmed with the project
# lead: 10 for both age classes.
PER_YEAR_TARGET = {"sw1": 10, "sw2": 10}


def load_rows(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
    idx = {name: i for i, name in enumerate(header_row)}
    missing = [c for c in REQUIRED_COLUMNS if c not in idx]
    if missing:
        raise SystemExit(f"{path}: missing expected columns {missing}")

    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        river = r[idx["Objektnavn"]]
        watershed = r[idx["Vassdragsnr_hovedvassdrag"]]
        year = r[idx["Feltaar"]]
        has_image = r[idx["bilde"]] == 1 or r[idx["Bilde_skjell"]] not in (None, "")
        region = str(r[idx["region"]]).strip() if r[idx["region"]] is not None else ""
        if river is None or year is None or watershed is None or str(watershed).strip() == "":
            continue
        rows.append((str(river), str(watershed), int(year), has_image, region))
    return rows


# Every river-year is computed three ways so the dashboard can filter by
# institution: all institutions combined (the original field names, no infix),
# NINA only ("Nina") and RB only ("Rb").
CLASSES = ("sw1", "sw2")
VIEW_INFIXES = ("", "Nina", "Rb")
MEASURES = ("Required", "Analyzed", "Excess")
FIELDS = [f"{c}{infix}{m}" for infix in VIEW_INFIXES for c in CLASSES for m in MEASURES]


def load_rb(path):
    """The `rivers` object of data/rb_pictures.json (see scripts/extract_rb.py), or {} if absent."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)["rivers"]


def aggregate(rows_1sw, rows_2sw, rb=None):
    # Grouped by Vassdragsnr_hovedvassdrag (the canonical watershed/main-river
    # id), not by Objektnavn -- some watersheds are recorded under more than
    # one Objektnavn spelling (e.g. "041.Z" appears as both "Etneelva" and
    # "Etneelva/Sørelva"), which would otherwise fragment one river into
    # multiple rows. The displayed name is the most common Objektnavn seen
    # for that watershed id (ties broken alphabetically).
    #
    # Institutions: everything in the NINA workbooks is institution NINA; RB's
    # pictures come from `rb` (data/rb_pictures.json). A river-year counts ONCE
    # toward the target in the combined view, however many institutions
    # contributed: the fish available are NINA's selected fish + RB's pictures,
    # and imaged = NINA's imaged candidates + RB's pictures.
    rb = rb or {}
    watersheds = {}  # watershed id -> {watershedId, nameCounts, regionCounts, byYear: {year: {...}}}
    all_years = set()

    def entry_for(ws):
        return watersheds.setdefault(
            ws, {"watershedId": ws, "nameCounts": Counter(), "regionCounts": Counter(), "byYear": {}}
        )

    nina = {c: defaultdict(lambda: [0, 0]) for c in CLASSES}  # class -> (ws, year) -> [pool, imaged]
    pictures = {c: {} for c in CLASSES}  # class -> (ws, year) -> RB pictures

    for sw_key, rows in (("sw1", rows_1sw), ("sw2", rows_2sw)):
        for river, ws, year, has_image, region in rows:
            e = entry_for(ws)
            e["nameCounts"][river] += 1
            if region:
                e["regionCounts"][region] += 1
            cell = nina[sw_key][(ws, year)]
            cell[0] += 1  # candidate in the pool
            cell[1] += 1 if has_image else 0

    for ws, river in rb.items():
        e = entry_for(ws)
        e["nameCounts"][river["name"]] += 1  # one vote: NINA's spelling wins on a shared river
        if river.get("region"):
            e["regionCounts"][river["region"]] += 1
        for sheet, sw_key in (("1SW", "sw1"), ("2SW", "sw2")):
            for year, n in river["pictures"].get(sheet, {}).items():
                pictures[sw_key][(ws, int(year))] = n

    for sw_key in CLASSES:
        target = PER_YEAR_TARGET[sw_key]
        for ws, year in set(nina[sw_key]) | set(pictures[sw_key]):
            all_years.add(year)
            pool, nina_imaged = nina[sw_key][(ws, year)] if (ws, year) in nina[sw_key] else (0, 0)
            rb_n = pictures[sw_key].get((ws, year), 0)
            yr = entry_for(ws)["byYear"].setdefault(str(year), {k: 0 for k in FIELDS})
            # (infix, fish available, fish imaged); imaged never exceeds available
            views = (
                ("", pool + rb_n, nina_imaged + rb_n),
                ("Nina", pool, nina_imaged),
                ("Rb", rb_n, rb_n),
            )
            for infix, available, imaged_count in views:
                if available == 0:
                    continue
                # Every available fish needs imaging, up to the target: a river-year
                # with fewer than `target` fish selected can still reach 100%.
                required = min(target, available)
                yr[f"{sw_key}{infix}Required"] += required
                yr[f"{sw_key}{infix}Analyzed"] += min(imaged_count, required)
                yr[f"{sw_key}{infix}Excess"] += max(0, imaged_count - required)

    totals = {k: 0 for k in FIELDS}
    river_list = []
    for ws_entry in watersheds.values():
        best_name = sorted(ws_entry["nameCounts"].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        region_counts = sorted(ws_entry["regionCounts"].items(), key=lambda kv: (-kv[1], kv[0]))
        best_region = region_counts[0][0] if region_counts else ""
        river_totals = {k: 0 for k in FIELDS}
        for yr in ws_entry["byYear"].values():
            for k in river_totals:
                river_totals[k] += yr[k]
        for k in totals:
            totals[k] += river_totals[k]
        river_list.append({
            "name": best_name,
            "watershedId": ws_entry["watershedId"],
            "region": best_region,
            "byYear": ws_entry["byYear"],
            "totals": river_totals,
        })

    river_list.sort(key=lambda r: r["name"])

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "years": sorted(all_years),
        "rivers": river_list,
        "totals": totals,
    }


def region_totals(rivers):
    """Sum each river's totals by region (rivers without a region are skipped)."""
    by_region = {}
    for river in rivers:
        region = river["region"]
        if not region:
            continue
        acc = by_region.setdefault(region, {k: 0 for k in FIELDS})
        for k in FIELDS:
            acc[k] += river["totals"][k]
    return dict(sorted(by_region.items()))


def update_history(history_path, date_str, totals, regions):
    """Upsert one {date, ...totals, regions} entry into the history log, sorted by date."""
    if os.path.exists(history_path):
        with open(history_path, encoding="utf-8") as f:
            history = json.load(f)
    else:
        history = []

    history = [h for h in history if h.get("date") != date_str]
    entry = {"date": date_str}
    entry.update(totals)
    entry["regions"] = regions
    history.append(entry)
    history.sort(key=lambda h: h["date"])

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    return history


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    path_1sw, path_2sw = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else "data/summary.json"
    history_path = os.path.join(os.path.dirname(out_path) or ".", "history.json")

    rb_path = os.path.join(os.path.dirname(out_path) or ".", "rb_pictures.json")

    rows_1sw = load_rows(path_1sw)
    rows_2sw = load_rows(path_2sw)
    rb = load_rb(rb_path)
    summary = aggregate(rows_1sw, rows_2sw, rb)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    today = summary["generatedAt"][:10]  # YYYY-MM-DD
    history = update_history(history_path, today, summary["totals"], region_totals(summary["rivers"]))

    print(f"Wrote {out_path}: {len(summary['rivers'])} rivers ({len(rb)} with RB pictures), years {summary['years'][0]}-{summary['years'][-1]}")
    print(f"Totals: {summary['totals']}")
    print(f"Wrote {history_path}: {len(history)} dated entries")


if __name__ == "__main__":
    main()
