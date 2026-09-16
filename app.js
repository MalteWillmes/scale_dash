(function () {
  "use strict";

  const state = {
    sw: "combined", // "combined" | "sw1" | "sw2"
    yearRange: "10", // "10" | "5" | "all"
    sort: "name",
    data: null,
    history: [], // [{date, sw1Required, sw1Analyzed, sw1Excess, sw2Required, sw2Analyzed, sw2Excess}, ...]
  };

  const els = {
    updated: document.getElementById("updated"),
    statRequired: document.getElementById("statRequired"),
    statAnalyzed: document.getElementById("statAnalyzed"),
    statPct: document.getElementById("statPct"),
    statExcess: document.getElementById("statExcess"),
    statRivers: document.getElementById("statRivers"),
    tableBody: document.getElementById("riverTableBody"),
    swToggle: document.getElementById("swToggle"),
    yearToggle: document.getElementById("yearToggle"),
    riverSort: document.getElementById("riverSort"),
    timelineCaption: document.getElementById("timelineCaption"),
  };

  let yearChart = null;
  let timelineChart = null;

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

  function render() {
    const years = selectedYears();
    const { req, an, ex } = swKeys();

    let totalRequired = 0;
    let totalAnalyzed = 0;
    let totalExcess = 0;
    const riverRows = [];

    for (const river of state.data.rivers) {
      const { required, analyzed, excess } = riverAggregate(river, years);
      if (required === 0) continue; // river has no candidates in this range/class
      totalRequired += required;
      totalAnalyzed += analyzed;
      totalExcess += excess;
      riverRows.push({ name: river.name, required, analyzed, excess });
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
        case "pctAsc": return pctA - pctB;
        case "pctDesc": return pctB - pctA;
        default: return a.name.localeCompare(b.name);
      }
    });

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
  // total since tracking effectively starts from zero).
  function computeWeeklyTimeline(history, anKeys, exKeys) {
    if (!history.length) return { weeks: [], added: [] };

    const byWeek = {};
    for (const entry of history) {
      const imaged = sumFor(entry, anKeys) + sumFor(entry, exKeys);
      byWeek[weekStart(entry.date)] = imaged; // later (sorted) entries overwrite earlier ones in the same week
    }

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
    const { weeks, added } = computeWeeklyTimeline(state.history, anKeys, exKeys);

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

  function renderTable(rows) {
    if (!rows.length) {
      els.tableBody.innerHTML = '<tr><td colspan="6" class="empty-row">No samples in this range.</td></tr>';
      return;
    }
    els.tableBody.innerHTML = rows.map((r) => {
      const pct = r.required ? Math.round((r.analyzed / r.required) * 100) : 0;
      return `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${r.required.toLocaleString()}</td>
        <td class="num">${r.analyzed.toLocaleString()}</td>
        <td class="num">${pct}%</td>
        <td class="bar-col">
          <div class="bar-track" role="img" aria-label="${pct}% imaged, ${r.analyzed} of ${r.required}">
            <div class="bar-fill" style="width:${pct}%"></div>
          </div>
        </td>
        <td class="num">${r.excess ? r.excess.toLocaleString() : "–"}</td>
      </tr>`;
    }).join("");
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
    els.riverSort.addEventListener("change", () => {
      state.sort = els.riverSort.value;
      render();
    });
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

      render();
    } catch (err) {
      els.updated.textContent = "Failed to load data";
      els.tableBody.innerHTML =
        '<tr><td colspan="6" class="empty-row">Could not load data/summary.json. ' + escapeHtml(String(err)) + "</td></tr>";
      console.error(err);
    }
  }

  init();
})();
