(function () {
  "use strict";

  const state = {
    sw: "combined", // "combined" | "sw1" | "sw2"
    yearRange: "10", // "10" | "5" | "all"
    sort: "name",
    data: null,
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
  };

  let yearChart = null;

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

  async function init() {
    wireControls();
    try {
      const res = await fetch("data/summary.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.data = await res.json();
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
