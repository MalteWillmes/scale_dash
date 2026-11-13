#!/usr/bin/env python3
"""Lists the fish that have scale images in the NINA_nasco image folder, and when their images were saved.

Usage:
    py scripts/scan_nasco_images.py IMAGE_DIR OUT_CSV

IMAGE_DIR is the folder the operators save their images in (P:/132453_digital_skjell/images/NINA_nasco):
one folder per river, one per year inside it, with files named
<River>_<year>_<EnkeltfiskID>_<nr>_<A|A_fw|B|B_fw>.tif. A fish counts as imaged as soon as one of its
files is there. Files with "test" in the name, Thumbs.db and anything that isn't an image are ignored.

OUT_CSV gets one row per fish: EnkeltfiskID, first_saved and last_saved (the local date the oldest and the
newest of its files were saved), files (how many) and scales (e.g. "A,B"). It is fish-level, so it belongs
in the Skjell_lister folder next to the merged list, never in the GitHub repo. build_summary.py reads it
(--image-scan) to count fish that have images but no mark in the operators' lists, and to date them.

If IMAGE_DIR can't be reached or holds no images, nothing is written (the previous CSV stays) and the exit
code is 2, so a caller can fall back on the last scan.
"""
import csv
import os
import re
import sys
from datetime import datetime

IMAGE_EXTENSIONS = {".tif", ".tiff", ".jpg", ".jpeg", ".png"}
# <river>_<year>_<id>_<nr>[_<scale>...] ; the separators are underscores, but a few files use spaces
NAME = re.compile(r"^(?P<river>.+?)[_ ](?P<year>(?:19|20)\d{2})[_ ](?P<id>\d{5,8})[_ ](?P<nr>\d+)(?P<rest>[_ ].*)?$")


def scale_of(rest):
    """'A', 'A_fw', 'B', 'B_fw' (as far as the rest of the name says) or '?'."""
    m = re.search(r"(?<![A-Za-z])([AB])(?![A-Za-z])", rest or "")
    if not m:
        return "?"
    return m.group(1) + ("_fw" if re.search(r"fw", rest, re.I) else "")


def scan(image_dir):
    """({id: {first, last, files, scales}}, [names that are images but don't follow the pattern])."""
    fish = {}
    unmatched = []
    for dirpath, _dirs, names in os.walk(image_dir):
        for name in names:
            stem, ext = os.path.splitext(name)
            if ext.lower() not in IMAGE_EXTENSIONS:
                continue
            full = os.path.join(dirpath, name)
            m = NAME.match(stem)
            if not m:
                unmatched.append(os.path.relpath(full, image_dir))
                continue
            if "test" in (m.group("rest") or "").lower():
                continue
            try:
                stat = os.stat(full)
            except OSError:
                continue
            if stat.st_size == 0:
                continue
            day = datetime.fromtimestamp(stat.st_mtime).date()
            f = fish.setdefault(m.group("id"), {"first": day, "last": day, "files": 0, "scales": set()})
            f["first"] = min(f["first"], day)
            f["last"] = max(f["last"], day)
            f["files"] += 1
            f["scales"].add(scale_of(m.group("rest"))[0])
    return fish, unmatched


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    image_dir, out_csv = sys.argv[1], sys.argv[2]
    sys.stdout.reconfigure(errors="replace")
    if not os.path.isdir(image_dir):
        print(f"ERROR: image folder {image_dir} can't be reached", file=sys.stderr)
        return 2
    fish, unmatched = scan(image_dir)
    if not fish:
        print(f"ERROR: no scale images found in {image_dir}", file=sys.stderr)
        return 2
    tmp = out_csv + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["EnkeltfiskID", "first_saved", "last_saved", "files", "scales"])
        for fid in sorted(fish, key=int):
            v = fish[fid]
            w.writerow([fid, v["first"].isoformat(), v["last"].isoformat(), v["files"], ",".join(sorted(v["scales"]))])
    os.replace(tmp, out_csv)
    days = sorted({v["first"] for v in fish.values()})
    print(f"Image scan: {len(fish)} fish with image files in {image_dir}, first saved {days[0]} to {days[-1]}")
    if unmatched:
        print(f"NOTE: {len(unmatched)} image file(s) do not follow the River_year_ID_nr_scale naming and were not counted, e.g. {unmatched[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
