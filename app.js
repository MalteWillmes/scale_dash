(function () {
  "use strict";

  const state = {
    sw: "combined", // "combined" | "sw1" | "sw2"
    yearRange: "10", // "10" | "5" | "all"
    region: "all", // "all" | a raw region value from summary.json ("Nord" | "Sor" | "Vest" | "Midt")
    institution: "all", // "all" | "nina" | "rb" -- whose images are counted
    sort: "name",
    data: null,
    history: [], // [{date, sw1Required, ..., sw2RbExcess, sw1OperatorNew, sw2OperatorNew, regions}, ...] (see build_summary.py)
    imagingLog: null, // data/imaging_log.json: new images operators imaged per day/region/age class, or null if unavailable
    geo: {}, // watershedId -> {lat, lon}, from data/rivers.json (map positions)
    regionKeys: [], // raw region values in display order; also fixes each region's map colour
    expanded: new Set(), // watershed ids of river rows opened to their year-by-year detail
  };

  const els = {
    updated: document.getElementById("updated"),
    statRequired: document.getElementById("statRequired"),
    statAnalyzed: document.getElementById("statAnalyzed"),
    statPct: document.getElementById("statPct"),
    statExcess: document.getElementById("statExcess"),
    statRivers: document.getElementById("statRivers"),
    tableBody: document.getElementById("riverTableBody"),
    regionTableBody: document.getElementById("regionTableBody"),
    regionTableFoot: document.getElementById("regionTableFoot"),
    swToggle: document.getElementById("swToggle"),
    instToggle: document.getElementById("instToggle"),
    yearToggle: document.getElementById("yearToggle"),
    regionToggle: document.getElementById("regionToggle"),
    riverSort: document.getElementById("riverSort"),
    timelineCaption: document.getElementById("timelineCaption"),
    mapEl: document.getElementById("riverMap"),
    mapLegend: document.getElementById("mapLegend"),
    mountainPanel: document.getElementById("mountainPanel"),
    mountainTitle: document.getElementById("mountainTitle"),
    mountain: document.getElementById("mountain"),
  };

  let yearChart = null;
  let timelineChart = null;
  let map = null;
  let markerLayer = null;

  // summary.json carries every river-year three ways, told apart by an infix in the field
  // name: all institutions combined (no infix, e.g. sw1Required), NINA only (sw1NinaRequired)
  // and RB only (sw1RbRequired). The Institution filter just picks which set of fields to read.
  const INSTITUTION_INFIX = { all: "", nina: "Nina", rb: "Rb" };

  function ageClasses() {
    return state.sw === "combined" ? ["sw1", "sw2"] : [state.sw];
  }

  function swKeys() {
    const infix = INSTITUTION_INFIX[state.institution];
    const keys = (measure) => ageClasses().map((c) => c + infix + measure);
    return { req: keys("Required"), an: keys("Analyzed"), ex: keys("Excess") };
  }

  // Which institutions the river's numbers come from, for the current Age class, Years
  // and Institution selection: "NINA", "RB" or "NINA + RB". A river counts for an
  // institution when that institution has material there (Required > 0 in its own fields).
  function riverInstitutions(river, years) {
    const has = (infix) => years.some((y) => {
      const e = river.byYear[String(y)];
      return !!e && ageClasses().some((c) => e[c + infix + "Required"] > 0);
    });
    const names = [];
    if (state.institution !== "rb" && has("Nina")) names.push("NINA");
    if (state.institution !== "nina" && has("Rb")) names.push("RB");
    return names.join(" + ");
  }

  function selectedYears() {
    const allYears = state.data.years;
    if (state.yearRange === "all") return allYears;
    const n = Number(state.yearRange);
    return allYears.slice(-n);
  }

  function sumFor(byYearEntry, keys) {
    return keys.reduce((s, k) => s + (byYearEntry[k] || 0), 0);
  }

  function riverAggregate(river, years) {
    const { req, an, ex } = swKeys();
    let required = 0;
    let analyzed = 0;
    let excess = 0;
    for (const y of years) {
      const entry = river.byYear[String(y)];
      if (!entry) continue;
      required += sumFor(entry, req);
      analyzed += sumFor(entry, an);
      excess += sumFor(entry, ex);
    }
    return { required, analyzed, excess };
  }

  function fmtPct(analyzed, required) {
    if (!required) return "–";
    return Math.round((analyzed / required) * 100) + "%";
  }

  function inRegion(river) {
    return state.region === "all" || river.region === state.region;
  }

  function render() {
    const years = selectedYears();
    const { req, an, ex } = swKeys();

    let totalRequired = 0;
    let totalAnalyzed = 0;
    let totalExcess = 0;
    const riverRows = [];

    for (const river of state.data.rivers) {
      if (!inRegion(river)) continue;
      const { required, analyzed, excess } = riverAggregate(river, years);
      if (required === 0) continue; // river has no candidates in this range/class
      totalRequired += required;
      totalAnalyzed += analyzed;
      totalExcess += excess;
      riverRows.push({
        id: river.watershedId, name: river.name, region: regionLabel(river.region),
        institution: riverInstitutions(river, years), required, analyzed, excess,
      });
    }

    els.statRequired.textContent = totalRequired.toLocaleString();
    els.statAnalyzed.textContent = totalAnalyzed.toLocaleString();
    els.statPct.textContent = fmtPct(totalAnalyzed, totalRequired);
    els.statExcess.textContent = totalExcess.toLocaleString();
    els.statRivers.textContent = riverRows.length;
    els.updated.textContent = "Data as of " + formatTimestamp(state.data.generatedAt);

    riverRows.sort((a, b) => {
      const pctA = a.required ? a.analyzed / a.required : 0;
      const pctB = b.required ? b.analyzed / b.required : 0;
      switch (state.sort) {
        case "region": return a.region.localeCompare(b.region) || a.name.localeCompare(b.name);
        case "pctAsc": return pctA - pctB;
        case "pctDesc": return pctB - pctA;
        default: return a.name.localeCompare(b.name);
      }
    });

    renderMap(years);
    renderRegionTable(years);
    renderTable(riverRows);
    renderYearChart(years, req, an, ex);
    renderTimeline(an, ex);
  }

  function addDaysIso(dateStr, days) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // New images the operators imaged on `day` (or on every day up to and including it, when
  // `upTo` is set), for the given age classes and region, from the imaging log
  // (data/imaging_log.json: {days: {date: {region: {sw1: n, sw2: n}}}}).
  function operatorImaged(log, day, classes, region, upTo) {
    let n = 0;
    for (const d of Object.keys(log.days)) {
      if (upTo ? d > day : d !== day) continue;
      for (const reg of Object.keys(log.days[d])) {
        if (region !== "all" && reg !== region) continue;
        for (const c of classes) n += log.days[d][reg][c] || 0;
      }
    }
    return n;
  }

  // Turns the daily history log into a daily timeline: one bar per day from the day after
  // the first logged snapshot to the most recent one, each the images added that day.
  //
  // Images that operators imaged are plotted on the day they were imaged (the date in the
  // Operator column, kept in the imaging log), whenever the data was refreshed. Everything
  // else (RB's images, changes to the source workbooks) has no date of its own and is
  // plotted on the day it was first seen: each snapshot's `other` is its imaged total minus
  // the operator images it already contained (stored in the snapshot as *OperatorNew), and
  // the day's bar adds the change in `other` since the previous snapshot. A day with no
  // snapshot (the data wasn't refreshed) carries `other` forward, so it only shows the
  // operator images dated that day. Without an imaging log (or for RB, which has no
  // operator images) this is simply the change in the imaged total between snapshots.
  //
  // The first snapshot is not a bar: it is the `baseline`, everything that was already
  // imaged when tracking began, which would otherwise dwarf the daily progress (the caption
  // reports it instead). baseline + all bars = the latest imaged total. With a region
  // selected, each entry's per-region totals (entry.regions) are used instead of the
  // project-wide ones; an entry without them is skipped, not guessed at.
  function computeDailyTimeline(history, log, { anKeys, exKeys, classes, region, withOperator }) {
    const useLog = !!(withOperator && log && log.days);
    const opKeys = useLog ? classes.map((c) => c + "OperatorNew") : [];
    const otherOn = {};
    for (const entry of history) {
      const totals = region === "all" ? entry : entry.regions && entry.regions[region];
      if (!totals) continue;
      // one entry per day; later ones win
      otherOn[entry.date] = sumFor(totals, anKeys) + sumFor(totals, exKeys) - sumFor(totals, opKeys);
    }
    const dayKeys = Object.keys(otherOn).sort();
    if (!dayKeys.length) return { start: null, baseline: 0, days: [], added: [] };

    const start = dayKeys[0];
    const last = dayKeys[dayKeys.length - 1];
    const days = [];
    const added = [];
    let previous = otherOn[start];
    for (let d = addDaysIso(start, 1); d <= last; d = addDaysIso(d, 1)) {
      const other = Object.prototype.hasOwnProperty.call(otherOn, d) ? otherOn[d] : previous;
      days.push(d);
      added.push((useLog ? operatorImaged(log, d, classes, region, false) : 0) + (other - previous));
      previous = other;
    }
    const baseline = otherOn[start] + (useLog ? operatorImaged(log, start, classes, region, true) : 0);
    return { start, baseline, days, added };
  }

  function timelineCaptionText({ start, baseline, days }) {
    if (!start) return "No history yet — this starts accumulating once the data is refreshed.";
    const already = baseline === 0
      ? "no images were imaged yet"
      : baseline.toLocaleString() + (baseline === 1 ? " image was" : " images were") + " already imaged";
    const began = "Tracking began " + formatDayLabel(start) + ", when " + already;
    return days.length
      ? began + " (not shown). Bars show the images added each day since."
      : began + ". New images will show here day by day.";
  }

  function renderTimeline(anKeys, exKeys) {
    const timeline = computeDailyTimeline(state.history, state.imagingLog, {
      anKeys,
      exKeys,
      classes: ageClasses(),
      region: state.region,
      withOperator: state.institution !== "rb", // operators are NINA: no operator images in the RB view
    });
    const { days, added } = timeline;
    els.timelineCaption.textContent = timelineCaptionText(timeline);

    const style = getComputedStyle(document.documentElement);
    const barColor = style.getPropertyValue("--imaged-color").trim(); // images added are imaged images
    const textColor = style.getPropertyValue("--text-secondary").trim();
    const gridColor = style.getPropertyValue("--gridline").trim();

    const ctx = document.getElementById("timelineChart").getContext("2d");
    const cfg = {
      type: "bar",
      data: {
        labels: days.map(formatDayLabel),
        datasets: [
          { label: "Images added", data: added, backgroundColor: barColor, borderRadius: 3, maxBarThickness: 26 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor } },
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, precision: 0 } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => formatFullDate(days[items[0].dataIndex]),
              label: (item) => {
                const n = item.parsed.y;
                if (n < 0) return Math.abs(n) + " fewer (a correction)";
                return n + " image" + (n === 1 ? "" : "s") + " added";
              },
            },
          },
        },
      },
    };

    if (timelineChart) {
      timelineChart.data = cfg.data;
      timelineChart.options = cfg.options;
      timelineChart.update();
    } else {
      timelineChart = new Chart(ctx, cfg);
    }
  }

  function formatDayLabel(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }

  function formatFullDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  // The source data writes the southern region as "Sor" (no ø); show it spelled properly.
  const REGION_LABELS = { Sor: "Sør" };

  function regionLabel(raw) {
    return REGION_LABELS[raw] || raw || "–";
  }

  // The Required / Imaged / % / Progress / Excess cells, shared by the river
  // and region tables so the two always render the numbers identically.
  function metricCells(r) {
    const pct = r.required ? Math.round((r.analyzed / r.required) * 100) : 0;
    return `<td class="num">${r.required.toLocaleString()}</td>
        <td class="num">${r.analyzed.toLocaleString()}</td>
        <td class="num">${pct}%</td>
        <td class="bar-col">
          <div class="bar-track" role="img" aria-label="${pct}% imaged, ${r.analyzed} of ${r.required}">
            <div class="bar-fill" style="width:${pct}%"></div>
          </div>
        </td>
        <td class="num">${r.excess ? r.excess.toLocaleString() : "–"}</td>`;
  }

  function riverById(id) {
    return state.data.rivers.find((r) => r.watershedId === id);
  }

  // The river's years inside the current Years window, newest first, starting from its
  // first year with candidates. A year after that with no candidates is kept (flagged
  // `empty`) so gaps in the selection are visible; years before the river's first
  // candidates are left out rather than listed as a wall of "none". Follows the Age class
  // filter, so the rows add up to the river's row in the table above.
  function riverYearRows(river, years) {
    const { req, an, ex } = swKeys();
    const hasData = (y) => {
      const e = river.byYear[String(y)];
      return !!e && sumFor(e, req) > 0;
    };
    const first = years.find(hasData);
    if (first === undefined) return [];
    return years
      .filter((y) => y >= first)
      .reverse()
      .map((y) => {
        if (!hasData(y)) return { year: y, empty: true };
        const e = river.byYear[String(y)];
        return { year: y, required: sumFor(e, req), analyzed: sumFor(e, an), excess: sumFor(e, ex) };
      });
  }

  function detailRowHtml(river, years) {
    const body = riverYearRows(river, years).map((r) => (r.empty
      ? `<tr class="no-data"><td>${r.year}</td><td colspan="5">no candidates selected</td></tr>`
      : `<tr><td>${r.year}</td>${metricCells(r)}</tr>`)).join("");
    return `<tr class="detail-row">
      <td colspan="8">
        <div class="year-table-wrap">
          <table class="year-table" aria-label="Year by year for ${escapeHtml(river.name)}">
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col" class="num">Required</th>
                <th scope="col" class="num">Imaged</th>
                <th scope="col" class="num">%</th>
                <th scope="col" class="bar-col">Progress</th>
                <th scope="col" class="num">Excess</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </td>
    </tr>`;
  }

  function riverRowHtml(r, open) {
    return `<tr class="river-row${open ? " is-open" : ""}" data-id="${escapeHtml(r.id)}">
        <td><button type="button" class="row-toggle" aria-expanded="${open}"><span class="chev" aria-hidden="true"></span>${escapeHtml(r.name)}</button></td>
        <td>${escapeHtml(r.region)}</td>
        <td class="inst-cell">${escapeHtml(r.institution)}</td>
        ${metricCells(r)}
      </tr>`;
  }

  function renderTable(rows) {
    if (!rows.length) {
      els.tableBody.innerHTML = '<tr><td colspan="8" class="empty-row">No samples in this range.</td></tr>';
      return;
    }
    const years = selectedYears();
    els.tableBody.innerHTML = rows.map((r) => {
      const open = state.expanded.has(r.id);
      return riverRowHtml(r, open) + (open ? detailRowHtml(riverById(r.id), years) : "");
    }).join("");
  }

  // Clicking a river row (or pressing Enter/Space on its button) opens or closes its
  // year-by-year detail. The open set lives in state, so it survives filter changes, and
  // the detail is added/removed in place so keyboard focus stays on the button.
  function toggleRiverRow(tr) {
    const id = tr.dataset.id;
    const open = !state.expanded.has(id);
    if (open) {
      state.expanded.add(id);
      tr.insertAdjacentHTML("afterend", detailRowHtml(riverById(id), selectedYears()));
    } else {
      state.expanded.delete(id);
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("detail-row")) next.remove();
    }
    tr.classList.toggle("is-open", open);
    tr.querySelector(".row-toggle").setAttribute("aria-expanded", String(open));
  }

  // Subtotals per region (plus an all-regions total) for the current Age class
  // and Years selection. Deliberately ignores the Region filter itself, so the
  // regions stay comparable side by side; the selected one is just highlighted.
  function renderRegionTable(years) {
    const groups = new Map(); // raw region value -> {rivers, required, analyzed, excess}
    const total = { rivers: 0, required: 0, analyzed: 0, excess: 0 };

    for (const river of state.data.rivers) {
      const { required, analyzed, excess } = riverAggregate(river, years);
      if (required === 0) continue; // same rule as the river table
      const key = river.region || "";
      if (!groups.has(key)) groups.set(key, { rivers: 0, required: 0, analyzed: 0, excess: 0 });
      for (const t of [groups.get(key), total]) {
        t.rivers += 1;
        t.required += required;
        t.analyzed += analyzed;
        t.excess += excess;
      }
    }

    if (!groups.size) {
      els.regionTableBody.innerHTML = '<tr><td colspan="7" class="empty-row">No samples in this range.</td></tr>';
      els.regionTableFoot.innerHTML = "";
      return;
    }

    const keys = [...groups.keys()].sort((a, b) => regionLabel(a).localeCompare(regionLabel(b)));
    els.regionTableBody.innerHTML = keys.map((key) => {
      const g = groups.get(key);
      return `<tr class="${key === state.region ? "is-selected" : ""}">
        <td>${escapeHtml(regionLabel(key))}</td>
        <td class="num">${g.rivers}</td>
        ${metricCells(g)}
      </tr>`;
    }).join("");
    els.regionTableFoot.innerHTML = `<tr class="total-row">
        <td>All regions</td>
        <td class="num">${total.rivers}</td>
        ${metricCells(total)}
      </tr>`;
  }

  // Each region keeps its own map colour (defined in CSS), keyed by name rather than by
  // position in the list, so a region appearing or disappearing never repaints the others.
  // A region not listed here falls back to muted grey.
  const REGION_COLOR_VARS = {
    Nord: "--map-region-1",
    Sor: "--map-region-2",
    Vest: "--map-region-3",
    Midt: "--map-region-4",
  };

  function regionColorFor() {
    const style = getComputedStyle(document.documentElement);
    return (raw) => style.getPropertyValue(REGION_COLOR_VARS[raw] || "--text-muted").trim();
  }

  function initMap() {
    // Scroll-wheel zoom stays off so the map doesn't hijack scrolling the page.
    map = L.map(els.mapEl, { scrollWheelZoom: false, zoomSnap: 0.25 }).setView([65, 14], 4);
    L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.kartverket.no/" target="_blank" rel="noopener">Kartverket</a>',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  // One marker per river that has candidates in the current Age class / Years / Region
  // selection (the same rule as the tables): colour = region, size = % of target imaged.
  function renderMap(years) {
    if (typeof L === "undefined") {
      els.mapEl.textContent = "The map couldn't be loaded.";
      return;
    }
    if (!Object.keys(state.geo).length) {
      els.mapEl.textContent = "No river locations available.";
      return;
    }
    if (!map) initMap();
    map.invalidateSize();
    markerLayer.clearLayers();

    const colorFor = regionColorFor();
    const items = [];
    let unplaced = 0; // rivers in the selection with no entry in rivers.json
    for (const river of state.data.rivers) {
      if (!inRegion(river)) continue;
      const pos = state.geo[river.watershedId];
      const { required, analyzed, excess } = riverAggregate(river, years);
      if (required === 0) continue;
      if (!pos) { unplaced += 1; continue; }
      const pct = analyzed / required;
      items.push({
        river, pos, required, analyzed, excess, pct, radius: 6 + Math.round(pct * 12),
        institution: riverInstitutions(river, years),
      });
    }

    // Largest first, so small markers aren't buried under big neighbours.
    items.sort((a, b) => b.radius - a.radius);
    for (const it of items) {
      L.circleMarker([it.pos.lat, it.pos.lon], {
        radius: it.radius,
        color: "#ffffff", // ring: the map is always white
        weight: 2,
        fillColor: colorFor(it.river.region),
        fillOpacity: 0.9,
      })
        .bindPopup(
          `<strong>${escapeHtml(it.river.name)}</strong><br>` +
          `${escapeHtml(regionLabel(it.river.region))} · ${escapeHtml(it.institution)}<br>` +
          `Required ${it.required.toLocaleString()} · Imaged ${it.analyzed.toLocaleString()} ` +
          `(${Math.round(it.pct * 100)}%)<br>` +
          `Excess ${it.excess ? it.excess.toLocaleString() : "–"}`
        )
        .addTo(markerLayer);
    }

    // No animation: Leaflet ignores a new zoom while one is still animating, so two quick
    // filter clicks could otherwise leave the map framed on the wrong rivers.
    if (items.length) {
      map.fitBounds(L.latLngBounds(items.map((it) => [it.pos.lat, it.pos.lon])), { padding: [36, 36], maxZoom: 8, animate: false });
    } else {
      map.setView([65, 14], 4, { animate: false });
    }

    els.mapLegend.innerHTML =
      state.regionKeys
        .map((key) => `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(key)}"></span>${escapeHtml(regionLabel(key))}</span>`)
        .join("") + '<span class="legend-item legend-note">Marker size = % of target imaged</span>' +
      (unplaced
        ? `<span class="legend-item legend-note">${unplaced} river${unplaced === 1 ? "" : "s"} without a known location not shown</span>`
        : "");
  }

  // ---- The climb: one mountain as high as the whole target, a fish at the pictures taken ----

  // The summit is the whole target: every fish needed over the last 10 years (both age classes,
  // NINA and RB together), one metre per picture. The fish's altitude is how many of those have
  // been imaged. It deliberately ignores the filters: it is the overall goal.
  function overallProgress() {
    const years = state.data.years.slice(-10);
    let required = 0;
    let imaged = 0;
    let excess = 0;
    for (const river of state.data.rivers) {
      for (const y of years) {
        const e = river.byYear[String(y)];
        if (!e) continue;
        for (const c of ["sw1", "sw2"]) {
          required += e[c + "Required"];
          imaged += e[c + "Analyzed"];
          excess += e[c + "Excess"];
        }
      }
    }
    return { required, imaged, excess, firstYear: years[0], lastYear: years[years.length - 1] };
  }

  // "skjell" is Norwegian for scale (the fish kind), "fjell" for mountain.
  const MOUNTAIN_NAME = "Skjellfjellet";

  // The mountain's outline as [position across, height as a fraction of the summit], left to right.
  // The left face rises steadily (the fish climbs it); the right has a shoulder.
  const RIDGE = [
    [0, 0], [0.06, 0.05], [0.14, 0.12], [0.22, 0.22], [0.30, 0.33], [0.37, 0.48], [0.43, 0.63],
    [0.48, 0.78], [0.52, 0.90], [0.555, 1], [0.60, 0.90], [0.64, 0.83], [0.69, 0.86], [0.74, 0.70],
    [0.80, 0.52], [0.86, 0.38], [0.92, 0.20], [1, 0],
  ];
  const SUMMIT = 9; // index of the summit in RIDGE
  const SNOW_LINE = 0.8; // height fraction above which the mountain has snow

  // The point on the left face at a given height fraction, and the RIDGE segment it lies on.
  function leftFaceAt(v) {
    for (let i = 0; i < SUMMIT; i++) {
      const a = RIDGE[i];
      const b = RIDGE[i + 1];
      if (v >= a[1] && v <= b[1]) {
        const t = b[1] === a[1] ? 0 : (v - a[1]) / (b[1] - a[1]);
        return { segment: i, point: [a[0] + t * (b[0] - a[0]), v] };
      }
    }
    return { segment: SUMMIT - 1, point: RIDGE[SUMMIT] };
  }

  // Draws the mountain as SVG at the width of its box (so text stays a readable size on a phone).
  // Colours come from CSS classes, so light and dark mode need no redraw.
  function renderMountain() {
    if (!els.mountain || !state.data) return;
    const p = overallProgress();
    els.mountainPanel.hidden = !p.required;
    if (!p.required) return;

    const imaged = Math.min(p.imaged, p.required);
    const pct = Math.round((imaged / p.required) * 100);
    const fmt = (n) => n.toLocaleString();
    els.mountainTitle.textContent = "The climb to " + fmt(p.required) + " m";

    const W = Math.max(280, Math.round(els.mountain.clientWidth || 600));
    const left = 56;
    const right = 12;
    const top = 64; // room above the summit for the flag, the elevation and the name
    const bottom = 32;
    const plotW = W - left - right;
    const plotH = Math.round(Math.min(340, Math.max(210, W * 0.42)));
    const H = top + plotH + bottom;
    const baseY = top + plotH;
    const toPx = ([u, v]) => [left + u * plotW, baseY - v * plotH];
    const pts = RIDGE.map(toPx);
    const poly = (list) => list.map(([x, y]) => x.toFixed(1) + "," + y.toFixed(1)).join(" ");
    const altitudeY = (m) => baseY - (m / p.required) * plotH;

    // Snow cap: the ridge above the snow line, closed by a jagged lower edge.
    const snowLeft = leftFaceAt(SNOW_LINE);
    let j = SUMMIT + 1;
    while (j < RIDGE.length && RIDGE[j][1] >= SNOW_LINE) j++;
    const ra = RIDGE[j - 1];
    const rb = RIDGE[j];
    const tr = (ra[1] - SNOW_LINE) / (ra[1] - rb[1]);
    const snowRight = [ra[0] + tr * (rb[0] - ra[0]), SNOW_LINE];
    const teeth = 6;
    const edge = [];
    for (let k = teeth - 1; k >= 1; k--) {
      edge.push([snowLeft.point[0] + (snowRight[0] - snowLeft.point[0]) * (k / teeth), k % 2 ? SNOW_LINE - 0.075 : SNOW_LINE - 0.015]);
    }
    const snow = [snowLeft.point, ...RIDGE.slice(snowLeft.segment + 1, j), snowRight, ...edge].map(toPx);

    // Altitude gridlines every 1,000 m.
    let grid = "";
    for (let m = 0; m <= p.required; m += 1000) {
      const y = altitudeY(m);
      if (m > 0) grid += `<line class="mtn-grid" x1="${left}" x2="${left + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      grid += `<text class="mtn-axis" x="${left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${fmt(m)} m</text>`;
    }

    // Summit flag.
    const [sx, sy] = pts[SUMMIT];
    const flag =
      `<line class="mtn-flag-pole" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${(sy - 26).toFixed(1)}"/>` +
      `<polygon class="mtn-flag" points="${sx.toFixed(1)},${(sy - 26).toFixed(1)} ${(sx + 16).toFixed(1)},${(sy - 20).toFixed(1)} ${sx.toFixed(1)},${(sy - 14).toFixed(1)}"/>` +
      `<text class="mtn-name" x="${sx.toFixed(1)}" y="${(sy - 51).toFixed(1)}" text-anchor="middle">${MOUNTAIN_NAME}</text>` +
      `<text class="mtn-summit" x="${sx.toFixed(1)}" y="${(sy - 34).toFixed(1)}" text-anchor="middle">${fmt(p.required)} m</text>`;

    // Water at the foot of the mountain.
    let waves = "";
    for (const dy of [9, 17]) {
      const n = Math.ceil(plotW / 24);
      waves += `<path class="mtn-wave" d="M${left},${baseY + dy} q6,-5 12,0${" t12,0".repeat(n * 2 - 1)}"/>`;
    }

    // The fish: on the left face at the altitude of the pictures taken, head up the slope.
    const face = leftFaceAt(imaged / p.required);
    const [fx, fy] = toPx(face.point);
    const [a, b] = [pts[face.segment], pts[face.segment + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const scale = W < 460 ? 1 : 1.35;
    const lift = 12 * scale; // sit on the slope, not in it
    const cx = Math.max(left + 14, fx + (dy / len) * lift);
    const cy = fy - (dx / len) * lift;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const fish =
      `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${angle.toFixed(1)}) scale(${scale})">` +
      `<path class="mtn-fish" d="M22,0 C16,-9 4,-11 -8,-6 L-20,-12 L-16,0 L-20,12 L-8,6 C4,11 16,9 22,0 Z"/>` +
      `<circle class="mtn-fish-eye" cx="13" cy="-2" r="1.9"/></g>`;

    const label = fmt(imaged) + " m · " + pct + "%";
    const tagW = label.length * 6.9 + 16;
    // Above the fish, but below it near the summit (where the flag is), and never over the axis labels.
    const nearTop = imaged / p.required > 0.85;
    const tagX = Math.min(W - tagW / 2 - 4, Math.max(left + tagW / 2 + 2, cx));
    const tagY = nearTop ? cy + 28 * scale + 10 : cy - 24 * scale - 10;
    const tag =
      `<rect class="mtn-tag-box" x="${(tagX - tagW / 2).toFixed(1)}" y="${(tagY - 14).toFixed(1)}" width="${tagW.toFixed(1)}" height="22" rx="6"/>` +
      `<text class="mtn-tag-text" x="${tagX.toFixed(1)}" y="${(tagY + 1).toFixed(1)}" text-anchor="middle">${label}</text>`;

    const climbedY = altitudeY(imaged);
    els.mountain.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
      `aria-label="${MOUNTAIN_NAME}, a mountain ${fmt(p.required)} metres high: one metre for each picture that has to be taken. ` +
      `A fish has climbed ${fmt(imaged)} metres of it, ${pct} percent.">` +
      `<defs><clipPath id="mountainClip"><polygon points="${poly(pts)}"/></clipPath></defs>` +
      `<polygon class="mtn-body" points="${poly(pts)}"/>` +
      `<rect class="mtn-climbed" x="${left}" y="${climbedY.toFixed(1)}" width="${plotW}" height="${(baseY - climbedY).toFixed(1)}" clip-path="url(#mountainClip)"/>` +
      `<polygon class="mtn-snow" points="${poly(snow)}"/>` +
      grid +
      `<line class="mtn-ground" x1="${left}" x2="${left + plotW}" y1="${baseY}" y2="${baseY}"/>` +
      waves + flag + fish + tag + `</svg>`;
  }

  function renderYearChart(years, reqKeys, anKeys, exKeys) {
    const required = [];
    const analyzed = [];
    const excess = [];
    for (const y of years) {
      let reqSum = 0;
      let anSum = 0;
      let exSum = 0;
      for (const river of state.data.rivers) {
        if (!inRegion(river)) continue;
        const entry = river.byYear[String(y)];
        if (!entry) continue;
        reqSum += sumFor(entry, reqKeys);
        anSum += sumFor(entry, anKeys);
        exSum += sumFor(entry, exKeys);
      }
      required.push(reqSum);
      analyzed.push(anSum);
      excess.push(exSum);
    }

    const style = getComputedStyle(document.documentElement);
    const requiredColor = style.getPropertyValue("--required-bar").trim();
    const analyzedColor = style.getPropertyValue("--imaged-color").trim();
    const excessColor = style.getPropertyValue("--excess-color").trim();
    const textColor = style.getPropertyValue("--text-secondary").trim();
    const gridColor = style.getPropertyValue("--gridline").trim();

    const ctx = document.getElementById("yearChart").getContext("2d");
    const cfg = {
      type: "bar",
      data: {
        labels: years.map(String),
        datasets: [
          { label: "Required", data: required, backgroundColor: requiredColor, borderRadius: 3, maxBarThickness: 18 },
          { label: "Imaged", data: analyzed, backgroundColor: analyzedColor, borderRadius: 3, maxBarThickness: 18 },
          { label: "Excess", data: excess, backgroundColor: excessColor, borderRadius: 3, maxBarThickness: 18 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor } },
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, precision: 0 } },
        },
        plugins: {
          legend: { position: "top", align: "end", labels: { color: textColor, boxWidth: 12, usePointStyle: true } },
          tooltip: { mode: "index", intersect: false },
        },
      },
    };

    if (yearChart) {
      yearChart.data = cfg.data;
      yearChart.options = cfg.options;
      yearChart.update();
    } else {
      yearChart = new Chart(ctx, cfg);
    }
  }

  function formatTimestamp(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return iso;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function wireControls() {
    els.swToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sw]");
      if (!btn) return;
      state.sw = btn.dataset.sw;
      setActive(els.swToggle, btn);
      render();
    });
    els.instToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-inst]");
      if (!btn) return;
      state.institution = btn.dataset.inst;
      setActive(els.instToggle, btn);
      render();
    });
    els.yearToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      state.yearRange = btn.dataset.range;
      setActive(els.yearToggle, btn);
      render();
    });
    els.tableBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr.river-row");
      if (tr) toggleRiverRow(tr);
    });
    els.regionToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-region]");
      if (!btn) return;
      state.region = btn.dataset.region;
      setActive(els.regionToggle, btn);
      render();
    });
    els.riverSort.addEventListener("change", () => {
      state.sort = els.riverSort.value;
      render();
    });
  }

  // One button per region present in the data, after the static "All regions" one.
  function buildRegionToggle() {
    const regions = [...new Set(state.data.rivers.map((r) => r.region).filter(Boolean))]
      .sort((a, b) => regionLabel(a).localeCompare(regionLabel(b)));
    state.regionKeys = regions;
    for (const raw of regions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.region = raw;
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = regionLabel(raw);
      els.regionToggle.appendChild(btn);
    }
  }

  function setActive(group, btn) {
    group.querySelectorAll("button").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
  }

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function init() {
    wireControls();
    try {
      state.data = await fetchJson("data/summary.json");

      // History (the daily timeline) is supplementary: don't block the
      // whole dashboard if it's missing or fails to load.
      try {
        state.history = await fetchJson("data/history.json");
      } catch (err) {
        state.history = [];
        console.warn("Could not load data/history.json — timeline will be empty.", err);
      }

      // The imaging log dates the operators' images; without it the timeline falls back to the
      // change between daily snapshots.
      try {
        state.imagingLog = await fetchJson("data/imaging_log.json");
      } catch (err) {
        state.imagingLog = null;
        console.warn("Could not load data/imaging_log.json — operator images will be dated by when the data was refreshed.", err);
      }

      // River positions are likewise supplementary: without them only the map is affected.
      try {
        state.geo = (await fetchJson("data/rivers.json")).rivers || {};
      } catch (err) {
        state.geo = {};
        console.warn("Could not load data/rivers.json — map will be unavailable.", err);
      }

      buildRegionToggle();
      render();
      renderMountain();
      // The mountain is drawn at the width of its box, so redraw when that changes.
      let drawnWidth = els.mountain.clientWidth;
      let resizeTimer = null;
      window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (els.mountain.clientWidth !== drawnWidth) {
            drawnWidth = els.mountain.clientWidth;
            renderMountain();
          }
        }, 150);
      });
    } catch (err) {
      els.updated.textContent = "Failed to load data";
      els.tableBody.innerHTML =
        '<tr><td colspan="8" class="empty-row">Could not load data/summary.json. ' + escapeHtml(String(err)) + "</td></tr>";
      console.error(err);
    }
  }

  init();
})();
