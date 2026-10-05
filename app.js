(function () {
  "use strict";

  const state = {
    sw: "combined", // "combined" | "sw1" | "sw2"
    yearRange: "10", // "10" | "5" | "all"
    region: "all", // "all" | a raw region value from summary.json ("Nord" | "Sor" | "Vest")
    sort: "name",
    data: null,
    history: [], // [{date, sw1Required, sw1Analyzed, sw1Excess, sw2Required, sw2Analyzed, sw2Excess}, ...]
    geo: {}, // watershedId -> {lat, lon}, from data/rivers.json (map positions)
    regionKeys: [], // raw region values in display order; also fixes each region's map colour
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
    yearToggle: document.getElementById("yearToggle"),
    regionToggle: document.getElementById("regionToggle"),
    riverSort: document.getElementById("riverSort"),
    timelineCaption: document.getElementById("timelineCaption"),
    mapEl: document.getElementById("riverMap"),
    mapLegend: document.getElementById("mapLegend"),
  };

  let yearChart = null;
  let timelineChart = null;
  let map = null;
  let markerLayer = null;

  function swKeys() {
    if (state.sw === "sw1") return { req: ["sw1Required"], an: ["sw1Analyzed"], ex: ["sw1Excess"] };
    if (state.sw === "sw2") return { req: ["sw2Required"], an: ["sw2Analyzed"], ex: ["sw2Excess"] };
    return {
      req: ["sw1Required", "sw2Required"],
      an: ["sw1Analyzed", "sw2Analyzed"],
      ex: ["sw1Excess", "sw2Excess"],
    };
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
      riverRows.push({ name: river.name, region: regionLabel(river.region), required, analyzed, excess });
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

  // Monday (UTC) of the week containing dateStr, as "YYYY-MM-DD".
  function weekStart(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diffToMonday);
    return d.toISOString().slice(0, 10);
  }

  function addDaysIso(dateStr, days) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Buckets the daily history log into a continuous weekly timeline: one
  // point per week from the first logged snapshot to the most recent, with
  // gap weeks (no snapshot that week) carrying the prior known total forward
  // (so their own delta reads as 0, not "unknown"). Returns weeks (Monday
  // dates) and added (net new imaged count that week, first week = its own
  // total since tracking effectively starts from zero). With a region
  // selected, each entry's per-region totals (entry.regions) are used instead of
  // the project-wide ones; an entry without them is skipped, not guessed at.
  function computeWeeklyTimeline(history, anKeys, exKeys, region) {
    const byWeek = {};
    for (const entry of history) {
      const totals = region === "all" ? entry : entry.regions && entry.regions[region];
      if (!totals) continue;
      const imaged = sumFor(totals, anKeys) + sumFor(totals, exKeys);
      byWeek[weekStart(entry.date)] = imaged; // later (sorted) entries overwrite earlier ones in the same week
    }
    if (!Object.keys(byWeek).length) return { weeks: [], added: [] };

    const weekKeys = Object.keys(byWeek).sort();
    const firstWeek = weekKeys[0];
    const lastWeek = weekKeys[weekKeys.length - 1];

    const weeks = [];
    const totals = [];
    let running = 0;
    for (let w = firstWeek; w <= lastWeek; w = addDaysIso(w, 7)) {
      if (Object.prototype.hasOwnProperty.call(byWeek, w)) running = byWeek[w];
      weeks.push(w);
      totals.push(running);
    }

    const added = totals.map((t, i) => (i === 0 ? t : t - totals[i - 1]));
    return { weeks, added };
  }

  function renderTimeline(anKeys, exKeys) {
    const { weeks, added } = computeWeeklyTimeline(state.history, anKeys, exKeys, state.region);

    if (!weeks.length) {
      els.timelineCaption.textContent = "No history yet — this starts accumulating once the daily refresh runs.";
    } else if (weeks.length === 1) {
      els.timelineCaption.textContent =
        "Tracking began " + formatWeekLabel(weeks[0]) + " — check back next week to see a trend.";
    } else {
      els.timelineCaption.textContent = "Tracking since " + formatWeekLabel(weeks[0]) + ".";
    }

    const style = getComputedStyle(document.documentElement);
    const barColor = style.getPropertyValue("--excess-color").trim();
    const textColor = style.getPropertyValue("--text-secondary").trim();
    const gridColor = style.getPropertyValue("--gridline").trim();

    const ctx = document.getElementById("timelineChart").getContext("2d");
    const cfg = {
      type: "bar",
      data: {
        labels: weeks.map(formatWeekLabel),
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
              title: (items) => "Week of " + items[0].label,
              label: (item) => item.parsed.y + " image" + (item.parsed.y === 1 ? "" : "s") + " added",
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

  function formatWeekLabel(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
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

  function renderTable(rows) {
    if (!rows.length) {
      els.tableBody.innerHTML = '<tr><td colspan="7" class="empty-row">No samples in this range.</td></tr>';
      return;
    }
    els.tableBody.innerHTML = rows.map((r) => `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.region)}</td>
        ${metricCells(r)}
      </tr>`).join("");
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

  // Region colours come from CSS (one categorical slot per region, in display order)
  // so light/dark stay defined in one place; a region past the defined slots falls
  // back to muted grey.
  const REGION_COLOR_VARS = ["--region-1", "--region-2", "--region-3"];

  function regionColorFor() {
    const style = getComputedStyle(document.documentElement);
    return (raw) => {
      const i = state.regionKeys.indexOf(raw);
      const cssVar = i >= 0 && i < REGION_COLOR_VARS.length ? REGION_COLOR_VARS[i] : "--text-muted";
      return style.getPropertyValue(cssVar).trim();
    };
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
    const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface-1").trim();
    const items = [];
    let unplaced = 0; // rivers in the selection with no entry in rivers.json
    for (const river of state.data.rivers) {
      if (!inRegion(river)) continue;
      const pos = state.geo[river.watershedId];
      const { required, analyzed, excess } = riverAggregate(river, years);
      if (required === 0) continue;
      if (!pos) { unplaced += 1; continue; }
      const pct = analyzed / required;
      items.push({ river, pos, required, analyzed, excess, pct, radius: 6 + Math.round(pct * 12) });
    }

    // Largest first, so small markers aren't buried under big neighbours.
    items.sort((a, b) => b.radius - a.radius);
    for (const it of items) {
      L.circleMarker([it.pos.lat, it.pos.lon], {
        radius: it.radius,
        color: surface,
        weight: 2,
        fillColor: colorFor(it.river.region),
        fillOpacity: 0.9,
      })
        .bindPopup(
          `<strong>${escapeHtml(it.river.name)}</strong><br>` +
          `${escapeHtml(regionLabel(it.river.region))}<br>` +
          `Required ${it.required.toLocaleString()} · Imaged ${it.analyzed.toLocaleString()} ` +
          `(${Math.round(it.pct * 100)}%)<br>` +
          `Excess ${it.excess ? it.excess.toLocaleString() : "–"}`
        )
        .addTo(markerLayer);
    }

    if (items.length) {
      map.fitBounds(L.latLngBounds(items.map((it) => [it.pos.lat, it.pos.lon])), { padding: [36, 36], maxZoom: 8 });
    } else {
      map.setView([65, 14], 4);
    }

    els.mapLegend.innerHTML =
      state.regionKeys
        .map((key) => `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(key)}"></span>${escapeHtml(regionLabel(key))}</span>`)
        .join("") + '<span class="legend-item legend-note">Marker size = % of target imaged</span>' +
      (unplaced
        ? `<span class="legend-item legend-note">${unplaced} river${unplaced === 1 ? "" : "s"} without a known location not shown</span>`
        : "");
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
    const analyzedColor = style.getPropertyValue("--fill-good").trim();
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
    els.yearToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      state.yearRange = btn.dataset.range;
      setActive(els.yearToggle, btn);
      render();
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

      // History (the weekly timeline) is supplementary: don't block the
      // whole dashboard if it's missing or fails to load.
      try {
        state.history = await fetchJson("data/history.json");
      } catch (err) {
        state.history = [];
        console.warn("Could not load data/history.json — timeline will be empty.", err);
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
    } catch (err) {
      els.updated.textContent = "Failed to load data";
      els.tableBody.innerHTML =
        '<tr><td colspan="7" class="empty-row">Could not load data/summary.json. ' + escapeHtml(String(err)) + "</td></tr>";
      console.error(err);
    }
  }

  init();
})();
