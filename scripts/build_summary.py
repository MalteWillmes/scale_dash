#!/usr/bin/env python3
"""
Builds data/summary.json from the two NASCO scale-sample source files
(d_1SW_top15.xlsx, d_2SW_top15.xlsx).

Usage:
    python scripts/build_summary.py <path_to_1SW.xlsx> <path_to_2SW.xlsx> [output_path]

"Required" = a candidate row selected for a river/year (the up-to-15 fish
per river/year the project randomly selects).
"Analyzed" = a candidate row where Bilde_skjell (the scale image filename)
is filled in, i.e. the scale has actually been imaged.

This same logic is meant to be re-implemented by the daily refresh pipeline
(see SETUP.md) so a manual re-run of this script and the automated pipeline
always produce the identical JSON shape.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

import openpyxl

REQUIRED_COLUMNS = ["Objektnavn", "Vassdragsnr_hovedvassdrag", "Feltaar", "Bilde_skjell"]


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
        has_image = r[idx["Bilde_skjell"]] not in (None, "")
        if river is None or year is None:
            continue
        rows.append((str(river), str(watershed) if watershed is not None else "", int(year), has_image))
    return rows


def aggregate(rows_1sw, rows_2sw):
    rivers = {}  # name -> {watershedId, byYear: {year: {...}}}
    all_years = set()

    def add(rows, sw_key):
        for river, watershed, year, has_image in rows:
            all_years.add(year)
            entry = rivers.setdefault(river, {"name": river, "watershedId": watershed, "byYear": {}})
            if not entry["watershedId"] and watershed:
                entry["watershedId"] = watershed
            yr = entry["byYear"].setdefault(
                str(year),
                {"sw1Required": 0, "sw1Analyzed": 0, "sw2Required": 0, "sw2Analyzed": 0},
            )
            yr[f"{sw_key}Required"] += 1
            if has_image:
                yr[f"{sw_key}Analyzed"] += 1

    add(rows_1sw, "sw1")
    add(rows_2sw, "sw2")

    totals = {"sw1Required": 0, "sw1Analyzed": 0, "sw2Required": 0, "sw2Analyzed": 0}
    river_list = []
    for river in rivers.values():
        river_totals = {"sw1Required": 0, "sw1Analyzed": 0, "sw2Required": 0, "sw2Analyzed": 0}
        for yr in river["byYear"].values():
            for k in river_totals:
                river_totals[k] += yr[k]
        river["totals"] = river_totals
        for k in totals:
            totals[k] += river_totals[k]
        river_list.append(river)

    river_list.sort(key=lambda r: r["name"])

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "years": sorted(all_years),
        "rivers": river_list,
        "totals": totals,
    }


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    path_1sw, path_2sw = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else "data/summary.json"

    rows_1sw = load_rows(path_1sw)
    rows_2sw = load_rows(path_2sw)
    summary = aggregate(rows_1sw, rows_2sw)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"Wrote {out_path}: {len(summary['rivers'])} rivers, years {summary['years'][0]}-{summary['years'][-1]}")
    print(f"Totals: {summary['totals']}")


if __name__ == "__main__":
    main()
