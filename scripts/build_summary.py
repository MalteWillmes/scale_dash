#!/usr/bin/env python3
"""
Builds data/summary.json from the two NASCO scale-sample source files
(d_1SW_top15.xlsx, d_2SW_top15.xlsx).

Usage:
    python scripts/build_summary.py <path_to_1SW.xlsx> <path_to_2SW.xlsx> [output_path] [--imaged-list <merged.xlsx>]

--imaged-list is the merged imaging list made by scripts/merge_skjell_lister.R (the
Skjell_lister files, one row per fish, operators write their name in the Operator
column of every fish they image). Each fish with an Operator counts as imaged, in
addition to the fish already imaged according to `bilde` / `Bilde_skjell`; a fish
counts once. The list is matched to the two workbooks by EnkeltfiskID. A fish an
operator imaged stays imaged even if a later selection dropped it from the workbooks
(keep_dropped_fish: it is added to its own river-year and age class, which must still
exist in the workbooks, using its row in the list). Nothing from
the list is written to the output except through counts: the totals above, and
data/imaging_log.json, the number of NEW images (fish not already imaged in the
workbooks) operators imaged per day, region and age class, dated by the date they
wrote after their name ("Gunnel_23.10.26"). The daily timeline plots those on the
day they were imaged; history entries record how many operator images they contain
(`sw1OperatorNew`, `sw2OperatorNew`) so that nothing is counted twice.

Rivers are grouped by Vassdragsnr_hovedvassdrag (the canonical watershed id),
not by the free-text Objektnavn -- a couple of watersheds are recorded under
more than one Objektnavn spelling, which would otherwise split one river into
two rows. The displayed name is just the most common Objektnavn for that id.

Each river also carries its `region` (Midt / Nord / Sor / Vest) from the source
`region` column, kept exactly as written. A watershed maps to a single region
in the data; if rows ever disagree, the most common non-empty value wins.

Institutions. Everything in the two NINA workbooks is institution NINA. The
collaborator RB's fish come from data/rb_pictures.json (next to the output file;
made by scripts/extract_rb.py from the project appendix and RB's image folder)
and are institution RB. RB's imaging is not finished: its `material` (the fish
the appendix lists, per river and year) is what has to be imaged, and its
`pictures` are the fish imaged so far. Each river-year's Required / Analyzed /
Excess is computed three ways, with the field-name infix saying which:
    ""      all institutions combined (sw1Required, ...)  -- a river-year counts
            ONCE toward the target however many institutions contributed: the
            fish available are NINA's selected fish + RB's fish, and
            imaged = NINA's imaged candidates + RB's pictures
    "Nina"  NINA only (sw1NinaRequired, ...)
    "Rb"    RB only   (sw1RbRequired, ...); available = RB's material (or its
            pictures, if there are more), imaged = RB's pictures; a river-year
            RB has no fish for does not exist in this view
A river that only RB has fish from (e.g. Bjerkreimselva) exists only in the
combined and RB views.

Each river/year has a candidate pool of up to 15 randomly-selected fish (per
the NASCO sampling design), of which up to PER_YEAR_TARGET need to be imaged
for that river/year -- the rest are kept in reserve in case of poor scale
quality. Some river-years have fewer than PER_YEAR_TARGET fish selected at all;
for those, every selected fish needs imaging.

"Required"  = the fish available for that river-year and age class, capped at
              PER_YEAR_TARGET (10 for 1SW, 10 for 2SW): min(10, selected fish).
              For NINA the available fish are the candidates selected that year
              (up to 15), for RB the fish its material lists. So a river-year
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

A candidate counts as "imaged" when the 0/1 `bilde` flag is 1, a
`Bilde_skjell` filename is filled in, or (with --imaged-list) an operator has marked
it in the imaging lists. `bilde` is the broader of the first two: every
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
project-wide totals.) The dashboard turns that log into a daily timeline
itself -- nothing here is pre-aggregated by day, so that logic only has to live
in one place.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict, namedtuple
from datetime import date, datetime, timezone

import openpyxl

REQUIRED_COLUMNS = ["EnkeltfiskID", "Objektnavn", "Vassdragsnr_hovedvassdrag", "Feltaar", "Bilde_skjell", "bilde", "region"]

# Per-river, per-year imaging target: at most this many fish per age class need
# imaging (a river-year with fewer fish selected needs all of them). The
# candidate pool itself is usually larger (up to 15) -- the remainder are
# reserve fish kept in case of poor scale quality. Confirmed with the project
# lead: 10 for both age classes.
PER_YEAR_TARGET = {"sw1": 10, "sw2": 10}


def fish_key(value):
    """EnkeltfiskID as a comparable string (Excel hands back 2594921 or 2594921.0 depending on the cell)."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


OPERATOR_DATE = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\s*$")


def parse_operator_date(text, today):
    """The date an operator wrote after their name ('Gunnel_23.10.26' -> 2026-10-23), or None
    when there is none, it isn't a real date, or it lies in the future (a typo)."""
    m = OPERATOR_DATE.search(str(text))
    if not m:
        return None
    day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if year < 100:
        year += 2000
    try:
        d = date(year, month, day)
    except ValueError:
        return None
    return d if d <= today else None


Marked = namedtuple("Marked", "date river year sea region lregnr")


def load_imaged_ids(path, today=None):
    """{EnkeltfiskID: Marked(date, river, year, sea, region, lregnr)} for every fish with a name in
    the Operator column of the merged imaging list (made by scripts/merge_skjell_lister.R): those
    fish have been imaged in the NASCO imaging. `date` is the day the operator imaged it (None if the
    Operator entry has no usable date); the rest is the fish's own row in the list (Objektnavn,
    Feltaar, Sjoalder, region, Lregnr; None where the list has no such column), which is what lets
    a fish that a later selection dropped from the top-15 workbooks be counted anyway."""
    today = today or datetime.now(timezone.utc).date()
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
    idx = {name: i for i, name in enumerate(header_row)}
    missing = [c for c in ("EnkeltfiskID", "Operator") if c not in idx]
    if missing:
        raise SystemExit(f"{path}: missing expected columns {missing}")

    def cell(r, name):
        return r[idx[name]] if name in idx else None

    imaged = {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        operator = r[idx["Operator"]]
        if r[idx["EnkeltfiskID"]] is not None and operator is not None and str(operator).strip() != "":
            imaged[fish_key(r[idx["EnkeltfiskID"]])] = Marked(
                parse_operator_date(operator, today),
                cell(r, "Objektnavn"),
                cell(r, "Feltaar"),
                cell(r, "Sjoalder"),
                str(cell(r, "region")).strip() if cell(r, "region") is not None else "",
                fish_key(cell(r, "Lregnr")) if cell(r, "Lregnr") is not None else None,
            )
    return imaged


def load_rows(path, imaged_ids=frozenset(), stats=None, sw_key=None, op_log=None, seen=None, lregnr_map=None):
    """One tuple per fish: (river, watershed id, year, imaged?, region).

    A fish is imaged when `bilde` is 1, a `Bilde_skjell` filename is filled in, or its
    EnkeltfiskID is in `imaged_ids` (marked with an Operator in the imaging lists); it
    counts once however many of these apply. If `stats` (a Counter) is given it gets
    `listed` (fish of this workbook that are in imaged_ids), `listed_new` (of those,
    the ones that were not already counted as imaged) and `new_undated` (of the new ones,
    those whose Operator entry has no usable date). If `op_log` (a Counter) and `sw_key`
    are given, every new image with a date is added to it as (date, region, sw_key) -- the
    imaging log, one count per day the operators imaged fish. `seen` (a set) collects the
    EnkeltfiskID of every marked fish found, and `lregnr_map` (a dict) learns which watershed
    id and river name each Lregnr belongs to, for keep_dropped_fish()."""
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
        if lregnr_map is not None and "Lregnr" in idx and r[idx["Lregnr"]] is not None:
            lregnr_map.setdefault(fish_key(r[idx["Lregnr"]]), Counter())[(str(watershed), str(river))] += 1
        if imaged_ids and r[idx["EnkeltfiskID"]] is not None and fish_key(r[idx["EnkeltfiskID"]]) in imaged_ids:
            marked = imaged_ids[fish_key(r[idx["EnkeltfiskID"]])]
            marked_on = marked.date if isinstance(marked, Marked) else None
            if seen is not None:
                seen.add(fish_key(r[idx["EnkeltfiskID"]]))
            if stats is not None:
                stats["listed"] += 1
                stats["listed_new"] += 0 if has_image else 1
                stats["new_undated"] += 1 if (not has_image and marked_on is None) else 0
            if not has_image and marked_on is not None and op_log is not None and sw_key is not None:
                op_log[(marked_on.isoformat(), region, sw_key)] += 1
            has_image = True
        rows.append((str(river), str(watershed), int(year), has_image, region))
    return rows


def keep_dropped_fish(rows_by_class, imaged_ids, seen, lregnr_map, stats, op_log):
    """Fish an operator has imaged stay imaged, even if a later selection dropped them from the
    top-15 workbooks (as happened on 2026-10-23 for 11 fish in Numedalslagen 2023: the selection
    keeps the fish that `bilde` says are imaged, but doesn't know about the operators' marks).

    Each such fish (marked in `imaged_ids`, not in `seen`) is added to the rows of its own river-year
    and age class as an imaged fish, provided that river-year still has candidates in the workbooks
    (so no river-year is created from a single stray fish). It also goes into the imaging log on the
    day it was imaged. The fish's river, year, age class and region come from its row in the imaging
    list; the watershed id from the workbooks' Lregnr. Returns ({(river, year, class): n} kept,
    [reasons for fish that could not be kept])."""
    groups = {c: {(ws, year) for _, ws, year, _, _ in rows} for c, rows in rows_by_class.items()}
    kept = Counter()
    skipped = Counter()
    for fid, m in imaged_ids.items():
        if fid in seen:
            continue
        sw_key = {1: "sw1", 2: "sw2"}.get(int(m.sea)) if isinstance(m.sea, (int, float)) else None
        place = lregnr_map.get(m.lregnr) if m.lregnr else None
        if sw_key is None:
            skipped["not 1SW or 2SW"] += 1
            continue
        if not place or m.year is None:
            skipped["its river/year is unknown"] += 1
            continue
        watershed, river = place.most_common(1)[0][0]
        year = int(m.year)
        if (watershed, year) not in groups[sw_key]:
            skipped["its river-year is no longer in the workbooks"] += 1
            continue
        rows_by_class[sw_key].append((river, watershed, year, True, m.region))
        kept[(river, year, sw_key)] += 1
        stats["kept"] += 1
        if m.date is None:
            stats["new_undated"] += 1
        elif op_log is not None:
            op_log[(m.date.isoformat(), m.region, sw_key)] += 1
    return kept, skipped


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
    # fish and pictures come from `rb` (data/rb_pictures.json). A river-year counts
    # ONCE toward the target in the combined view, however many institutions
    # contributed: the fish available are NINA's selected fish + RB's fish, and
    # imaged = NINA's imaged candidates + RB's pictures.
    rb = rb or {}
    watersheds = {}  # watershed id -> {watershedId, nameCounts, regionCounts, byYear: {year: {...}}}
    all_years = set()

    def entry_for(ws):
        return watersheds.setdefault(
            ws, {"watershedId": ws, "nameCounts": Counter(), "regionCounts": Counter(), "byYear": {}}
        )

    nina = {c: defaultdict(lambda: [0, 0]) for c in CLASSES}  # class -> (ws, year) -> [pool, imaged]
    rb_material = {c: {} for c in CLASSES}  # class -> (ws, year) -> fish RB has (to be imaged)
    pictures = {c: {} for c in CLASSES}  # class -> (ws, year) -> fish RB has imaged so far

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
            for year, n in river.get("material", {}).get(sheet, {}).items():
                rb_material[sw_key][(ws, int(year))] = n
            for year, n in river.get("pictures", {}).get(sheet, {}).items():
                pictures[sw_key][(ws, int(year))] = n

    for sw_key in CLASSES:
        target = PER_YEAR_TARGET[sw_key]
        for ws, year in set(nina[sw_key]) | set(rb_material[sw_key]) | set(pictures[sw_key]):
            all_years.add(year)
            pool, nina_imaged = nina[sw_key][(ws, year)] if (ws, year) in nina[sw_key] else (0, 0)
            rb_imaged = pictures[sw_key].get((ws, year), 0)
            # RB's fish for the river-year: what its material lists, or the images it has
            # if there are more of them (so that imaged never exceeds available).
            rb_available = max(rb_material[sw_key].get((ws, year), 0), rb_imaged)
            yr = entry_for(ws)["byYear"].setdefault(str(year), {k: 0 for k in FIELDS})
            # (infix, fish available, fish imaged); imaged never exceeds available
            views = (
                ("", pool + rb_available, nina_imaged + rb_imaged),
                ("Nina", pool, nina_imaged),
                ("Rb", rb_available, rb_imaged),
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
            # years in ascending order: the output is then identical from run to run
            # (set iteration order is not), so the data files only change when the numbers do
            "byYear": dict(sorted(ws_entry["byYear"].items(), key=lambda kv: int(kv[0]))),
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


def operator_counts(op_log, region=None, up_to=None):
    """{sw1OperatorNew: n, sw2OperatorNew: n}: how many images operators have added (fish that
    were not already imaged), from the imaging log -- a Counter {(date, region, sw_key): n}.
    region=None counts every region (including rivers without one); `up_to` (an ISO date) only
    counts days on or before it."""
    counts = {f"{c}OperatorNew": 0 for c in CLASSES}
    for (day, reg, sw_key), n in op_log.items():
        if (region is None or reg == region) and (up_to is None or day <= up_to):
            counts[f"{sw_key}OperatorNew"] += n
    return counts


def add_operator_fields(entry, op_log):
    """A history entry from before the OperatorNew fields existed, with them reconstructed from
    the imaging log: the images dated on or before the entry's own date."""
    new = {k: v for k, v in entry.items() if k != "regions"}
    new.update(operator_counts(op_log, up_to=entry["date"]))
    if "regions" in entry:
        new["regions"] = {
            r: {**v, **operator_counts(op_log, region=r, up_to=entry["date"])} for r, v in entry["regions"].items()
        }
    return new


def update_history(history_path, date_str, totals, regions, op_log=None):
    """Upsert one {date, ...totals, OperatorNew, regions} entry into the history log, sorted by date.

    Besides the imaged totals each entry records how many of those images were added by operators
    (`sw1OperatorNew`, `sw2OperatorNew`; per region too). The dashboard needs that to draw the
    daily timeline: operator images are plotted on the day they were imaged (the imaging log),
    and everything else (RB's images, changes to the source workbooks) on the day it was first
    seen, i.e. the change in "imaged total minus operator images" between two entries."""
    op_log = op_log if op_log is not None else Counter()
    if os.path.exists(history_path):
        with open(history_path, encoding="utf-8") as f:
            history = json.load(f)
    else:
        history = []

    history = [h for h in history if h.get("date") != date_str]
    history = [h if f"{CLASSES[0]}OperatorNew" in h else add_operator_fields(h, op_log) for h in history]
    entry = {"date": date_str}
    entry.update(totals)
    entry.update(operator_counts(op_log))
    entry["regions"] = {r: {**v, **operator_counts(op_log, region=r)} for r, v in regions.items()}
    history.append(entry)
    history.sort(key=lambda h: h["date"])

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    return history


def write_imaging_log(path, op_log):
    """data/imaging_log.json: new images added by operators per day, region and age class -- counts
    only. The dashboard plots them on the day the operator imaged the fish."""
    days = {}
    for (day, region, sw_key), n in sorted(op_log.items()):
        days.setdefault(day, {}).setdefault(region, {})[sw_key] = n
    doc = {
        "about": (
            "New images added by operators (fish not already imaged in the source workbooks), by the day the "
            "operator imaged them (the date in the Operator column of the imaging lists), region and age class. "
            "Counts only. Regenerated by scripts/build_summary.py --imaged-list."
        ),
        "days": days,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)


def main():
    argv = sys.argv[1:]
    imaged_list = None
    if "--imaged-list" in argv:
        i = argv.index("--imaged-list")
        if i + 1 >= len(argv):
            raise SystemExit("--imaged-list needs a path")
        imaged_list = argv[i + 1]
        del argv[i:i + 2]
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    path_1sw, path_2sw = argv[0], argv[1]
    out_path = argv[2] if len(argv) > 2 else "data/summary.json"
    history_path = os.path.join(os.path.dirname(out_path) or ".", "history.json")

    rb_path = os.path.join(os.path.dirname(out_path) or ".", "rb_pictures.json")

    log_path = os.path.join(os.path.dirname(out_path) or ".", "imaging_log.json")

    sys.stdout.reconfigure(errors="replace")  # river names with å/ø must not break a run with an ASCII console
    imaged_ids = load_imaged_ids(imaged_list) if imaged_list else {}
    stats = Counter()
    op_log = Counter()  # (date, region, sw_key) -> new images the operators imaged that day
    seen = set()  # marked fish found in the workbooks
    lregnr_map = {}  # Lregnr -> Counter of (watershed id, river name)
    rows_1sw = load_rows(path_1sw, imaged_ids, stats, "sw1", op_log, seen, lregnr_map)
    rows_2sw = load_rows(path_2sw, imaged_ids, stats, "sw2", op_log, seen, lregnr_map)
    kept, kept_skipped = keep_dropped_fish({"sw1": rows_1sw, "sw2": rows_2sw}, imaged_ids, seen, lregnr_map, stats, op_log)
    rb = load_rb(rb_path)
    summary = aggregate(rows_1sw, rows_2sw, rb)
    if imaged_list:
        counted = stats["listed"] + stats["kept"]
        print(
            f"Imaging list {os.path.basename(imaged_list)}: {len(imaged_ids)} fish with an operator, "
            f"{counted} counted ({stats['listed']} found in the workbooks, {stats['kept']} kept although the "
            f"workbooks no longer contain them), {stats['listed_new'] + stats['kept']} of them new images"
            f" (not already counted from bilde / Bilde_skjell)"
        )
        if kept:
            by_group = {}
            for (river, year, sw_key), n in sorted(kept.items()):
                by_group.setdefault((river, year), []).append(f"{sw_key[2]}SW {n}")
            print(
                "Kept operator-imaged fish that the workbooks no longer list (a re-selection dropped them): "
                + "; ".join(f"{river} {year} ({', '.join(parts)})" for (river, year), parts in by_group.items())
            )
        for reason, n in kept_skipped.items():
            print(f"WARNING: {n} fish with an operator are not in the workbooks and were not counted: {reason}")
        if stats["new_undated"]:
            print(
                f"WARNING: {stats['new_undated']} new images have no usable date in the Operator column "
                f"(none, not a real date, or in the future): the timeline shows them on the day the data is refreshed"
            )
        days = sorted({day for day, _, _ in op_log})
        print(f"Imaging log: {sum(op_log.values())} new images on {len(days)} day(s)" + (f", {days[0]} to {days[-1]}" if days else ""))

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    write_imaging_log(log_path, op_log)

    today = summary["generatedAt"][:10]  # YYYY-MM-DD
    history = update_history(history_path, today, summary["totals"], region_totals(summary["rivers"]), op_log)

    print(f"Wrote {out_path}: {len(summary['rivers'])} rivers ({len(rb)} with RB fish), years {summary['years'][0]}-{summary['years'][-1]}")
    print(f"Totals: {summary['totals']}")
    print(f"Wrote {history_path}: {len(history)} dated entries; {log_path}")


if __name__ == "__main__":
    main()
