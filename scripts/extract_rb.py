#!/usr/bin/env python3
"""
Extracts the pictures that the collaborator RB (Radgivende Biologer) already has
from the project appendix workbook ("Vedlegg 1 - materiale 1989-2024") into
data/rb_pictures.json, which build_summary.py reads.

Usage:
    python scripts/extract_rb.py <Vedlegg1_materiale_1989_2024.xlsx> [output_path]

The workbook has one sheet per age class (1SW, 2SW, 3SW) and one row per river
and institution (Institusjon = NINA or RB). The year columns hold how many fish
of material exist for that river and year, and the last column,
"Eksisterande bildemateriale" (existing image material), says how much of it
already has pictures. For every RB row that column is a plain =SUM(range) over
the year columns, so the range is read from the formula itself rather than
hard-coded: those year cells are RB's pictures. (For all RB rows today that is
2016-2024.) The script checks that the cells in that range add up to the cached
value of the column and stops if they don't.

Only the 1SW and 2SW sheets are used (the dashboard tracks those two age
classes; the 3SW sheet is ignored). NINA rows are ignored: everything the
dashboard already had is institution NINA. RB material in years *outside* the
formula's range has no pictures yet; it is not counted, only summarised under
`notCounted` so that nothing is silently dropped.
"""
import json
import re
import sys
from datetime import date

import openpyxl
from openpyxl.utils import column_index_from_string

AGE_SHEETS = ("1SW", "2SW")
SUM_RANGE = re.compile(r"=SUM\(([A-Z]+)\d+:([A-Z]+)\d+\)")


def ascii_fold(text):
    # The dashboard's data writes the southern region as "Sor" (no o-slash).
    return text.replace("ø", "o").replace("Ø", "O")


def extract(path):
    values = openpyxl.load_workbook(path, data_only=True)
    formulas = openpyxl.load_workbook(path, data_only=False)
    rivers = {}

    for sheet in AGE_SHEETS:
        wv, wf = values[sheet], formulas[sheet]
        header = [c.value for c in wv[1]]
        if "Eksisterande bildemateriale" not in header or "Institusjon" not in header:
            raise SystemExit(f"{sheet}: expected columns 'Institusjon' and 'Eksisterande bildemateriale' not found")
        i_pic = header.index("Eksisterande bildemateriale")
        i_inst = header.index("Institusjon")
        year_at = {i: h for i, h in enumerate(header) if isinstance(h, int)}

        for row_v, row_f in zip(wv.iter_rows(min_row=2, values_only=True), wf.iter_rows(min_row=2, values_only=True)):
            if row_v[i_inst] != "RB":
                continue
            river_id, name = row_v[2].split(" ", 1)
            region = ascii_fold(row_v[0])

            m = SUM_RANGE.fullmatch(str(row_f[i_pic]))
            if not m:
                raise SystemExit(f"{sheet} {river_id}: 'Eksisterande bildemateriale' is {row_f[i_pic]!r}, not a plain =SUM(range)")
            c0 = column_index_from_string(m.group(1)) - 1
            c1 = column_index_from_string(m.group(2)) - 1
            in_range = {c: year_at[c] for c in range(c0, c1 + 1) if c in year_at}

            pictures = {str(year_at[c]): row_v[c] for c in in_range if isinstance(row_v[c], int) and row_v[c] > 0}
            if sum(pictures.values()) != row_v[i_pic]:
                raise SystemExit(
                    f"{sheet} {river_id}: year cells in the formula's range add up to {sum(pictures.values())}, "
                    f"but 'Eksisterande bildemateriale' is {row_v[i_pic]}"
                )

            outside = {year_at[c]: row_v[c] for c in year_at if c not in in_range and isinstance(row_v[c], int) and row_v[c] > 0}

            r = rivers.setdefault(river_id, {"name": name, "region": region, "pictures": {}, "notCounted": {}})
            if r["name"] != name or r["region"] != region:
                raise SystemExit(f"{river_id}: name/region differ between sheets ({r['name']}/{r['region']} vs {name}/{region})")
            r["pictures"][sheet] = dict(sorted(pictures.items()))
            r["notCounted"][sheet] = {"riverYears": len(outside), "fish": sum(outside.values())}

    return dict(sorted(rivers.items()))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else "data/rb_pictures.json"

    rivers = extract(path)
    doc = {
        "about": (
            "Pictures that the collaborator RB (Radgivende Biologer) already has, by river, age class and year, "
            "extracted from the project appendix workbook (Institusjon = RB rows, sheets 1SW and 2SW). "
            "A year's value is the number of fish with pictures; the years that count are those covered by the "
            "workbook's own 'Eksisterande bildemateriale' formula. `notCounted` summarises RB material in other "
            "years, which has no pictures yet and is not used. Regenerate with scripts/extract_rb.py."
        ),
        "source": path.replace("\\", "/").split("/")[-1],
        "extractedOn": date.today().isoformat(),
        "rivers": rivers,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    totals = {s: sum(sum(r["pictures"].get(s, {}).values()) for r in rivers.values()) for s in AGE_SHEETS}
    print(f"Wrote {out_path}: {len(rivers)} RB rivers, pictures {totals} (total {sum(totals.values())})")


if __name__ == "__main__":
    main()
