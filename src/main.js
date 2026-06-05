import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { validate, SCHEMA, OPS, EXAMPLE } from "./schema.js";
import { BUILTIN_THEMES, TOKENS, TOKEN_NAMES, DEFAULT_THEME_ID, validateTheme } from "./themes.js";

(function () {
"use strict";

// ─── Default Data ────────────────────────────────────────────────
const DEFAULT_DATA = {
  title: "Example Project Plan",
  note: "A sample plan — workstreams scheduled across shared compute. This is demo data; edit it or paste your own JSON.",
  clusters: [
    { label: "Cluster A online", date: "2026-02-01", color: "#5f7488" },
    { label: "Cluster B online", date: "2026-04-01", color: "#5f7488" },
    { label: "GPU expansion",    date: "2026-06-01", color: "#8a6a44" }
  ],
  // Capacity windows (name matches each task's `cluster`). Rendered below the
  // workstreams as utilization lanes: grey where idle, colored where in use.
  capacity: [
    { name: "Cluster A", chip: "H100", chips: 128, from: "2026-02-01", color: "#5f7488" },
    { name: "Cluster B", chip: "H100", chips: 256, from: "2026-04-01", color: "#5f7488", grows: [{ date: "2026-06-01", to: 512 }] },
    { name: "TPU pool",  chip: "v5p",  chips: 256, from: "2026-01-15", to: "2026-05-01", color: "#4f8a72", note: "returned May 1" }
  ],
  workstreams: [
    {
      name: "Build",
      note: "Core build-out",
      tasks: [
        { name: "Foundations", start: ["date", "2026-02-03"], end: ["weeks", 3], significance: 3, cluster: "Cluster A", tooltip: "**Foundations**\n\nInitial setup on Cluster A." },
        { name: "Service v1",  start: ["after", "Foundations", ["days", 3]], end: ["weeks", 6], significance: 4, cluster: "Cluster B", deps: ["Foundations"], tooltip: "**Service v1**\n\nFirst end-to-end service, on Cluster B." },
        { name: "Scale-up",    start: ["date", "2026-06-05"], end: ["weeks", 5], significance: 6, cluster: "Cluster B", deps: ["Service v1"], tooltip: "**Scale-up**\n\nScale on the expanded Cluster B." }
      ],
      milestones: [
        { name: "Kickoff", date: "2026-02-01", tooltip: "**Kickoff**\n\nProject start." },
        { name: "Launch",  date: "2026-07-20", emoji: "🚀", line: "#c0392b", deps: ["Scale-up"], tooltip: "**Launch** 🚀\n\nPublic release." }
      ]
    },
    {
      name: "Quality",
      note: "Eval & hardening",
      tasks: [
        { name: "Eval harness", start: "Service v1", end: ["weeks", 2], significance: 2, cluster: "Cluster A", deps: ["Service v1"], tooltip: "**Eval harness**\n\nEnd-to-end evaluation." },
        { name: "Hardening",    start: ["after", "Eval harness", ["days", 2]], end: ["weeks", 4], significance: 3, cluster: "Cluster A", deps: ["Eval harness"], tooltip: "**Hardening**\n\nReliability work." }
      ],
      milestones: [
        { name: "Quality gate", date: "2026-07-01", emoji: "✅", deps: ["Hardening"], tooltip: "**Quality gate**\n\nRelease bar met." }
      ]
    },
    {
      name: "Data",
      note: "Data preparation",
      tasks: [
        { name: "Data prep", start: ["date", "2026-01-20"], end: ["months", 2], significance: 3, cluster: "TPU pool", tooltip: "**Data prep**\n\nData mixture preparation on the TPU pool." }
      ]
    }
  ]
};

// ─── Palette (theme-driven) ──────────────────────────────────────
// Reassigned by applyThemeColors() from the active theme's tokens; the SVG render
// reads them on every (re)render. Defaults below == the Tufte theme so first paint
// is correct before a theme applies. Plan-DATA colors (cluster.color, capacity.color,
// milestone.line) are NOT themed — they come from the plan JSON.
let WORKSTREAM_COLORS = ["#b8c4cc", "#c4bab0", "#a8b8a0", "#c0b0c4", "#b0c0c4"];
let BACKGROUND = "#fffff8";
let TODAY_COLOR = "#c0392b";
let DRAG_HL = "#2b6cb0";   // outline/labels for the item(s) being dragged
let TEXT = "#111111";      // primary text / titles / milestone diamonds
let HEADING = "#333333";   // section + workstream headings
let LABEL = "#444444";     // task/milestone labels
let FAINT = "#999999";     // de-emphasized italic notes
let RULE = "#555555";      // cluster/marker reference lines
let DANGER = "#c0392b";    // violations / capacity over-subscription
let HIST_LINE = "#d6d2c6"; // history-tree edges

// Compute-capacity scaling: lane height ∝ pool FLOPs (chips × per-chip FLOPs),
// the largest pool capped at CAP_PX. Per-chip peak BF16 FLOP/s cached from
// `floppy accels`.
const CAP_PX = 20;
const FLOPS_PER_CHIP = { H100: 9.9e14, H200: 1.98e15, B200: 2.5e15, A100: 3.12e14, v4p: 2.75e14, v5e: 1.97e14, v5p: 4.59e14, v6e: 9.18e14 };
function chipType(cl) {
  if (cl.chip) return cl.chip;
  const n = (cl.name || "").toUpperCase();          // fall back to inferring from the name
  if (n.includes("B200")) return "B200";
  if (n.includes("H200")) return "H200";
  if (n.includes("H100")) return "H100";
  if (n.includes("A100")) return "A100";
  if (n.includes("V4")) return "v4p";
  if (n.includes("V5P")) return "v5p";
  if (n.includes("V5E")) return "v5e";
  if (n.includes("V6E")) return "v6e";
  return null;
}
function chipFlops(cl) { return FLOPS_PER_CHIP[chipType(cl)] || 0; }
function capCluster(data, name) { return (data.capacity || []).find(c => c.name === name) || null; }
function capChipsAt(cl, date) {
  let chips = cl.chips || 0, best = -Infinity;       // latest growth on/before `date` wins
  if (Array.isArray(cl.grows)) for (const g of cl.grows) {
    const gd = +parseDate(g.date);
    if (gd <= +date && gd > best) { best = gd; chips = g.to; }
  }
  return chips;
}
function capMaxChips(cl) {
  let m = cl.chips || 0;
  if (Array.isArray(cl.grows)) for (const g of cl.grows) m = Math.max(m, g.to);
  return m;
}
function poolFlops(cl) { return capMaxChips(cl) * chipFlops(cl); }       // peak FLOP/s at full size
function flopsAt(cl, date) { return capChipsAt(cl, date) * chipFlops(cl); }
let GRID_COLOR = "#ccc";
let MUTED_TEXT = "#888";
let DEP_COLOR = "#97a0ac"; // dependency arrows (muted slate; red when a dep is violated)

// ─── Span Resolution ────────────────────────────────────────────
// validate() now lives in ./schema.js (imported above) so the runtime contract,
// describe()/`/schema`, and the test all share one source of truth.

function parseDate(s) {
  const d = new Date(s + "T00:00:00");
  if (isNaN(d)) throw new Error(`Invalid date: '${s}'`);
  return d;
}

function addDuration(start, spec) {
  const d = new Date(start);
  const [unit, n] = spec;
  if (unit === "days") d.setDate(d.getDate() + n);
  else if (unit === "weeks") d.setDate(d.getDate() + n * 7);
  else if (unit === "months") d.setMonth(d.getMonth() + n);
  else if (unit === "date") return parseDate(n);
  else throw new Error(`Unknown duration unit: '${unit}'`);
  return d;
}

function resolveSpans(data) {
  const taskMap = {};
  for (const ws of data.workstreams)
    for (const t of ws.tasks) taskMap[t.name] = t;

  const resolved = new Set();
  const resolving = new Set();

  function resolve(name) {
    if (resolved.has(name)) return;
    if (resolving.has(name)) throw new Error(`Circular dependency involving '${name}'`);
    resolving.add(name);
    const t = taskMap[name];
    if (!t) throw new Error(`Unknown task reference: '${name}'`);

    // Resolve start
    if (typeof t.start === "string") {
      resolve(t.start);
      t._start = new Date(taskMap[t.start]._end);
    } else if (Array.isArray(t.start) && t.start[0] === "date") {
      t._start = parseDate(t.start[1]);
    } else if (Array.isArray(t.start) && t.start[0] === "after") {
      // ["after", taskName, ["days", n]] — predecessor's end plus a lag
      const pred = t.start[1];
      if (!taskMap[pred]) throw new Error(`Task '${name}': unknown predecessor '${pred}'`);
      resolve(pred);
      t._start = addDuration(taskMap[pred]._end, t.start[2] || ["days", 0]);
    } else {
      throw new Error(`Task '${name}': invalid start spec`);
    }

    // Resolve end
    if (Array.isArray(t.end)) {
      t._end = addDuration(t._start, t.end);
    } else {
      throw new Error(`Task '${name}': invalid end spec`);
    }

    resolving.delete(name);
    resolved.add(name);
  }

  for (const name of Object.keys(taskMap)) resolve(name);
}

// ─── Layout ──────────────────────────────────────────────────────
function computeLayout(data, containerWidth) {
  const PAD_LEFT = 12;
  const PAD_RIGHT = 24;
  const TITLE_HEIGHT = data.title ? 44 : 0;
  const NOTE_HEIGHT = data.note ? 20 : 0;
  const AXIS_HEIGHT = 28;
  const WS_HEADER_HEIGHT = 28;
  const WS_NOTE_HEIGHT = 16;
  const TASK_ROW_HEIGHT = 24;
  const MILESTONE_ROW_HEIGHT = 22;
  const WS_GAP = 18;
  const SIGNIFICANCE_PX = 3; // bar thickness per significance unit (absolute, not relative)

  // Predecessor lookup (by name) so we can draw the lag gap back to a task's parent.
  const taskByName = {};
  for (const ws of data.workstreams) for (const t of ws.tasks) taskByName[t.name] = t;

  // Find time range
  let minDate = Infinity, maxDate = -Infinity;
  for (const ws of data.workstreams) {
    if (hiddenWs.has(ws.name)) continue; // hidden workstreams don't drive the time range
    for (const t of ws.tasks) {
      if (t._start < minDate) minDate = +t._start;
      if (t._end > maxDate) maxDate = +t._end;
    }
    if (ws.milestones) {
      for (const m of ws.milestones) {
        const md = parseDate(m.date);
        if (+md < minDate) minDate = +md;
        if (+md > maxDate) maxDate = +md;
      }
    }
  }

  // Empty plan (no tasks/milestones): show a blank ~3-month canvas from today
  // rather than letting Infinity dates poison every coordinate.
  if (!isFinite(minDate) || !isFinite(maxDate)) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    minDate = +today;
    maxDate = +addDuration(today, ["months", 3]);
  }

  // Pad time range by ~5% on each side
  const range = maxDate - minDate;
  const pad = range * 0.05;
  minDate = new Date(minDate - pad);
  maxDate = new Date(maxDate + pad);

  const chartLeft = PAD_LEFT;
  const chartRight = containerWidth - PAD_RIGHT;
  const chartWidth = chartRight - chartLeft;

  function timeToX(d) {
    return chartLeft + ((+d - +minDate) / (+maxDate - +minDate)) * chartWidth;
  }

  // Compute y positions
  let y = TITLE_HEIGHT + NOTE_HEIGHT + 8 + AXIS_HEIGHT;
  const wsLayouts = [];
  for (let wi = 0; wi < data.workstreams.length; wi++) {
    const ws = data.workstreams[wi];
    if (hiddenWs.has(ws.name)) continue; // skip hidden rows; wi stays aligned with model.workstreams
    const wsY = y;
    y += WS_HEADER_HEIGHT;
    if (ws.note) y += WS_NOTE_HEIGHT;

    const taskLayouts = [];
    for (let ti = 0; ti < ws.tasks.length; ti++) {
      const t = ws.tasks[ti];
      // Absolute thickness: significance × fixed px (consistent across all
      // workstreams), clamped to the row height so bars never overlap.
      const barH = t.significance != null
        ? Math.min(t.significance * SIGNIFICANCE_PX, TASK_ROW_HEIGHT)
        : 1;
      // Lag: thin lead-in line from the predecessor's end up to this task's start.
      const parent = startParent(t), pt = parent && taskByName[parent];
      const lagX = (pt && pt._end < t._start) ? Math.max(chartLeft, timeToX(pt._end)) : null;
      taskLayouts.push({
        name: t.name,
        tooltip: t.tooltip || null,
        cluster: t.cluster || null,
        link: t.link || null,
        barH: barH,
        x1: timeToX(t._start),
        x2: timeToX(t._end),
        lagX,
        y: y + TASK_ROW_HEIGHT / 2,
        rowY: y,
        wsIndex: wi, taskIndex: ti,
        startDate: t._start, endDate: t._end
      });
      y += TASK_ROW_HEIGHT;
    }
    // Milestones — packed onto shared rows (lanes) for a dense display: each one
    // stays on a lane unless its marker+label would overlap the previous on that
    // lane, in which case it bumps down to the next free lane.
    const milestoneLayouts = [];
    if (ws.milestones && ws.milestones.length) {
      const MS_LABEL_PX = 11, MS_GAP = 12;
      const items = ws.milestones.map((m, mi) => {
        const date = parseDate(m.date);
        const x = timeToX(date);
        return {
          name: m.name, tooltip: m.tooltip || null, emoji: m.emoji || null,
          line: m.line || null, x, date, mi,
          leftX: x - 8,                                   // marker extends left
          rightX: x + 12 + measureText(m.name, MS_LABEL_PX) // label extends right
        };
      });
      items.sort((a, b) => a.leftX - b.leftX);
      const laneEnd = []; // rightmost occupied x per lane
      for (const it of items) {
        let lane = 0;
        while (lane < laneEnd.length && it.leftX <= laneEnd[lane] + MS_GAP) lane++;
        laneEnd[lane] = it.rightX;
        it.lane = lane;
      }
      for (const it of items) {
        milestoneLayouts.push({
          name: it.name, tooltip: it.tooltip, emoji: it.emoji, line: it.line,
          x: it.x, date: it.date, wsIndex: wi, msIndex: it.mi,
          y: y + it.lane * MILESTONE_ROW_HEIGHT + MILESTONE_ROW_HEIGHT / 2,
          rowY: y + it.lane * MILESTONE_ROW_HEIGHT
        });
      }
      y += laneEnd.length * MILESTONE_ROW_HEIGHT;
    }
    wsLayouts.push({
      name: ws.name, note: ws.note, y: wsY,
      color: WORKSTREAM_COLORS[wi % WORKSTREAM_COLORS.length],
      tasks: taskLayouts, milestones: milestoneLayouts
    });
    y += WS_GAP;
  }

  // Capacity / utilization section — one lane per cluster, below the workstreams.
  // Lane height encodes the pool size (chips, capped); grey = total capacity,
  // colour = chips in use by activities at each moment.
  let capacityLayout = null;
  if (showCapacity && Array.isArray(data.capacity) && data.capacity.length) {
    const capY = y;
    y += WS_HEADER_HEIGHT + WS_NOTE_HEIGHT;
    const clampX = (ms) => Math.max(chartLeft, Math.min(timeToX(new Date(ms)), chartRight));

    // chips in use on a cluster at a given moment (a task with no `chips` uses
    // the whole pool); clamped to capacity for height purposes
    function usedAtTime(clName, date) {
      let sum = 0;
      const cl = capCluster(data, clName);
      for (const ws of data.workstreams)
        for (const t of ws.tasks)
          if (t.cluster === clName && t._start <= date && date < t._end)
            sum += (t.chips != null ? t.chips : capChipsAt(cl, date));
      return sum;
    }

    // FLOPs height scale: log10, so small pools stay visible. Smallest pool maps
    // to CAP_MIN_PX, largest to CAP_PX, interpolated in log space.
    const CAP_MIN_PX = 6;
    const flopsList = data.capacity.map(poolFlops).filter(f => f > 0);
    const logMax = flopsList.length ? Math.log10(Math.max(...flopsList)) : 0;
    const logMin = flopsList.length ? Math.log10(Math.min(...flopsList)) : 0;
    const flopsThickness = (flops) => {
      if (flops <= 0) return 0;
      if (logMax <= logMin) return CAP_PX;
      const t = Math.max(0, Math.min(1, (Math.log10(flops) - logMin) / (logMax - logMin)));
      return CAP_MIN_PX + (CAP_PX - CAP_MIN_PX) * t;
    };

    const rows = [];
    for (const cl of data.capacity) {
      const from = +parseDate(cl.from), to = cl.to ? +parseDate(cl.to) : +maxDate;
      const maxThick = flopsThickness(poolFlops(cl));
      const slotH = Math.max(maxThick, 14) + 12;
      const centerY = y + slotH / 2;

      // Extend the drawn window to cover any usage outside [from, to] — e.g. an
      // activity scheduled before the cluster comes online — so over-use shows there.
      let winStart = from, winEnd = to;
      for (const ws of data.workstreams)
        for (const t of ws.tasks)
          if (t.cluster === cl.name) { winStart = Math.min(winStart, +t._start); winEnd = Math.max(winEnd, +t._end); }
      winStart = Math.max(winStart, +minDate); winEnd = Math.min(winEnd, +maxDate);

      // Breakpoints: window ends, online window ends, growth events, task starts/ends
      const bps = new Set([winStart, winEnd, from, to]);
      if (cl.grows) for (const g of cl.grows) { const gd = +parseDate(g.date); if (gd > winStart && gd < winEnd) bps.add(gd); }
      for (const ws of data.workstreams)
        for (const t of ws.tasks)
          if (t.cluster === cl.name) {
            const s = Math.max(+t._start, winStart), e = Math.min(+t._end, winEnd);
            if (e > s) { bps.add(s); bps.add(e); }
          }
      const pts = [...bps].filter(p => p >= winStart && p <= winEnd).sort((a, b) => a - b);

      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], mid = new Date((a + b) / 2);
        const online = +mid >= from && +mid < to;
        const avail = online ? capChipsAt(cl, mid) : 0; // 0 chips before online / after lost
        const used = usedAtTime(cl.name, mid);
        let ghostH = 0, solidH = 0, redH = 0;
        if (avail > 0) {
          const H = flopsThickness(avail * chipFlops(cl)), u = used / avail;
          ghostH = H;
          solidH = Math.max(0, 1 - Math.min(u, 1)) * H;  // free capacity (shrinks with use)
          redH = Math.max(0, Math.min(u - 1, 1)) * H;    // over-subscription
        } else if (used > 0) {
          redH = flopsThickness(poolFlops(cl));          // using an offline cluster → full over-use
        }
        segs.push({ x1: clampX(a), x2: clampX(b), ghostH, solidH, redH });
      }
      rows.push({
        name: cl.name, color: cl.color || "#888", note: cl.note || null,
        centerY, segs, slotH, lostX: cl.to ? clampX(+parseDate(cl.to)) : null
      });
      y += slotH;
    }
    capacityLayout = { y: capY, rows };
    y += WS_GAP;
  }

  // Month grid
  const months = [];
  const cursor = new Date(minDate);
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() + 1);
  while (cursor <= maxDate) {
    months.push({ date: new Date(cursor), x: timeToX(cursor) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Thin labels if timeline > 18 months
  const thinLabels = months.length > 18;

  return {
    svgWidth: containerWidth,
    svgHeight: y + 20,
    titleY: 32,
    noteY: TITLE_HEIGHT + 14,
    axisY: TITLE_HEIGHT + NOTE_HEIGHT + 8,
    chartLeft, chartRight,
    minDate, maxDate,
    timeToX, months, thinLabels,
    workstreams: wsLayouts,
    capacity: capacityLayout
  };
}

// ─── SVG Rendering ───────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

// Text measurement via offscreen canvas
const _measureCtx = document.createElement("canvas").getContext("2d");
function measureText(str, fontSize) {
  _measureCtx.font = fontSize + 'px "ET Book", Palatino, Georgia, serif';
  return _measureCtx.measureText(str).width;
}

// Word-wrap into lines that fit maxWidth; never splits a word
function wrapText(str, fontSize, maxWidth) {
  const words = str.split(/\s+/);
  if (words.length === 0) return [str];
  const lines = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = cur + " " + words[i];
    if (measureText(test, fontSize) <= maxWidth) {
      cur = test;
    } else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

// ─── Tooltip ─────────────────────────────────────────────────────
const tooltipEl = document.getElementById("tooltip");
let tooltipVisible = false;

function showTooltip(md, evt) {
  tooltipEl.innerHTML = marked.parse(md);
  tooltipEl.classList.add("visible");
  tooltipVisible = true;
  positionTooltip(evt);
}

function positionTooltip(evt) {
  const pad = 12;
  const x = evt.clientX + pad;
  const y = evt.clientY + pad;
  const r = tooltipEl.getBoundingClientRect();
  const overRight = x + r.width > window.innerWidth - pad;
  const overBottom = y + r.height > window.innerHeight - pad;
  tooltipEl.style.left = (overRight ? evt.clientX - r.width - pad : x) + "px";
  tooltipEl.style.top = (overBottom ? evt.clientY - r.height - pad : y) + "px";
}

function hideTooltip() {
  tooltipEl.classList.remove("visible");
  tooltipVisible = false;
}

function addTooltipTarget(parent, hitRect, md, link) {
  const hit = el("rect", Object.assign({}, hitRect, {
    fill: "transparent", stroke: "none", cursor: link ? "pointer" : "default"
  }));
  if (md) {
    hit.addEventListener("mouseenter", function (e) { showTooltip(md, e); });
    hit.addEventListener("mousemove", function (e) { if (tooltipVisible) positionTooltip(e); });
    hit.addEventListener("mouseleave", hideTooltip);
  }
  if (link) hit.addEventListener("click", function () { window.open(link, "_blank", "noopener"); });
  parent.appendChild(hit);
}

function renderSVG(data, layout) {
  const svg = el("svg", {
    width: layout.svgWidth, height: layout.svgHeight,
    xmlns: SVG_NS, style: `background:${BACKGROUND}`
  });

  // Title
  if (data.title) {
    svg.appendChild(el("text", {
      x: layout.chartLeft, y: layout.titleY,
      "font-family": '"ET Book", Palatino, Georgia, serif',
      "font-size": "22", fill: TEXT, "font-weight": "normal"
    }, data.title));
  }

  // Note
  if (data.note) {
    svg.appendChild(el("text", {
      x: layout.chartLeft, y: layout.noteY,
      "font-family": '"ET Book", Palatino, Georgia, serif',
      "font-size": "13", fill: MUTED_TEXT, "font-style": "italic"
    }, data.note));
  }

  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Month gridlines + labels
  for (let i = 0; i < layout.months.length; i++) {
    const m = layout.months[i];
    // Gridline
    svg.appendChild(el("line", {
      x1: m.x, y1: layout.axisY + 20, x2: m.x, y2: layout.svgHeight - 20,
      stroke: GRID_COLOR, "stroke-width": "0.5", "stroke-dasharray": "2,3",
      opacity: "0.5"
    }));
    // Label (thin if needed: show only Jan/Apr/Jul/Oct)
    const mo = m.date.getMonth();
    if (!layout.thinLabels || mo % 3 === 0) {
      const label = MONTH_NAMES[mo] + (mo === 0 ? " " + m.date.getFullYear() : "");
      svg.appendChild(el("text", {
        x: m.x, y: layout.axisY + 14,
        "font-family": '"ET Book", Palatino, Georgia, serif',
        "font-size": "11", fill: MUTED_TEXT, "text-anchor": "middle"
      }, label));
    }
  }

  // Starting (partial) month — its gridline falls before the left bound, so it
  // wouldn't otherwise be labeled. Anchor it at the left edge.
  if (!layout.thinLabels) {
    const sMo = layout.minDate.getMonth();
    svg.appendChild(el("text", {
      x: layout.chartLeft, y: layout.axisY + 14,
      "font-family": '"ET Book", Palatino, Georgia, serif',
      "font-size": "11", fill: MUTED_TEXT, "text-anchor": "start"
    }, MONTH_NAMES[sMo] + (sMo === 0 ? " " + layout.minDate.getFullYear() : "")));
  }

  // Cluster drop markers — labels only (no full-height line); the month grid
  // provides the only vertical structure. Each drop reads as a colored ↓ label.
  if (Array.isArray(data.clusters)) {
    for (const c of data.clusters) {
      const cd = parseDate(c.date);
      if (cd < layout.minDate || cd > layout.maxDate) continue;
      const cx = layout.timeToX(cd);
      const col = c.color || "#7a8a6a";
      const labelStr = "↓ " + c.label;
      // Left-align at the drop date (the cluster's online edge); flip to right-anchor
      // only if it would spill off the right edge
      const w = measureText(labelStr, 10);
      const edge = 3;
      let lx = cx, anchor = "start";
      if (cx + w > layout.svgWidth - edge) { lx = layout.svgWidth - edge; anchor = "end"; }
      svg.appendChild(el("text", {
        x: lx, y: layout.svgHeight - 8,
        "font-family": '"ET Book", Palatino, Georgia, serif',
        "font-size": "10", fill: col, "text-anchor": anchor
      }, labelStr));
    }
  }

  // Today line
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (showTodayLine && today >= layout.minDate && today <= layout.maxDate) {
    const tx = layout.timeToX(today);
    svg.appendChild(el("line", {
      x1: tx, y1: layout.axisY + 20, x2: tx, y2: layout.svgHeight - 20,
      stroke: TODAY_COLOR, "stroke-width": "0.75", "stroke-dasharray": "4,3",
      opacity: "0.7"
    }));
  }

  // Drag/resize alignment guide — full-height dotted line at the snapped edge
  if (dragGuide) {
    const gx = layout.timeToX(dragGuide);
    svg.appendChild(el("line", {
      x1: gx, y1: layout.axisY + 20, x2: gx, y2: layout.svgHeight - 20,
      stroke: DRAG_HL, "stroke-width": "1", "stroke-dasharray": "2,3", opacity: "0.85"
    }));
  }

  // Dependency lines are drawn FIRST so they sit behind the bars/milestones (neater,
  // and bars then win pointer events over the lines).
  drawDepLayer(svg, data, layout); // always drawn; CSS mode class controls per-mode visibility

  // Workstreams
  for (const ws of layout.workstreams) {
    // Workstream header
    svg.appendChild(el("text", {
      x: layout.chartLeft, y: ws.y + 18,
      "font-family": '"ET Book", Palatino, Georgia, serif',
      "font-size": "14", fill: HEADING, "font-weight": "bold",
      "letter-spacing": "0.3"
    }, ws.name));

    // Workstream note
    if (ws.note) {
      svg.appendChild(el("text", {
        x: layout.chartLeft, y: ws.y + 32,
        "font-family": '"ET Book", Palatino, Georgia, serif',
        "font-size": "11", fill: MUTED_TEXT, "font-style": "italic"
      }, ws.note));
    }

    // Task bars
    for (const t of ws.tasks) {
      const barH = t.barH;
      const barY = t.y - barH / 2;
      const barW = Math.max(t.x2 - t.x1, 2);

      // Lag lead-in: a 1px line tracing back to the predecessor's end, with a small
      // tick anchoring where the wait began. Drawn under the bar. (Hidden when the
      // dependency overlay is on — the arrow conveys the same link, uniformly.)
      if (depsMode !== "all" && t.lagX != null && t.lagX < t.x1 - 0.5) {
        svg.appendChild(el("line", { x1: t.lagX, y1: t.y, x2: t.x1, y2: t.y,
          stroke: ws.color, "stroke-width": 1, opacity: 0.5 }));
        svg.appendChild(el("line", { x1: t.lagX, y1: t.y - 2.5, x2: t.lagX, y2: t.y + 2.5,
          stroke: ws.color, "stroke-width": 1, opacity: 0.5 }));
      }

      const barAttrs = { x: t.x1, y: barY, width: barW, height: barH, fill: ws.color };
      if (barH >= 4) {
        barAttrs.stroke = MUTED_TEXT;
        barAttrs["stroke-width"] = "0.5";
        barAttrs.rx = "2";
        barAttrs.ry = "2";
      }
      svg.appendChild(el("rect", barAttrs));

      // Drag highlight — outline the dragged item (and, in the same colour, the
      // items moving with it) and show their moving dates above the bar
      if (dragHighlight && dragHighlight.tasks && dragHighlight.tasks.has(t.name)) {
        const isPrimary = t.name === dragHighlight.primary;
        const pad = 2.5;
        svg.appendChild(el("rect", {
          x: t.x1 - pad, y: barY - pad, width: barW + 2 * pad, height: barH + 2 * pad,
          fill: "none", stroke: DRAG_HL, "stroke-width": isPrimary ? 2 : 1.25,
          "stroke-dasharray": isPrimary ? "" : "3,2", rx: 3, ry: 3
        }));
        svg.appendChild(el("text", {
          x: t.x1, y: barY - pad - 4,
          "font-family": '"SF Mono", Menlo, monospace', "font-size": "9",
          fill: DRAG_HL, "text-anchor": "start"
        }, fmtShort(t.startDate) + " → " + fmtShort(t.endDate)));
      }

      // Label — sits left of the bar when it fits there; otherwise flips to the
      // right of the bar when that side has more room (avoids spilling off the
      // left edge for bars that start near the chart's left), else wraps left.
      const labelPad = 6;
      const fontSize = 11;
      const lineHeight = 13;
      const textW = measureText(t.name, fontSize);
      const spaceLeft = t.x1 - labelPad - layout.chartLeft;
      const spaceRight = layout.chartRight - (t.x2 + labelPad);
      const flipRight = textW > spaceLeft && spaceRight > spaceLeft;

      let clusterX = t.x2 + labelPad; // where the cluster annotation starts
      if (flipRight) {
        const anchorX = t.x2 + labelPad;
        const lines = textW > spaceRight ? wrapText(t.name, fontSize, Math.max(spaceRight, 40)) : [t.name];
        const totalH = lines.length * lineHeight;
        const startY = t.y + 3.5 - (totalH - lineHeight) / 2;
        const txt = el("text", {
          x: anchorX, y: startY,
          "font-family": '"ET Book", Palatino, Georgia, serif',
          "font-size": fontSize, fill: LABEL, "text-anchor": "start"
        });
        let widest = 0;
        for (let li = 0; li < lines.length; li++) {
          const tspan = el("tspan", { x: anchorX, dy: li === 0 ? "0" : lineHeight });
          tspan.textContent = lines[li];
          txt.appendChild(tspan);
          widest = Math.max(widest, measureText(lines[li], fontSize));
        }
        svg.appendChild(txt);
        clusterX = anchorX + widest + 8; // push cluster annotation past the flipped label
      } else {
        const anchorX = t.x1 - labelPad;
        // Wrap to available space; allow overlapping the bar a bit (+20px grace)
        const maxW = spaceLeft + 20;
        const lines = textW > spaceLeft ? wrapText(t.name, fontSize, maxW) : [t.name];
        const totalH = lines.length * lineHeight;
        const startY = t.y + 3.5 - (totalH - lineHeight) / 2; // vertically center block on bar
        const txt = el("text", {
          x: anchorX, y: startY,
          "font-family": '"ET Book", Palatino, Georgia, serif',
          "font-size": fontSize, fill: LABEL, "text-anchor": "end"
        });
        for (let li = 0; li < lines.length; li++) {
          const tspan = el("tspan", { x: anchorX, dy: li === 0 ? "0" : lineHeight });
          tspan.textContent = lines[li];
          txt.appendChild(tspan);
        }
        svg.appendChild(txt);
      }

      // Cluster annotation — small muted label to the right of the bar end
      // (or past the flipped label so the two don't overlap)
      if (t.cluster) {
        svg.appendChild(el("text", {
          x: clusterX, y: t.y + 3.5,
          "font-family": '"ET Book", Palatino, Georgia, serif',
          "font-size": "10", fill: FAINT, "font-style": "italic",
          "text-anchor": "start"
        }, t.cluster));
      }

      // Interaction: drag (move/resize), double-click (edit), hover (tooltip),
      // single-click (open link)
      addTaskHandles(svg, t);
    }

    // Milestones
    for (const m of ws.milestones) {
      const size = 5;

      // Optional full-height marker line across the whole timeline
      if (m.line) {
        svg.appendChild(el("line", {
          x1: m.x, y1: layout.axisY + 20, x2: m.x, y2: layout.svgHeight - 20,
          stroke: m.line, "stroke-width": "1", "stroke-dasharray": "2,4", opacity: "0.75"
        }));
      }

      // Drag highlight for a milestone being dragged
      if (dragHighlight && dragHighlight.milestone &&
          dragHighlight.milestone.wsIndex === m.wsIndex && dragHighlight.milestone.msIndex === m.msIndex) {
        svg.appendChild(el("circle", {
          cx: m.x, cy: m.y, r: 9, fill: "none", stroke: DRAG_HL, "stroke-width": 2
        }));
      }

      // Emoji milestone — render the glyph as the marker, with the name beside it
      if (m.emoji) {
        svg.appendChild(el("text", {
          x: m.x, y: m.y + 6,
          "font-size": "16", "text-anchor": "middle"
        }, m.emoji));
        svg.appendChild(el("text", {
          x: m.x + 12, y: m.y + 3.5,
          "font-family": '"ET Book", Palatino, Georgia, serif',
          "font-size": "11", fill: LABEL, "font-style": "italic", "text-anchor": "start"
        }, m.name));
        addMilestoneHandles(svg, m, 22 + measureText(m.name, 11) + 6);
        continue;
      }

      const diamond = `M${m.x},${m.y - size} L${m.x + size},${m.y} L${m.x},${m.y + size} L${m.x - size},${m.y} Z`;
      svg.appendChild(el("path", {
        d: diamond, fill: TEXT, stroke: "none"
      }));
      const mLabelX = m.x + size + 5;
      const mFontSize = 11;
      const mLineHeight = 13;
      const mTextW = measureText(m.name, mFontSize);
      const mSpaceRight = layout.chartRight - mLabelX;
      const mLines = mTextW > mSpaceRight ? wrapText(m.name, mFontSize, Math.max(mSpaceRight, 40)) : [m.name];
      const mTotalH = mLines.length * mLineHeight;
      const mStartY = m.y + 3.5 - (mTotalH - mLineHeight) / 2;
      const mTxt = el("text", {
        x: mLabelX, y: mStartY,
        "font-family": '"ET Book", Palatino, Georgia, serif',
        "font-size": mFontSize, fill: LABEL, "font-style": "italic",
        "text-anchor": "start"
      });
      for (let li = 0; li < mLines.length; li++) {
        const tspan = el("tspan", { x: mLabelX, dy: li === 0 ? "0" : mLineHeight });
        tspan.textContent = mLines[li];
        mTxt.appendChild(tspan);
      }
      svg.appendChild(mTxt);

      addMilestoneHandles(svg, m, size * 2 + 4 + measureText(m.name, 11) + 10);
    }
  }

  // ─── Capacity / slack lanes (below the workstreams) ───────────────
  if (layout.capacity) {
    const cap = layout.capacity;
    // Section header
    svg.appendChild(el("text", {
      x: layout.chartLeft, y: cap.y + 18,
      "font-family": '"ET Book", Palatino, Georgia, serif',
      "font-size": "14", fill: HEADING, "font-weight": "bold", "letter-spacing": "0.3"
    }, "Compute capacity"));
    svg.appendChild(el("text", {
      x: layout.chartLeft, y: cap.y + 32,
      "font-family": '"ET Book", Palatino, Georgia, serif',
      "font-size": "11", fill: MUTED_TEXT, "font-style": "italic"
    }, "Height = FLOPs in pool (log) · solid = free · faded = in use · red = over-subscribed"));

    for (const row of cap.rows) {
      for (const s of row.segs) {
        const w = s.x2 - s.x1;
        if (w <= 0) continue;
        // Faded ghost of the full pool (what's there while online, regardless of use)
        if (s.ghostH > 0) svg.appendChild(el("rect", {
          x: s.x1, y: row.centerY - s.ghostH / 2, width: w, height: s.ghostH, fill: row.color, opacity: "0.2"
        }));
        // Solid = free capacity, shrinking centred as compute gets used
        if (s.solidH > 0) svg.appendChild(el("rect", {
          x: s.x1, y: row.centerY - s.solidH / 2, width: w, height: s.solidH, fill: row.color, opacity: "0.95"
        }));
        // Over-subscription shown in red (capped at full height)
        if (s.redH > 0) svg.appendChild(el("rect", {
          x: s.x1, y: row.centerY - s.redH / 2, width: w, height: s.redH, fill: DANGER, opacity: "0.9"
        }));
      }
      // "Lost" end-cap + note where a cluster goes away
      if (row.lostX != null) {
        svg.appendChild(el("line", {
          x1: row.lostX, y1: row.centerY - 7, x2: row.lostX, y2: row.centerY + 7,
          stroke: row.color, "stroke-width": "1.25"
        }));
        if (row.note) {
          svg.appendChild(el("text", {
            x: row.lostX + 6, y: row.centerY + 3.5,
            "font-family": '"ET Book", Palatino, Georgia, serif',
            "font-size": "10", fill: row.color, "font-style": "italic", "text-anchor": "start"
          }, row.note));
        }
      }
      // Cluster name — left-aligned, on a page-colored chip so it never collides
      // with a lane that starts at the very left edge
      const lw = measureText(row.name, 11);
      svg.appendChild(el("rect", {
        x: layout.chartLeft - 1, y: row.centerY - 7, width: lw + 4, height: 14, fill: BACKGROUND
      }));
      svg.appendChild(el("text", {
        x: layout.chartLeft, y: row.centerY + 3.5,
        "font-family": '"ET Book", Palatino, Georgia, serif',
        "font-size": "11", fill: row.color, "text-anchor": "start"
      }, row.name));

      // Hover hit-area over the whole lane → highlight active activities at that time
      const hit = el("rect", {
        x: layout.chartLeft, y: row.centerY - row.slotH / 2,
        width: layout.chartRight - layout.chartLeft, height: row.slotH,
        fill: "transparent", cursor: "crosshair"
      });
      hit.addEventListener("mousemove", e => capLaneHover(row.name, row.color, e.clientX));
      hit.addEventListener("mouseleave", clearCapHover);
      svg.appendChild(hit);
    }
  }

  // Mouse-following crosshair: full-height guide line + date label under the axis.
  // Always present (hidden until hovered); moved live on mousemove without a re-render.
  const chy1 = layout.axisY + 20, chy2 = layout.svgHeight - 20;
  const cx0 = Math.max(layout.chartLeft, Math.min(crosshair.userX, layout.chartRight));
  const disp = crosshair.visible ? "inline" : "none";
  chLine = el("line", {
    x1: cx0, y1: chy1, x2: cx0, y2: chy2, stroke: RULE,
    "stroke-width": "0.75", "stroke-dasharray": "2,3", opacity: "0.8", display: disp
  });
  chBg = el("rect", { x: cx0 - 34, y: layout.axisY + 18, width: 68, height: 15, fill: BACKGROUND, opacity: "0.9", display: disp });
  chText = el("text", {
    x: cx0, y: layout.axisY + 29, "text-anchor": "middle",
    "font-family": '"SF Mono", Menlo, monospace', "font-size": "10", fill: HEADING, display: disp
  }, crosshair.visible ? fmtShort(xToTime(layout, cx0)) : "");
  svg.appendChild(chLine);
  svg.appendChild(chBg);
  svg.appendChild(chText);

  hlOverlay = el("g", {}); // hover highlights drawn here (updated in place, no re-render)
  svg.appendChild(hlOverlay);

  return svg;
}

// Move the crosshair without re-rendering the chart
function updateCrosshair(clientX) {
  if (dragState || !lastSvg || !lastLayout) return; // drag has its own guide
  const ctm = lastSvg.getScreenCTM();
  if (!ctm) return;
  const userX = (clientX - ctm.e) / ctm.a;
  const cx0 = Math.max(lastLayout.chartLeft, Math.min(userX, lastLayout.chartRight));
  crosshair.visible = true; crosshair.userX = cx0;
  if (chLine) {
    chLine.setAttribute("x1", cx0); chLine.setAttribute("x2", cx0); chLine.setAttribute("display", "inline");
    chBg.setAttribute("x", cx0 - 34); chBg.setAttribute("display", "inline");
    chText.setAttribute("x", cx0); chText.setAttribute("display", "inline");
    chText.textContent = fmtShort(xToTime(lastLayout, cx0));
  }
}
function hideCrosshair() {
  crosshair.visible = false;
  if (chLine) { chLine.setAttribute("display", "none"); chBg.setAttribute("display", "none"); chText.setAttribute("display", "none"); }
}

// ─── App State & Rendering ───────────────────────────────────────
const container = document.getElementById("chart-container");
let lastValidData = null;
let lastLayout = null;   // layout of the most recent render (for drag math)
let lastSvg = null;      // the rendered <svg> element (for coordinate mapping)
const TODAY_KEY = "tufte-gantt-today";
let showTodayLine = localStorage.getItem(TODAY_KEY) !== "0";

// Compact ("page") mode: lay out at a comfortable design width, then scale the
// whole SVG down to a single 8.5in page width. Same style, just compressed.
const COMPACT_KEY = "tufte-gantt-compact";
const COMPACT_DESIGN_WIDTH = 1000; // internal layout width before scaling
const COMPACT_PAGE_WIDTH = 816;    // 8.5in @ 96dpi
let compactMode = localStorage.getItem(COMPACT_KEY) === "1";

// View-only state (per-plan, persisted in localStorage but NOT in the shareable URL,
// and never recorded in the undo history): which workstreams are hidden, and whether
// the compute-capacity section is shown.
let hiddenWs = new Set();
let showCapacity = true;
let depsMode = "all"; // dependency display: "all" | "violations" (red only) | "off" (reveal on hover)
const DEPS_LABEL = { all: "all", violations: "red only", off: "off" };

function render(data) {
  hideTooltip();
  const width = compactMode
    ? COMPACT_DESIGN_WIDTH
    : (container.clientWidth || window.innerWidth);
  const layout = computeLayout(data, width);
  const svg = renderSVG(data, layout);
  if (compactMode) {
    const scale = COMPACT_PAGE_WIDTH / layout.svgWidth;
    svg.setAttribute("viewBox", `0 0 ${layout.svgWidth} ${layout.svgHeight}`);
    svg.setAttribute("width", COMPACT_PAGE_WIDTH);
    svg.setAttribute("height", Math.round(layout.svgHeight * scale));
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    svg.setAttribute("class", "compact-svg");
  }
  const prevL = container.scrollLeft, prevT = container.scrollTop;
  container.innerHTML = "";
  container.appendChild(svg);
  container.scrollLeft = prevL; container.scrollTop = prevT; // don't jump on re-render
  lastValidData = data;
  lastLayout = layout;
  lastSvg = svg;
  renderHighlights(); // repopulate the hover overlay after a full re-render
}

// Hover highlights live in a dedicated overlay <g> that we update in place — so
// hovering never re-renders the chart (which would recreate hit rects under the
// cursor and make highlights/tooltips flicker or linger).
let hlOverlay = null;
function renderHighlights() {
  if (!hlOverlay || !lastLayout) return;
  while (hlOverlay.firstChild) hlOverlay.removeChild(hlOverlay.firstChild);
  // Lane hover → outline the activities using that pool at that time
  if (hoverHL && hoverHL.tasks && hoverHL.tasks.size) {
    for (const ws of lastLayout.workstreams)
      for (const t of ws.tasks)
        if (hoverHL.tasks.has(t.name)) {
          const barY = t.y - t.barH / 2, barW = Math.max(t.x2 - t.x1, 2), pad = 2.5;
          hlOverlay.appendChild(el("rect", {
            x: t.x1 - pad, y: barY - pad, width: barW + 2 * pad, height: t.barH + 2 * pad,
            fill: "none", stroke: hoverHL.color, "stroke-width": 2, rx: 3, ry: 3
          }));
        }
  }
  // Activity hover → outline its pool's lane across the time window, at bar height
  if (clusterHL && lastLayout.capacity) {
    for (const row of lastLayout.capacity.rows) {
      if (row.name !== clusterHL.name) continue;
      for (const s of row.segs) {
        const ix1 = Math.max(s.x1, clusterHL.x1), ix2 = Math.min(s.x2, clusterHL.x2);
        const bh = Math.max(s.ghostH, s.redH);
        if (ix2 <= ix1 || bh <= 0) continue;
        hlOverlay.appendChild(el("rect", {
          x: ix1, y: row.centerY - bh / 2, width: ix2 - ix1, height: bh,
          fill: "none", stroke: DRAG_HL, "stroke-width": 1.5, rx: 2, ry: 2
        }));
      }
    }
  }
  // Dependency-chain hover → outline every item in the hovered item's chain
  if (depHoverChain) {
    for (const ws of lastLayout.workstreams) {
      for (const t of ws.tasks) if (depHoverChain.has(t.name)) {
        const barY = t.y - t.barH / 2, barW = Math.max(t.x2 - t.x1, 2), pad = 2.5;
        hlOverlay.appendChild(el("rect", { x: t.x1 - pad, y: barY - pad, width: barW + 2 * pad,
          height: t.barH + 2 * pad, fill: "none", stroke: DEP_HL, "stroke-width": 2, rx: 3, ry: 3 }));
      }
      for (const m of ws.milestones) if (depHoverChain.has(m.name))
        hlOverlay.appendChild(el("circle", { cx: m.x, cy: m.y, r: 8, fill: "none", stroke: DEP_HL, "stroke-width": 2 }));
    }
  }
}

// Dependency lines (after-parents + annotation deps, drawn the same). Annotation-only:
// items keep their own dates. Finish-to-start — a line runs from the predecessor's END
// to the successor's START; if the successor starts before the predecessor finishes the
// dep is violated and the line turns red (hover it for an explanation).
function drawDepLayer(svg, data, layout) {
  const pos = {};
  const obstacles = []; // every bar/marker as {y, x1, x2}, for channel routing
  for (const ws of layout.workstreams) {
    for (const t of ws.tasks) { pos[t.name] = { xs: t.x1, xe: t.x2, y: t.y }; obstacles.push({ y: t.y, x1: t.x1, x2: t.x2 }); }
    for (const mm of ws.milestones) { pos[mm.name] = { xs: mm.x, xe: mm.x, y: mm.y }; obstacles.push({ y: mm.y, x1: mm.x - 9, x2: mm.x + 9 }); }
  }
  const STUB = 9, PAD = 6, CLEAR = 2, MAXW = 50;
  // Pick the vertical channel x that crosses the fewest intermediate-row bars: score by
  // (crossings, then how far outside the endpoints, then deviation from the natural drop).
  const pickChannel = (fromX, fromY, toX, toY) => {
    const loX = Math.min(fromX, toX), hiX = Math.max(fromX, toX);
    const loY = Math.min(fromY, toY), hiY = Math.max(fromY, toY);
    const between = obstacles.filter((o) => o.y > loY + 1 && o.y < hiY - 1);
    const idealX = (toX >= fromX + STUB) ? toX - STUB : fromX;
    if (!between.length) return idealX;
    const cands = new Set([fromX, toX, idealX]);
    for (const o of between) { cands.add(o.x1 - PAD); cands.add(o.x2 + PAD); }
    let best = idealX, bestScore = Infinity;
    for (const cx of cands) {
      if (cx < loX - MAXW || cx > hiX + MAXW) continue;
      let crossings = 0;
      for (const o of between) if (cx >= o.x1 - CLEAR && cx <= o.x2 + CLEAR) crossings++;
      const outside = Math.max(0, loX - cx) + Math.max(0, cx - hiX);
      const score = crossings * 1000 + outside * 8 + Math.abs(cx - idealX);
      if (score < bestScore) { bestScore = score; best = cx; }
    }
    return best;
  };
  const gEdges = el("g", { class: "dep-layer mode-" + depsMode });
  const seen = new Set();
  const addEdge = (predName, succName) => {
    if (predName === succName) return;
    const a = pos[predName], b = pos[succName];
    if (!a || !b) return; // an endpoint is in a hidden workstream
    const key = predName + "→" + succName;
    if (seen.has(key)) return; seen.add(key);
    const fromX = a.xe, fromY = a.y, toX = b.xs, toY = b.y;
    const backward = toX < fromX - 0.5;
    const col = backward ? DANGER : DEP_COLOR;
    // Route through the lowest-crossing vertical channel. When cx === fromX this is a
    // straight drop; otherwise an elbow nudged into a gap between intermediate bars.
    const cx = pickChannel(fromX, fromY, toX, toY);
    const d = `M ${fromX} ${fromY} H ${cx} V ${toY} H ${toX}`;
    gEdges.appendChild(el("path", {
      class: "dep-edge" + (backward ? " dep-back" : ""),
      "data-a": predName, "data-b": succName,
      d, fill: "none", stroke: col, "stroke-width": 1
    }));
    // Only a violated (red) dep is hoverable — a transparent hit path explains why.
    if (backward) {
      const hit = el("path", { class: "dep-hit", d, fill: "none", stroke: "transparent", "stroke-width": 8 });
      const md = `**Dependency conflict** — “${succName}” starts before “${predName}” finishes`;
      hit.addEventListener("mouseenter", (e) => showTooltip(md, e));
      hit.addEventListener("mousemove", (e) => { if (tooltipVisible) positionTooltip(e); });
      hit.addEventListener("mouseleave", hideTooltip);
      gEdges.appendChild(hit);
    }
  };
  for (const ws of data.workstreams) {
    for (const t of ws.tasks) {
      const p = startParent(t); if (p) addEdge(p, t.name);
      if (Array.isArray(t.deps)) for (const d of t.deps) addEdge(d, t.name);
    }
    if (ws.milestones) for (const mm of ws.milestones)
      if (Array.isArray(mm.deps)) for (const d of mm.deps) addEdge(d, mm.name);
  }
  svg.appendChild(gEdges);
}

// Hover an item → highlight its whole dependency chain (upstream + downstream).
let depHover = null, depHoverChain = null;
let DEP_HL = "#5f7488";
function buildDepAdj(data) {
  const adj = {};
  const link = (a, b) => { (adj[a] = adj[a] || new Set()).add(b); (adj[b] = adj[b] || new Set()).add(a); };
  for (const ws of data.workstreams) {
    for (const t of ws.tasks) { const p = startParent(t); if (p) link(p, t.name); if (Array.isArray(t.deps)) for (const d of t.deps) link(d, t.name); }
    if (ws.milestones) for (const m of ws.milestones) if (Array.isArray(m.deps)) for (const d of m.deps) link(d, m.name);
  }
  return adj;
}
function depChainSet(name) {
  const adj = buildDepAdj(lastValidData);
  const seen = new Set([name]), q = [name];
  while (q.length) { const x = q.pop(); for (const n of (adj[x] || [])) if (!seen.has(n)) { seen.add(n); q.push(n); } }
  return seen;
}
function setDepHover(name) {
  depHover = name;
  depHoverChain = (name && lastValidData) ? depChainSet(name) : null; // computed in every mode (off → reveal)
  if (lastSvg) lastSvg.querySelectorAll(".dep-edge").forEach((e) => {
    if (!depHoverChain) { e.classList.remove("dep-dim", "dep-on"); return; }
    const on = depHoverChain.has(e.getAttribute("data-a")) && depHoverChain.has(e.getAttribute("data-b"));
    e.classList.toggle("dep-on", on);
    e.classList.toggle("dep-dim", !on);
  });
  renderHighlights();
}

// \u2500\u2500\u2500 Canonical model + two-way sync \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// The parsed `model` is the source of truth. The CodeMirror editor and the SVG
// are both views: editing text updates the model; dragging/modal edits mutate
// the model and re-serialize it back into the editor.
let model = null;
let programmaticChange = false; // guards the editor change handler against our own writes

function renderFromModel() {
  // Clone so resolveSpans' _start/_end never touch the canonical model
  const clone = JSON.parse(JSON.stringify(model));
  validate(clone);
  resolveSpans(clone);
  render(clone);
}

// Parse editor text \u2192 become the model (one-way: text \u2192 model \u2192 render)
function loadModelFromText(text) {
  try {
    const data = JSON.parse(text);
    validate(data);
    model = data;
    renderFromModel();
    setStatus("Valid JSON \u2713", false);
    schedulePersist(); // history nodes for text edits are recorded on blur, not per keystroke
    updateUrl();
  } catch (e) {
    setStatus(e.message, true);
  }
}

// Mutated model \u2192 re-serialize into the editor + re-render (model \u2192 text).
// Callers that represent a user action call recordChange(desc) first.
function commitModel() {
  writeEditor(JSON.stringify(model, null, 2));
  renderFromModel();
  setStatus("Valid JSON \u2713", false);
  schedulePersist();
  updateUrl();
  editorBaseline = null; // our own write shouldn't be re-recorded on the next blur
}

// \u2500\u2500\u2500 Shareable URL: compress the plan identity + model into the # fragment \u2500\u2500
function encodeState() {
  // `base` = the hash of the CURRENT node's parent, so a recipient can recompute this
  // tip's commit hash (H(model + base)) and graft it at the right ancestor.
  let base;
  if (history) { const c = curNode(); base = c.parentId != null ? (history.nodes.get(c.parentId) || {}).hash || "" : ""; }
  return compressToEncodedURIComponent(JSON.stringify({
    uuid: currentPlan ? currentPlan.uuid : undefined,
    name: currentPlan ? currentPlan.name : undefined,
    d: model, base,
  })); // view toggles, the "note to self", and full history are NOT shared in the URL.
}
function decodeState(hash) {
  try {
    const json = decompressFromEncodedURIComponent(hash);
    if (!json) return null;
    const p = JSON.parse(json);
    return (p && p.d) ? p : null;
  } catch (e) { return null; }
}
function writeUrlNow() {
  try { window.history.replaceState(null, "", "#" + encodeState()); } catch (e) { /* URL too long, etc. */ }
}
// URL and localStorage are written together (see persistPlan), so a reload never sees
// a hash that lags the local plan — that skew is what used to inject spurious nodes.
function updateUrl() { schedulePersist(); }

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  Undo/redo history tree + named plans
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// \u2500\u2500\u2500 small utils \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const clone = (o) => JSON.parse(JSON.stringify(o));
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─── content-addressed history (git-style) ───────────────────────
// Canonical JSON: object keys sorted recursively so semantically identical models
// hash identically regardless of key order (arrays keep order — it's meaningful).
function canonicalJSON(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
function cyrb53(str, seed = 0) { // fast 53→64-bit non-crypto hash; collisions negligible at this scale
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
// Commit-style: identity = content + lineage, so the same edit made from the same
// parent hashes the same on any machine, and different lineages stay distinct.
function hashOf(model, parentHash) { return cyrb53(canonicalJSON(model) + "|" + (parentHash || "")); }
// (Re)compute every node's hash in id order (parents precede children) and index by hash.
function rehashHistory(h) {
  h.byHash = new Map();
  for (const id of [...h.nodes.keys()].sort((a, b) => a - b)) {
    const n = h.nodes.get(id);
    const parentHash = n.parentId != null ? (h.nodes.get(n.parentId) || {}).hash || "" : "";
    n.hash = hashOf(n.snapshot, parentHash);
    h.byHash.set(n.hash, id);
  }
  return h;
}

function uuidv4() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
// Signed day count \u2192 "+3d" / "\u22122w" (clean weeks when exact)
function signDays(n) {
  const s = n >= 0 ? "+" : "\u2212";
  const a = Math.abs(n);
  if (a && a % 7 === 0) return s + a / 7 + "w";
  return s + a + "d";
}

// \u2500\u2500\u2500 change descriptors: one consistent summary grammar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// A descriptor records WHAT the user did (drives the summary + viz colour);
// the history node also stores a full snapshot for idempotent scrubbing.
const VERB_STYLE = {
  "move":         { color: "#4a7fb5", label: "Move" },
  "resize-start": { color: "#3a9b8f", label: "Resize start" },
  "resize-end":   { color: "#3a9b8f", label: "Resize end" },
  "add-lag":      { color: "#d98c3f", label: "Add lag" },
  "change-lag":   { color: "#c9a227", label: "Change lag" },
  "remove-lag":   { color: "#b5793a", label: "Remove lag" },
  "rename":       { color: "#9b59b6", label: "Rename" },
  "reassign":     { color: "#c0699b", label: "Reassign" },
  "edit":         { color: "#6b7f99", label: "Edit" },
  "replace":      { color: "#8a7a4a", label: "Edit JSON" },
  "create":       { color: "#5aa469", label: "Create" },
  "delete":       { color: "#c0392b", label: "Delete" },
  "init":         { color: "#9a9a90", label: "Initial" },
  "load":         { color: "#7a8a99", label: "Load" },
  "import":       { color: "#2e8b9e", label: "Import" },
};
function verbStyle(v) { return VERB_STYLE[v] || { color: "#9a9a90", label: v }; }

function summarize(desc) {
  const d = desc.details || {};
  const q = (s) => `"${s}"`;
  switch (desc.verb) {
    case "move":
      if (desc.targetType === "milestone")
        return `Move milestone ${q(desc.targetName)}${d.toDate ? ` \u2192 ${d.toDate}` : ""}`;
      return `Move task ${q(desc.targetName)} ${signDays(d.deltaDays || 0)}` +
        (d.affectedCount > 1 ? ` (${d.affectedCount} tasks)` : "");
    case "resize-start": return `Resize task ${q(desc.targetName)} start ${signDays(d.deltaDays || 0)}`;
    case "resize-end":   return `Resize task ${q(desc.targetName)} end ${signDays(d.deltaDays || 0)}`;
    case "add-lag":      return `Add lag task ${q(desc.targetName)} after ${q(d.parent)} ${signDays(d.newLag || 0)}`;
    case "change-lag":   return `Change lag task ${q(desc.targetName)} after ${q(d.parent)} ${d.oldLag}d\u2192${d.newLag}d`;
    case "remove-lag":   return `Remove lag task ${q(desc.targetName)} from ${q(d.parent)} (was ${d.oldLag}d)`;
    case "rename":       return `Rename ${desc.targetType} ${q(d.oldName)} \u2192 ${q(d.newName)}` +
        (d.affectedCount ? `, repoint ${d.affectedCount} dep${d.affectedCount > 1 ? "s" : ""}` : "");
    case "reassign":     return `Move task ${q(desc.targetName)} to ${q(d.toWs)}`;
    case "edit":         return `Edit ${desc.targetType} ${q(desc.targetName)}` +
        (d.fields && d.fields.length ? ` (${d.fields.join(", ")})` : "");
    case "replace":      return d.label || "Edit JSON";
    case "create":       return `Create ${desc.targetType} ${q(desc.targetName)}`;
    case "delete":       return `Delete ${desc.targetType} ${q(desc.targetName)}`;
    case "init":         return "Initial state";
    case "load":         return d.shared ? "Loaded shared version" : "Loaded plan";
    case "import":       return d.detached ? "Imported (detached)" : "Imported version";
    default:             return desc.verb;
  }
}

// \u2500\u2500\u2500 descriptor builders \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function findTaskIn(m, name) {
  for (const ws of m.workstreams) for (const t of ws.tasks) if (t.name === name) return t;
  return null;
}
function buildDragChange(ds) {
  const delta = ds.lastDelta || 0;
  if (ds.kind === "milestone") {
    const ms = model.workstreams[ds.id.wsIndex].milestones[ds.id.msIndex];
    return { source: "drag", verb: "move", targetType: "milestone",
      targetName: ms ? ms.name : "milestone", details: { deltaDays: delta, toDate: ms ? ms.date : undefined } };
  }
  const name = ds.id.name;
  if (ds.kind === "task-left")  return { source: "drag", verb: "resize-start", targetType: "task", targetName: name, details: { deltaDays: delta } };
  if (ds.kind === "task-right") return { source: "drag", verb: "resize-end",   targetType: "task", targetName: name, details: { deltaDays: delta } };
  // task-body: lag (shift, has parent) or translate
  const beforeTask = findTaskIn(ds.snapshot, name);
  if (ds.lastShift && beforeTask && startParent(beforeTask)) {
    const afterTask = modelTaskByName(name);
    const oldLag = startLag(beforeTask), newLag = afterTask ? startLag(afterTask) : oldLag;
    const parent = startParent(afterTask || beforeTask);
    let verb = "change-lag";
    if (oldLag === 0 && newLag !== 0) verb = "add-lag";
    else if (oldLag !== 0 && newLag === 0) verb = "remove-lag";
    return { source: "drag", verb, targetType: "task", targetName: name, details: { parent, oldLag, newLag } };
  }
  const affected = ds.lastMoving && ds.lastMoving.tasks ? ds.lastMoving.tasks.size : 1;
  return { source: "drag", verb: "move", targetType: "task", targetName: name, details: { deltaDays: delta, affectedCount: affected } };
}

const TASK_FIELDS = ["start", "end", "significance", "cluster", "chips", "link", "tooltip"];
const MS_FIELDS = ["date", "emoji", "line", "tooltip"];
function changedFields(a, b, keys) {
  const out = [];
  for (const k of keys) if (!sameJSON(a ? a[k] : undefined, b ? b[k] : undefined)) out.push(k);
  return out;
}
function indexBy(arr, pick) {
  const o = {};
  for (const x of arr || []) for (const y of pick(x)) o[y.name] = y;
  return o;
}
function diffModel(a, b) {
  const ta = indexBy(a.workstreams, (ws) => ws.tasks || []);
  const tb = indexBy(b.workstreams, (ws) => ws.tasks || []);
  const tasks = { added: [], removed: [], changed: [] };
  for (const n in tb) {
    if (!(n in ta)) tasks.added.push(n);
    else { const f = changedFields(ta[n], tb[n], TASK_FIELDS); if (f.length) tasks.changed.push({ name: n, fields: f }); }
  }
  for (const n in ta) if (!(n in tb)) tasks.removed.push(n);
  const ma = indexBy(a.workstreams, (ws) => ws.milestones || []);
  const mb = indexBy(b.workstreams, (ws) => ws.milestones || []);
  const milestones = { added: [], removed: [], changed: [] };
  for (const n in mb) {
    if (!(n in ma)) milestones.added.push(n);
    else { const f = changedFields(ma[n], mb[n], MS_FIELDS); if (f.length) milestones.changed.push({ name: n, fields: f }); }
  }
  for (const n in ma) if (!(n in mb)) milestones.removed.push(n);
  const meta = [];
  if ((a.title || "") !== (b.title || "")) meta.push("title");
  if ((a.note || "") !== (b.note || "")) meta.push("note");
  if (!sameJSON(a.clusters, b.clusters)) meta.push("clusters");
  if (!sameJSON(a.capacity, b.capacity)) meta.push("capacity");
  if (!sameJSON((a.workstreams || []).map((w) => w.name), (b.workstreams || []).map((w) => w.name))) meta.push("workstreams");
  return { tasks, milestones, meta };
}
function summarizeDiff(d) {
  const t = d.tasks, m = d.milestones;
  const total = t.added.length + t.removed.length + t.changed.length +
    m.added.length + m.removed.length + m.changed.length + d.meta.length;
  if (total === 1) { // collapse to the same phrasing a single UI edit would use
    if (t.changed.length) return `Edit task "${t.changed[0].name}" (${t.changed[0].fields.join(", ")})`;
    if (t.added.length) return `Add task "${t.added[0]}"`;
    if (t.removed.length) return `Delete task "${t.removed[0]}"`;
    if (m.changed.length) return `Edit milestone "${m.changed[0].name}" (${m.changed[0].fields.join(", ")})`;
    if (m.added.length) return `Add milestone "${m.added[0]}"`;
    if (m.removed.length) return `Delete milestone "${m.removed[0]}"`;
    if (d.meta.length) return `Edit ${d.meta[0]}`;
  }
  const c = [];
  const noun = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
  if (t.added.length)   c.push(`+${noun(t.added.length, "task")}`);
  if (t.changed.length) c.push(`~${noun(t.changed.length, "task")}`);
  if (t.removed.length) c.push(`\u2212${noun(t.removed.length, "task")}`);
  if (m.added.length)   c.push(`+${noun(m.added.length, "milestone")}`);
  if (m.changed.length) c.push(`~${noun(m.changed.length, "milestone")}`);
  if (m.removed.length) c.push(`\u2212${noun(m.removed.length, "milestone")}`);
  for (const x of d.meta) c.push(x);
  return c.length ? `Edit JSON: ${c.join(", ")}` : "Edit JSON";
}
function buildTextChange(before, after) {
  const d = diffModel(before, after);
  return { source: "text", verb: "replace", targetType: "document",
    targetName: after.title || "plan", details: { label: summarizeDiff(d), struct: d } };
}

// \u2500\u2500\u2500 history tree engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const HISTORY_LIMIT = 500;
let history = null;          // { nodes:Map<id,node>, byHash:Map<hash,id>, rootId, currentId, nextId, limit }
let isTimeTraveling = false; // guards recordChange during undo/redo's own editor write
let editorBaseline = null;   // model snapshot captured on editor focus (text coalescing)
let pendingImport = null;    // reconcile-on-import action, processed once the UI is ready

function newHistory(rootSnapshot, rootDesc) {
  const root = { id: 1, parentId: null, childIds: [], activeChild: null,
    snapshot: clone(rootSnapshot), change: rootDesc, summary: summarize(rootDesc), ts: Date.now() };
  return rehashHistory({ nodes: new Map([[1, root]]), rootId: 1, currentId: 1, nextId: 2, limit: HISTORY_LIMIT });
}
function curNode() { return history.nodes.get(history.currentId); }
function canUndo() { return !!history && curNode().parentId !== null; }
function canRedo() { return !!history && curNode().activeChild !== null; }

// Add a node carrying an imported model. parentId null + detached=true → a detached
// head (no common ancestor found); otherwise it grafts as a child of parentId.
function addImportedNode(m, parentId, detached) {
  const parent = parentId != null ? history.nodes.get(parentId) : null;
  const parentHash = parent ? parent.hash : "";
  const snap = clone(m);
  const desc = { source: "import", verb: "import", targetType: "document",
    targetName: currentPlan ? currentPlan.name : "plan", details: { detached: !!detached } };
  const node = { id: history.nextId++, parentId: parentId != null ? parentId : null,
    childIds: [], activeChild: null, snapshot: snap, change: desc, summary: summarize(desc),
    ts: Date.now(), hash: hashOf(m, parentHash), detached: !!detached };
  history.nodes.set(node.id, node);
  history.byHash.set(node.hash, node.id);
  if (parent) { parent.childIds.push(node.id); parent.activeChild = node.id; }
  history.currentId = node.id;
  model = clone(snap);
  writeEditor(JSON.stringify(model, null, 2));
  renderFromModel();
  editorBaseline = null;
  pruneHistory();
  schedulePersist();
  updateHistoryButtons();
  if (vizOpen) renderViz();
  return node.id;
}

// model is ALREADY mutated to its new state when this is called.
function recordChange(desc) {
  if (isTimeTraveling || !history) return;
  const snap = clone(model);
  const cur = curNode();
  if (sameJSON(snap, cur.snapshot)) return; // no-op (delta 0, identical save, etc.)
  const node = { id: history.nextId++, parentId: cur.id, childIds: [], activeChild: null,
    snapshot: snap, change: desc, summary: summarize(desc), ts: Date.now(),
    hash: hashOf(snap, cur.hash) };
  history.nodes.set(node.id, node);
  history.byHash.set(node.hash, node.id);
  cur.childIds.push(node.id);
  cur.activeChild = node.id; // new edit becomes the linear-redo target \u2192 old branch preserved
  history.currentId = node.id;
  pruneHistory();
  schedulePersist();
  updateHistoryButtons();
  if (vizOpen) renderViz();
}
function undo() { if (canUndo()) jumpTo(curNode().parentId, "Undo"); }
function redo() { if (canRedo()) jumpTo(curNode().activeChild, "Redo"); }

// Idempotent scrub: land on any node deterministically from its snapshot.
function jumpTo(id, label) {
  const node = history.nodes.get(id);
  if (!node) return;
  isTimeTraveling = true;
  history.currentId = id;
  // Make the active (linear redo) path follow this node all the way to the root, so
  // undo-then-redo retraces the branch we landed on instead of veering to a stale one.
  for (let a = id; a != null; ) {
    const n = history.nodes.get(a);
    if (n.parentId != null) history.nodes.get(n.parentId).activeChild = a;
    a = n.parentId;
  }
  model = clone(node.snapshot);
  writeEditor(JSON.stringify(model, null, 2));
  renderFromModel();
  isTimeTraveling = false;
  editorBaseline = null;
  schedulePersist();
  updateUrl(); // keep the shareable #slug in sync with the scrubbed state (as commitModel does)
  updateHistoryButtons();
  if (label) setStatus(`${label}: ${node.summary}`, false);
  if (vizOpen) renderViz();
}
function pruneHistory() {
  while (history.nodes.size > history.limit) {
    const anc = new Set();
    for (let a = history.currentId; a != null; ) { anc.add(a); const n = history.nodes.get(a); a = n ? n.parentId : null; }
    let victim = null;
    for (const n of history.nodes.values())
      if (n.childIds.length === 0 && n.id !== history.rootId && !anc.has(n.id))
        if (!victim || n.ts < victim.ts) victim = n;
    if (!victim) break;
    const p = history.nodes.get(victim.parentId);
    if (p) {
      p.childIds = p.childIds.filter((c) => c !== victim.id);
      if (p.activeChild === victim.id) p.activeChild = p.childIds.length ? p.childIds[p.childIds.length - 1] : null;
    }
    history.byHash.delete(victim.hash);
    history.nodes.delete(victim.id);
  }
}
// A leaf (terminal) node carries no children, so removing it can't orphan anything.
function canDeleteNode(id) {
  const n = history.nodes.get(id);
  return !!n && n.id !== history.rootId && n.childIds.length === 0;
}
function deleteNode(id) {
  if (!canDeleteNode(id)) return;
  const node = history.nodes.get(id);
  if (history.currentId === id) jumpTo(node.parentId, "Delete"); // step off it first
  const p = history.nodes.get(node.parentId);
  if (p) {
    p.childIds = p.childIds.filter((c) => c !== id);
    if (p.activeChild === id) p.activeChild = p.childIds.length ? p.childIds[p.childIds.length - 1] : null;
  }
  history.byHash.delete(node.hash);
  history.nodes.delete(id);
  schedulePersist();
  updateHistoryButtons();
  if (vizOpen) renderViz();
}
function serializeHistory() {
  return { rootId: history.rootId, currentId: history.currentId, nextId: history.nextId,
    nodes: [...history.nodes.values()] };
}
function deserializeHistory(h) {
  const nodes = new Map();
  for (const n of h.nodes) nodes.set(n.id, n);
  // Recompute hashes on load (migrates old trees without hashes, ensures consistency).
  return rehashHistory({ nodes, rootId: h.rootId, currentId: h.currentId, nextId: h.nextId, limit: HISTORY_LIMIT });
}
// Plain, serializable view of the tree \u2014 visualizable even when not visualized.
function exportHistory() {
  return { rootId: history.rootId, currentId: history.currentId,
    nodes: [...history.nodes.values()].map((n) => ({ id: n.id, parentId: n.parentId,
      childIds: n.childIds, activeChild: n.activeChild, summary: n.summary, hash: n.hash,
      detached: !!n.detached, verb: n.change.verb, source: n.change.source, ts: n.ts })) };
}

// Reconcile an incoming shared version once the UI exists (called at end of init).
function processPendingImport() {
  if (!pendingImport) return;
  const pi = pendingImport; pendingImport = null;
  const name = currentPlan ? currentPlan.name : "plan";
  if (pi.kind === "load") {
    jumpTo(pi.nodeId, null);
    ensureViz();
    showToast(`Opened an earlier point in \u201c${name}\u201d history`, { onClick: ensureViz });
  } else if (pi.kind === "graft") {
    addImportedNode(pi.model, pi.parentId, false);
    showToast(`Imported an updated version of \u201c${name}\u201d \u2014 hover the new node to see what changed`, { onClick: ensureViz });
  } else { // detached
    addImportedNode(pi.model, null, true);
    ensureViz();
    showToast(`Imported a version of \u201c${name}\u201d with no shared ancestor \u2014 added as a detached node`, { onClick: ensureViz });
  }
}
function ensureViz() { if (!vizOpen) openHistoryViz(); else renderViz(); }

// \u2500\u2500\u2500 transient toast \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showToast(message, opts) {
  opts = opts || {};
  let host = document.getElementById("toast-host");
  if (!host) { host = document.createElement("div"); host.id = "toast-host"; document.body.appendChild(host); }
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  if (opts.onClick) { t.style.cursor = "pointer"; t.addEventListener("click", () => { dismiss(); opts.onClick(); }); }
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  let timer = setTimeout(dismiss, opts.duration || 6000);
  function dismiss() {
    clearTimeout(timer);
    t.classList.remove("in");
    setTimeout(() => t.remove(), 250);
  }
}

// Factor the editor-write half of commitModel so jumpTo can reuse it.
function writeEditor(text) {
  programmaticChange = true;
  const cur = cm.getCursor(), scroll = cm.getScrollInfo();
  cm.setValue(text);
  cm.setCursor(cur);
  cm.scrollTo(scroll.left, scroll.top);
}

// \u2500\u2500\u2500 named plans: localStorage persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const PLAN_PREFIX = "tg-plan-";
const CURRENT_PLAN_KEY = "tg-current-plan";
const MIGRATED_KEY = "tg-migrated-v1";
let currentPlan = null;     // { uuid, name, note, createdAt } \u2014 note is local-only
let persistTimer = null;

function loadPlan(uuid) {
  try { const s = localStorage.getItem(PLAN_PREFIX + uuid); return s ? JSON.parse(s) : null; }
  catch (e) { return null; }
}
function listPlans() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PLAN_PREFIX)) {
      try { const p = JSON.parse(localStorage.getItem(k)); if (p && p.uuid) out.push(p); } catch (e) {}
    }
  }
  out.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  return out;
}
function writePlanStore(obj) { try { localStorage.setItem(PLAN_PREFIX + obj.uuid, JSON.stringify(obj)); } catch (e) {} }
function schedulePersist() { if (!currentPlan) return; clearTimeout(persistTimer); persistTimer = setTimeout(persistPlan, 250); }
function persistPlan() {
  if (!currentPlan) return;
  currentPlan.lastModified = Date.now();
  writePlanStore({
    uuid: currentPlan.uuid, name: currentPlan.name, note: currentPlan.note || "",
    createdAt: currentPlan.createdAt, lastModified: currentPlan.lastModified,
    today: showTodayLine, compact: compactMode, hidden: [...hiddenWs], showCapacity, depsMode,
    model, history: serializeHistory(),
  });
  try { localStorage.setItem(CURRENT_PLAN_KEY, currentPlan.uuid); } catch (e) {}
  writeUrlNow(); // keep the shareable #slug atomic with the saved plan
}
function createPlanObj(name, modelData) {
  const now = Date.now();
  return { uuid: uuidv4(), name: name || "Untitled plan", note: "", createdAt: now,
    lastModified: now, today: true, compact: false, model: clone(modelData), history: null };
}
// A brand-new plan starts empty — no workstreams, tasks, clusters or capacity.
function emptyModel(name) {
  return { title: name || "Untitled plan", note: "", clusters: [], capacity: [], workstreams: [] };
}
// Pull a stored plan into the live globals (model/history/toggles/meta).
function adoptPlan(p) {
  currentPlan = { uuid: p.uuid, name: p.name || "Untitled plan", note: p.note || "", createdAt: p.createdAt || Date.now() };
  model = clone(p.model);
  history = (p.history && p.history.nodes && p.history.nodes.length)
    ? deserializeHistory(p.history)
    : newHistory(model, { source: "init", verb: "init", targetType: "document", targetName: p.name || "plan", details: {} });
  if (typeof p.today === "boolean") showTodayLine = p.today;
  if (typeof p.compact === "boolean") compactMode = p.compact;
  hiddenWs = new Set(Array.isArray(p.hidden) ? p.hidden : []);
  showCapacity = (typeof p.showCapacity === "boolean") ? p.showCapacity : true;
  depsMode = (typeof p.depsMode === "string") ? p.depsMode : (p.showDeps === false ? "off" : "all"); // migrate old boolean
}
function applyTogglesToUI() {
  todayToggle.checked = showTodayLine;
  compactToggle.checked = compactMode;
  applyDepsUI();
  document.body.classList.toggle("compact-mode", compactMode);
}
function applyDepsUI() { depsBtn.textContent = "Deps: " + DEPS_LABEL[depsMode]; }
function cycleDeps() {
  depsMode = depsMode === "all" ? "violations" : depsMode === "violations" ? "off" : "all";
  applyDepsUI(); // the button label is the feedback — no redundant status message
  if (lastValidData) render(lastValidData);
  schedulePersist();
}
function switchPlan(uuid) {
  if (currentPlan && currentPlan.uuid === uuid) return;
  persistPlan();
  const p = loadPlan(uuid);
  if (!p) return;
  adoptPlan(p);
  applyTogglesToUI();
  writeEditor(JSON.stringify(model, null, 2));
  renderFromModel();
  editorBaseline = null;
  updateHistoryButtons();
  persistPlan();
  updateUrl();
  setStatus(`Plan: ${currentPlan.name}`, false);
}
function newPlanAndSwitch(name, modelData) {
  const obj = createPlanObj(name, modelData || DEFAULT_DATA);
  writePlanStore(obj);
  // switchPlan early-returns if uuid matches; it won't here (fresh uuid)
  switchPlan(obj.uuid);
}
function renamePlan(uuid, name) {
  const p = loadPlan(uuid);
  if (!p) return;
  p.name = name; p.lastModified = Date.now();
  writePlanStore(p);
  if (currentPlan && currentPlan.uuid === uuid) { currentPlan.name = name; updateUrl(); }
}
function setPlanNote(uuid, note) {
  const p = loadPlan(uuid);
  if (!p) return;
  p.note = note; // local-only, never enters the URL
  writePlanStore(p);
  if (currentPlan && currentPlan.uuid === uuid) currentPlan.note = note;
}
function deletePlanAndMaybeSwitch(uuid) {
  localStorage.removeItem(PLAN_PREFIX + uuid);
  if (currentPlan && currentPlan.uuid === uuid) {
    currentPlan = null;
    const rest = listPlans();
    if (rest.length) switchPlan(rest[0].uuid);
    else newPlanAndSwitch("Untitled plan", emptyModel("Untitled plan"));
  }
}
function migrateLegacyIfNeeded() {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  const old = localStorage.getItem(STORAGE_KEY);
  if (old) {
    try {
      const m = JSON.parse(old);
      const obj = createPlanObj(m.title || "My plan", m);
      writePlanStore(obj);
      localStorage.setItem(CURRENT_PLAN_KEY, obj.uuid);
    } catch (e) {}
  }
  localStorage.setItem(MIGRATED_KEY, "1");
}
// Reconcile an incoming URL state (same plan) against the local tree by content hash:
//  - same as current node → null (nothing to do, a plain refresh)
//  - a node we already have → load it
//  - new content whose parent (base) we have → graft as a child of that common ancestor
//  - otherwise → a detached head (no shared ancestor in this tree)
function computeImport(hashState) {
  if (!hashState || !hashState.d || !history) return null;
  const incomingHash = hashOf(hashState.d, hashState.base || "");
  if (incomingHash === curNode().hash) return null;
  if (history.byHash.has(incomingHash)) return { kind: "load", nodeId: history.byHash.get(incomingHash) };
  if (hashState.base && history.byHash.has(hashState.base))
    return { kind: "graft", parentId: history.byHash.get(hashState.base), model: hashState.d };
  return { kind: "detached", model: hashState.d };
}

// Decide which plan to open on load. Shared #hash carries {uuid,name,d,base}.
function bootstrapPlans(hashState) {
  migrateLegacyIfNeeded();
  // View toggles (today/compact/hidden/capacity) are NOT carried in the URL — they come
  // only from the local per-plan record, so there's nothing to apply from the hash here.
  if (hashState && hashState.uuid) {
    const existing = loadPlan(hashState.uuid);
    if (existing) {
      // Known plan: open the LOCAL copy (its history + currentId are authoritative), then
      // reconcile the incoming URL state by content hash — handled after init so we can
      // toast / open the visualizer once the UI exists.
      adoptPlan(existing);
      pendingImport = computeImport(hashState); // reconciled after the UI exists
      return;
    }
    // New uuid from a share link: adopt it as a fresh local plan.
    const obj = createPlanObj(hashState.name || "Shared plan", hashState.d || DEFAULT_DATA);
    obj.uuid = hashState.uuid;
    writePlanStore(obj);
    adoptPlan(loadPlan(obj.uuid));
    const root = history.nodes.get(history.rootId);
    root.change = { source: "load", verb: "load", targetType: "document", targetName: obj.name, details: { shared: true } };
    root.summary = summarize(root.change);
    return;
  }
  if (hashState && hashState.d) { // legacy share link (no uuid)
    const obj = createPlanObj(hashState.d.title || "Shared plan", hashState.d);
    writePlanStore(obj);
    adoptPlan(loadPlan(obj.uuid));
    return;
  }
  // No hash: reopen current pointer, else most-recent, else seed a default.
  const curId = localStorage.getItem(CURRENT_PLAN_KEY);
  let p = curId ? loadPlan(curId) : null;
  if (!p) { const all = listPlans(); p = all[0] || null; }
  if (p) { adoptPlan(p); return; }
  const obj = createPlanObj(DEFAULT_DATA.title || "My plan", DEFAULT_DATA);
  writePlanStore(obj);
  adoptPlan(loadPlan(obj.uuid));
}

// \u2500\u2500\u2500 editor session coalescing (text edits \u2192 one node on blur) \u2500\u2500\u2500
function flushEditorSession() {
  if (!editorBaseline) return;
  clearTimeout(debounceTimer);
  if (!isTimeTraveling) loadModelFromText(cm.getValue()); // force model to the latest valid text
  const base = editorBaseline;
  editorBaseline = null;
  if (sameJSON(model, base)) return; // nothing changed, or stayed invalid
  recordChange(buildTextChange(base, model));
}

// \u2500\u2500\u2500 toolbar/history button state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function updateHistoryButtons() {
  const u = document.getElementById("undo-btn"), r = document.getElementById("redo-btn");
  if (u) {
    u.disabled = !canUndo();
    u.title = canUndo() ? "Undo: " + history.nodes.get(curNode().parentId).summary + "  (\u2318Z)" : "Nothing to undo";
  }
  if (r) {
    r.disabled = !canRedo();
    r.title = canRedo() ? "Redo: " + history.nodes.get(curNode().activeChild).summary + "  (\u2318\u21e7Z)" : "Nothing to redo";
  }
}

// \u2500\u2500\u2500 history visualizer (Ctrl+Y) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let vizOpen = false, vizEl = null, vizMenuEl = null;
function openHistoryViz() {
  if (vizOpen) { closeViz(); return; }
  vizEl = document.createElement("div");
  vizEl.id = "modal-overlay";
  vizEl.innerHTML =
    `<div id="viz-modal" role="dialog" aria-modal="true" aria-label="History">
       <div class="viz-head">
         <span class="viz-title">History tree</span>
         <span class="viz-hint">click a node to scrub \u00b7 right-click to delete a leaf \u00b7 <b>Esc</b> to close</span>
       </div>
       <div id="viz-scroll"></div>
     </div>`;
  document.body.appendChild(vizEl);
  vizOpen = true;
  vizEl.addEventListener("pointerdown", (e) => { if (e.target === vizEl) closeViz(); });
  document.addEventListener("keydown", vizKeydown, true);
  renderViz();
}
function closeViz() {
  if (!vizOpen) return;
  closeVizMenu();
  hideVizTip();
  document.removeEventListener("keydown", vizKeydown, true);
  if (vizEl) vizEl.remove();
  vizEl = null; vizOpen = false;
}
function vizKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); if (vizMenuEl) closeVizMenu(); else closeViz(); }
}
// Right-click a node/label \u2192 context menu offering Delete (leaf nodes only).
function closeVizMenu() {
  if (!vizMenuEl) return;
  document.removeEventListener("pointerdown", onVizMenuOutside, true);
  vizMenuEl.remove(); vizMenuEl = null;
}
function onVizMenuOutside(e) { if (vizMenuEl && !vizMenuEl.contains(e.target)) closeVizMenu(); }
function showVizMenu(e, id) {
  e.preventDefault();
  closeVizMenu();
  const deletable = canDeleteNode(id);
  const node = history.nodes.get(id);
  vizMenuEl = document.createElement("div");
  vizMenuEl.id = "viz-menu";
  vizMenuEl.innerHTML =
    `<div class="viz-menu-label">${esc(node ? node.summary : "")}</div>` +
    `<button data-act="del"${deletable ? "" : " disabled"}` +
    `${deletable ? "" : ' title="Only terminal (leaf) steps can be deleted"'}>Delete step</button>`;
  document.body.appendChild(vizMenuEl);
  const mw = vizMenuEl.offsetWidth, mh = vizMenuEl.offsetHeight;
  vizMenuEl.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + "px";
  vizMenuEl.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + "px";
  if (deletable)
    vizMenuEl.querySelector('[data-act="del"]').addEventListener("click", () => { closeVizMenu(); deleteNode(id); });
  setTimeout(() => document.addEventListener("pointerdown", onVizMenuOutside, true), 0);
}
// git-graph layout: one node per row (time flows down), branches take lanes to
// the right. One row per node means labels never collide, whatever their length.
// Lanes are reclaimed once a branch ends, so width tracks *concurrent* branches
// (usually 1–2) rather than the total ever created — keeping it left-packed.
function layoutHistory() {
  const nodes = history.nodes;
  const ids = [...nodes.keys()].sort((a, b) => a - b); // creation order ≈ chronological
  const row = new Map();
  ids.forEach((id, i) => row.set(id, i));
  // A "chain" is a maximal first-child path: the root line, or a branch and its
  // first-child descendants. Each chain occupies one lane over [top, bottom] rows.
  const isHead = (n) => n.parentId == null || nodes.get(n.parentId).childIds[0] !== n.id;
  const chains = [], chainOf = new Map();
  for (const id of ids) {
    const n = nodes.get(id);
    if (!isHead(n)) continue;
    const c = { top: n.parentId == null ? row.get(id) : row.get(n.parentId), bottom: row.get(id) };
    for (let cur = n; cur; cur = cur.childIds[0] != null ? nodes.get(cur.childIds[0]) : null) {
      chainOf.set(cur.id, chains.length);
      c.bottom = Math.max(c.bottom, row.get(cur.id));
    }
    chains.push(c);
  }
  // Greedy interval-graph colouring by top row: reuse the lowest lane whose previous
  // occupant has fully ended above this chain's top.
  const order = chains.map((_, i) => i).sort((a, b) => chains[a].top - chains[b].top || a - b);
  const laneBottom = [], chainLane = new Array(chains.length);
  for (const ci of order) {
    let lane = 0;
    while (lane < laneBottom.length && laneBottom[lane] >= chains[ci].top) lane++;
    chainLane[ci] = lane;
    laneBottom[lane] = chains[ci].bottom;
  }
  const lane = new Map();
  for (const id of ids) lane.set(id, chainLane[chainOf.get(id)]);
  return { ids, row, lane };
}
function renderViz() {
  if (!vizOpen || !vizEl) return;
  const scroll = vizEl.querySelector("#viz-scroll");
  const { ids, row, lane } = layoutHistory();
  const ROW = 30, LANE = 22, PAD = 22, R = 8;
  let maxLane = 0, maxLabel = 0;
  for (const id of ids) { maxLane = Math.max(maxLane, lane.get(id)); maxLabel = Math.max(maxLabel, history.nodes.get(id).summary.length); }
  const railsW = (maxLane + 1) * LANE;
  const labelX = PAD + railsW + 12;
  const W = labelX + maxLabel * 6.3 + PAD;
  const H = PAD * 2 + Math.max(0, ids.length - 1) * ROW + R * 2;
  const X = (id) => PAD + lane.get(id) * LANE + R;
  const Y = (id) => PAD + row.get(id) * ROW + R;
  let edges = "", nodes = "";
  for (const id of ids) {
    const n = history.nodes.get(id);
    if (n.parentId == null) continue;
    const px = X(n.parentId), py = Y(n.parentId), cx = X(id), cy = Y(id);
    const onPath = history.nodes.get(n.parentId).activeChild === id; // bold the active (linear redo) branch
    const st = `stroke="${onPath ? MUTED_TEXT : HIST_LINE}" stroke-width="${onPath ? 2 : 1.5}" fill="none"`;
    // Turn out at the branch point, then descend the child's own lane. Routing the
    // corner at the PARENT row (H then V) keeps the vertical in the branch's lane
    // instead of overlapping the trunk, so the branch clearly leaves its parent.
    edges += px === cx
      ? `<line x1="${px}" y1="${py}" x2="${cx}" y2="${cy}" ${st}/>`
      : `<path d="M ${px} ${py} H ${cx} V ${cy}" ${st}/>`;
  }
  for (const id of ids) {
    const n = history.nodes.get(id);
    const st = verbStyle(n.change.verb);
    const isCur = id === history.currentId;
    const dash = n.detached ? ' stroke-dasharray="2,2"' : "";
    nodes += `<g class="viz-node" data-id="${id}" style="cursor:pointer">` +
      `<rect x="0" y="${Y(id) - ROW / 2}" width="${W}" height="${ROW}" fill="transparent"/>` +
      `<circle cx="${X(id)}" cy="${Y(id)}" r="${R}" fill="${st.color}" stroke="${isCur ? TEXT : BACKGROUND}" stroke-width="${isCur ? 3 : 1.5}"${dash}/>` +
      `<text x="${labelX}" y="${Y(id) + 4}" class="viz-label" font-weight="${isCur ? "700" : "400"}">${(n.detached ? "⊘ " : "") + esc(n.summary)}</text>` +
      `</g>`;
  }
  scroll.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg>`;
  scroll.querySelectorAll(".viz-node").forEach((g) => {
    const id = +g.getAttribute("data-id");
    g.addEventListener("click", () => jumpTo(id, "Scrub"));
    g.addEventListener("contextmenu", (e) => showVizMenu(e, id));
    g.addEventListener("mouseenter", (e) => showVizTip(e, id));
    g.addEventListener("mousemove", positionVizTip);
    g.addEventListener("mouseleave", hideVizTip);
  });
}

// Hover a node → tooltip with the structural diff vs its parent.
let vizTipEl = null;
function diffLines(d) {
  const out = [];
  const push = (arr, sym, cls, noun) => arr.forEach((x) =>
    out.push({ cls, text: `${sym} ${noun} "${typeof x === "string" ? x : x.name}"${x.fields ? ` (${x.fields.join(", ")})` : ""}` }));
  push(d.tasks.added, "+", "vt-add", "task");
  push(d.tasks.changed, "~", "vt-chg", "task");
  push(d.tasks.removed, "−", "vt-del", "task");
  push(d.milestones.added, "+", "vt-add", "milestone");
  push(d.milestones.changed, "~", "vt-chg", "milestone");
  push(d.milestones.removed, "−", "vt-del", "milestone");
  for (const m of d.meta) out.push({ cls: "vt-chg", text: `~ ${m}` });
  return out;
}
function vizNodeDiffHtml(id) {
  const n = history.nodes.get(id);
  const parent = n.parentId != null ? history.nodes.get(n.parentId) : null;
  const header = `<div class="vt-h">${esc(n.summary)}</div>`;
  if (!parent)
    return header + `<div class="vt-note">${n.detached ? "Detached — no shared ancestor in this tree" : "Root — initial state"}</div>`;
  const lines = diffLines(diffModel(parent.snapshot, n.snapshot));
  if (!lines.length) return header + `<div class="vt-note">No content change vs previous</div>`;
  return header + `<div class="vt-diff">` + lines.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join("") + `</div>`;
}
function showVizTip(e, id) {
  if (!vizTipEl) { vizTipEl = document.createElement("div"); vizTipEl.id = "viz-tip"; document.body.appendChild(vizTipEl); }
  vizTipEl.innerHTML = vizNodeDiffHtml(id);
  vizTipEl.style.display = "block";
  positionVizTip(e);
}
function positionVizTip(e) {
  if (!vizTipEl) return;
  const pad = 14, w = vizTipEl.offsetWidth, h = vizTipEl.offsetHeight;
  vizTipEl.style.left = Math.min(e.clientX + pad, window.innerWidth - w - 8) + "px";
  vizTipEl.style.top = Math.min(e.clientY + pad, window.innerHeight - h - 8) + "px";
}
function hideVizTip() { if (vizTipEl) vizTipEl.style.display = "none"; }

// \u2500\u2500\u2500 plans manager (Ctrl+O) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// \u2500\u2500\u2500 help: keyboard shortcuts & direct-manipulation reference (?) \u2500
let helpEl = null;
function closeHelp() {
  if (!helpEl) return;
  document.removeEventListener("keydown", helpKeydown, true);
  helpEl.remove(); helpEl = null;
}
function helpKeydown(e) { if (e.key === "Escape") { e.preventDefault(); closeHelp(); } }
function openHelpModal() {
  if (helpEl) { closeHelp(); return; } // pressing ? (or the button) again toggles it closed
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "\u2318" : "Ctrl";
  const k = (s) => `<kbd>${s}</kbd>`;
  const row = (keys, desc) => `<tr><td class="help-keys">${keys}</td><td>${esc(desc)}</td></tr>`;
  const kb = [
    row(k("?"), "Show this help"),
    row(k("Ctrl") + k("\\"), "Toggle the JSON editor"),
    row(k(mod) + k("Z"), "Undo"),
    row(k(mod) + k("\u21e7") + k("Z"), "Redo"),
    row(k("Ctrl") + k("Y"), "History tree"),
    row(k("Ctrl") + k("O"), "Plans"),
    row(k("/"), "Show / hide workstreams (↑↓ or j/k, Enter to toggle)"),
    row(k("c"), "Show / hide the compute-capacity section"),
    row(k("d"), "Cycle dependency lines: all → red only → off (hover reveals a chain)"),
    row(k("Esc"), "Close any dialog / menu"),
  ].join("");
  const drag = [
    row("drag bar", "Move the activity (and everything chained to it)"),
    row("drag bar edge", "Resize \u2014 left edge moves the start, right edge the end"),
    row(k("\u21e7") + " + drag bar", "Adjust lag after its predecessor (instead of moving the chain)"),
    row("drag \u25c6 milestone", "Move the milestone\u2019s date"),
    row(k("\u2325") + " while dragging", "Snap to weeks"),
    row(k(mod) + " while dragging", "Snap to months  (default snaps to days)"),
    row("double-click bar / \u25c6", "Edit the activity / milestone in a dialog"),
    row("hover a bar or pool", "Highlight the linked capacity / activities"),
  ].join("");
  const tree = [
    row("click a node", "Scrub the whole plan to that step"),
    row("right-click a node", "Delete that step (terminal/leaf steps only)"),
  ].join("");
  const section = (title, rows) => `<div class="help-section"><h3>${title}</h3><table class="help-table">${rows}</table></div>`;
  const ov = document.createElement("div");
  ov.id = "modal-overlay";
  ov.innerHTML =
    `<div id="modal" role="dialog" aria-modal="true" aria-label="Help" style="width:560px">
       <div class="modal-title">Keyboard & mouse <span style="font-size:12px;color:#999">?</span></div>
       <div class="modal-body">
         ${section("Keyboard", kb)}
         ${section("Direct manipulation", drag)}
         ${section("History tree", tree)}
         <div class="help-note">View toggles (today line, compact, workstreams, capacity) are saved per&#8209;plan, not shared in links.</div>
       </div>
       <div class="modal-actions"><button type="button" data-act="done">Done</button></div>
     </div>`;
  document.body.appendChild(ov);
  helpEl = ov;
  document.addEventListener("keydown", helpKeydown, true);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeHelp(); });
  ov.querySelector('[data-act="done"]').addEventListener("click", closeHelp);
}

// ─── workstreams: show/hide list (/) ─────────────────────────────
// View-only filter — toggling a workstream just hides its rows from the chart;
// the model is untouched, so it never enters undo or the shared URL.
let wsModalEl = null, wsSel = 0;
function closeWsModal() {
  if (!wsModalEl) return;
  document.removeEventListener("keydown", wsKeydown, true);
  wsModalEl.remove(); wsModalEl = null;
}
function toggleWsAt(i) {
  const w = model.workstreams[i];
  if (!w) return;
  if (hiddenWs.has(w.name)) hiddenWs.delete(w.name); else hiddenWs.add(w.name);
  if (lastValidData) render(lastValidData); // computeLayout reads hiddenWs live
  schedulePersist();
  renderWsList();
}
function renderWsList() {
  if (!wsModalEl) return;
  const list = wsModalEl.querySelector("#ws-list");
  const wss = model.workstreams;
  if (!wss.length) { list.innerHTML = '<div class="ws-empty">This plan has no workstreams yet.</div>'; return; }
  wsSel = Math.max(0, Math.min(wsSel, wss.length - 1));
  list.innerHTML = wss.map((w, i) => {
    const hidden = hiddenWs.has(w.name);
    const nt = (w.tasks || []).length, nm = (w.milestones || []).length;
    return `<div class="ws-row${i === wsSel ? " sel" : ""}${hidden ? " off" : ""}" data-i="${i}">
        <span class="ws-check">${hidden ? "☐" : "☑"}</span>
        <span class="ws-name">${esc(w.name)}</span>
        <span class="ws-count">${nt} task${nt !== 1 ? "s" : ""}${nm ? ` · ${nm} ◆` : ""}</span>
      </div>`;
  }).join("");
  list.querySelectorAll(".ws-row").forEach((r) => {
    const i = +r.getAttribute("data-i");
    r.addEventListener("click", () => { wsSel = i; toggleWsAt(i); });
    r.addEventListener("mousemove", () => { if (wsSel !== i) { wsSel = i; renderWsList(); } });
  });
  const sel = list.querySelector(".ws-row.sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}
function wsKeydown(e) {
  const n = model.workstreams.length;
  if (e.key === "Escape" || e.key === "/") { e.preventDefault(); e.stopPropagation(); closeWsModal(); return; }
  if (!n) return;
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); e.stopPropagation(); wsSel = (wsSel + 1) % n; renderWsList(); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); e.stopPropagation(); wsSel = (wsSel - 1 + n) % n; renderWsList(); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleWsAt(wsSel); }
}
function openWorkstreamsModal() {
  if (wsModalEl) { closeWsModal(); return; } // pressing / again toggles it closed
  wsModalEl = document.createElement("div");
  wsModalEl.id = "modal-overlay";
  wsModalEl.innerHTML =
    `<div id="modal" role="dialog" aria-modal="true" aria-label="Workstreams" style="width:460px">
       <div class="modal-title">Workstreams <span style="font-size:12px;color:#999">/</span></div>
       <div class="viz-hint" style="margin:-6px 0 10px">↑↓ or j/k to move · Enter/Space to show/hide · Esc to close</div>
       <div class="modal-body"><div id="ws-list"></div></div>
       <div class="modal-actions"><button type="button" data-act="done">Done</button></div>
     </div>`;
  document.body.appendChild(wsModalEl);
  renderWsList();
  document.addEventListener("keydown", wsKeydown, true);
  wsModalEl.addEventListener("pointerdown", (e) => { if (e.target === wsModalEl) closeWsModal(); });
  wsModalEl.querySelector('[data-act="done"]').addEventListener("click", closeWsModal);
}

function openPlansModal() {
  const fmtDate = (ts) => { try { return new Date(ts).toLocaleString(); } catch (e) { return "\u2014"; } };
  const plans = listPlans();
  const rows = plans.map((p) => {
    const cur = currentPlan && p.uuid === currentPlan.uuid;
    return `<div class="plan-row${cur ? " current" : ""}" data-uuid="${esc(p.uuid)}">
        <div class="plan-main">
          <input class="plan-name" type="text" value="${esc(p.name || "")}" placeholder="Untitled plan">
          <div class="plan-meta"><span class="plan-uuid" title="${esc(p.uuid)}">${esc(p.uuid.slice(0, 8))}</span> \u00b7 ${esc(fmtDate(p.lastModified))}${cur ? " \u00b7 <b>open</b>" : ""}</div>
          <textarea class="plan-note" rows="2" placeholder="Note to self (not shared in links)">${esc(p.note || "")}</textarea>
        </div>
        <div class="plan-acts">
          <button data-act="open"${cur ? " disabled" : ""}>Open</button>
          <button data-act="del" title="Delete plan">\u2715</button>
        </div>
      </div>`;
  }).join("");
  const body = `<div class="plans-list">${rows || '<div class="plan-empty">No plans yet.</div>'}</div>`;
  const ov = document.createElement("div");
  ov.id = "modal-overlay";
  ov.innerHTML =
    `<div id="modal" role="dialog" aria-modal="true" aria-label="Plans" style="width:560px">
       <div class="modal-title">Plans <span style="font-size:12px;color:#999">\u2303O</span></div>
       <div class="modal-body">${body}</div>
       <div class="modal-actions">
         <button type="button" data-act="new">+ New plan</button>
         <button type="button" data-act="done">Done</button>
       </div>
     </div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act="done"]').addEventListener("click", close);
  ov.querySelector('[data-act="new"]').addEventListener("click", () => { close(); newPlanAndSwitch("Untitled plan", emptyModel("Untitled plan")); openPlansModal(); });
  ov.querySelectorAll(".plan-row").forEach((row) => {
    const uuid = row.getAttribute("data-uuid");
    row.querySelector(".plan-name").addEventListener("change", (e) => renamePlan(uuid, e.target.value.trim() || "Untitled plan"));
    row.querySelector(".plan-note").addEventListener("change", (e) => setPlanNote(uuid, e.target.value));
    const openBtn = row.querySelector('[data-act="open"]');
    if (openBtn) openBtn.addEventListener("click", () => { close(); switchPlan(uuid); });
    row.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (!confirm("Delete this plan and its history? This cannot be undone.")) return;
      close(); deletePlanAndMaybeSwitch(uuid); openPlansModal();
    });
  });
}

// \u2500\u2500\u2500 Direct-manipulation editing: dates & forest helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const DAY_MS = 86400000;

function fmtDate(d) { // ISO, for serializing back into the model
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtShort(d) { return MONTH_ABBR[d.getMonth()] + " " + d.getDate(); } // for on-screen readouts
function dayDiff(a, b) { // whole days from b to a (local midnights)
  const am = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bm = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((+am - +bm) / DAY_MS);
}
function snapDate(d, unit) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (d.getHours() >= 12) r.setDate(r.getDate() + 1); // nearest day
  if (unit === "week") {
    const dow = r.getDay();                       // 0 Sun..6 Sat
    const mon = new Date(r); mon.setDate(r.getDate() - (dow === 0 ? 6 : dow - 1));
    const next = new Date(mon); next.setDate(mon.getDate() + 7);
    return (Math.abs(+r - +mon) <= Math.abs(+r - +next)) ? mon : next;
  }
  if (unit === "month") {
    const first = new Date(r.getFullYear(), r.getMonth(), 1);
    const next = new Date(r.getFullYear(), r.getMonth() + 1, 1);
    return (Math.abs(+r - +first) <= Math.abs(+r - +next)) ? first : next;
  }
  return r;
}
function snapUnitFor(e) {
  if (e.metaKey || e.ctrlKey) return "month";
  if (e.altKey) return "week";
  return "day";
}
function xToTime(layout, x) {
  const frac = (x - layout.chartLeft) / (layout.chartRight - layout.chartLeft);
  return new Date(+layout.minDate + frac * (+layout.maxDate - +layout.minDate));
}

function modelTasks() {
  const o = [];
  for (const ws of model.workstreams) for (const t of ws.tasks) o.push(t);
  return o;
}
function modelTaskByName(n) { return modelTasks().find(t => t.name === n) || null; }
function startParent(t) {
  if (typeof t.start === "string") return t.start;
  if (Array.isArray(t.start) && t.start[0] === "after") return t.start[1];
  return null;
}
function startLag(t) {
  if (Array.isArray(t.start) && t.start[0] === "after") {
    const dur = t.start[2] || ["days", 0];
    if (dur[0] === "weeks") return dur[1] * 7;
    if (dur[0] === "months") return dur[1] * 30;
    return dur[1];
  }
  return 0;
}
function rootOf(t) {
  let cur = t, seen = new Set();
  while (true) {
    const p = startParent(cur);
    if (!p || seen.has(cur.name)) return cur;
    seen.add(cur.name);
    const pt = modelTaskByName(p);
    if (!pt) return cur;
    cur = pt;
  }
}
function layoutTaskByName(layout, name) {
  for (const ws of layout.workstreams) for (const t of ws.tasks) if (t.name === name) return t;
  return null;
}

// \u2500\u2500\u2500 Drag state machine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let dragState = null;
let dragJustHappened = false;
let dragHighlight = null; // { primary, tasks:Set<name>, milestone:{wsIndex,msIndex} }
let dragGuide = null;     // Date at the snapped drag edge → full-height alignment line
let crosshair = { visible: false, userX: 0 }; // mouse-following vertical guide + date
let chLine = null, chBg = null, chText = null; // live crosshair elements in the current SVG
let clusterHL = null; // { name, x1, x2 } — lane + time window of the hovered activity
function setClusterHL(name, x1, x2) {
  const next = name ? { name, x1, x2 } : null;
  const same = (!next && !clusterHL) ||
    (next && clusterHL && clusterHL.name === next.name && clusterHL.x1 === next.x1 && clusterHL.x2 === next.x2);
  if (same) return;
  clusterHL = next;
  renderHighlights();
}

function descendantsOf(name) {
  const out = [], stack = [name];
  while (stack.length) {
    const n = stack.pop();
    for (const x of modelTasks()) if (startParent(x) === n && !out.includes(x.name)) { out.push(x.name); stack.push(x.name); }
  }
  return out;
}
// The set of items that move together with the dragged one
function movingSet(kind, id, shift) {
  if (kind === "milestone") return { primary: null, tasks: new Set(), milestone: { wsIndex: id.wsIndex, msIndex: id.msIndex } };
  const t = modelTaskByName(id.name);
  if (!t) return { primary: id.name, tasks: new Set(), milestone: null };
  let names;
  if (kind === "task-body" && !shift) {
    const root = rootOf(t);                          // translate \u2192 whole connected tree
    names = new Set([root.name, ...descendantsOf(root.name)]);
  } else {
    names = new Set([t.name, ...descendantsOf(t.name)]); // lag / resize \u2192 task + its subtree
  }
  return { primary: id.name, tasks: names, milestone: null };
}

function screenPxPerDay() {
  const ctm = lastSvg.getScreenCTM();
  const totalDays = (+lastLayout.maxDate - +lastLayout.minDate) / DAY_MS;
  const userPerDay = (lastLayout.chartRight - lastLayout.chartLeft) / totalDays;
  return userPerDay * ctm.a;
}

function beginDrag(kind, id, e) {
  if (e.button !== 0 || dragState) return;
  e.stopPropagation(); // selection is suppressed on the body once a drag actually starts
  let origDate;
  if (kind === "milestone") {
    const ml = lastLayout.workstreams[id.wsIndex].milestones.find(m => m.msIndex === id.msIndex);
    origDate = ml ? ml.date : new Date();
  } else {
    const tl = layoutTaskByName(lastLayout, id.name);
    if (!tl) return;
    origDate = (kind === "task-right") ? tl.endDate : tl.startDate;
  }
  const resolved = {};
  for (const ws of lastLayout.workstreams)
    for (const tl of ws.tasks) resolved[tl.name] = { startDate: tl.startDate, endDate: tl.endDate };
  dragState = {
    kind, id, origDate, resolved,
    grabClientX: e.clientX,
    pxPerDay: screenPxPerDay(),
    snapshot: JSON.parse(JSON.stringify(model)),
    active: false
  };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragUp);
}

function onDragMove(e) {
  if (!dragState) return;
  const dxScreen = e.clientX - dragState.grabClientX;
  if (!dragState.active) {
    if (Math.abs(dxScreen) < 3) return; // distinguish click from drag
    dragState.active = true;
    document.body.style.cursor = (dragState.kind === "task-left" || dragState.kind === "task-right") ? "ew-resize" : "grabbing";
    document.body.style.userSelect = "none";
  }
  const rawDays = dxScreen / dragState.pxPerDay;
  const target = snapDate(new Date(+dragState.origDate + rawDays * DAY_MS), snapUnitFor(e));
  const deltaDays = dayDiff(target, dragState.origDate);
  model = JSON.parse(JSON.stringify(dragState.snapshot)); // reset, then apply absolute delta
  applyDrag(dragState.kind, dragState.id, deltaDays, e.shiftKey);
  dragHighlight = movingSet(dragState.kind, dragState.id, e.shiftKey);
  dragState.lastDelta = deltaDays;   // remembered for the history descriptor on drop
  dragState.lastShift = e.shiftKey;
  dragState.lastMoving = dragHighlight;
  dragGuide = target;
  renderFromModel();
  showDragTip(e, target);
}

function onDragUp() {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragUp);
  hideDragTip();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  const wasActive = dragState && dragState.active;
  const change = wasActive ? buildDragChange(dragState) : null; // build before clearing state
  dragState = null;
  dragHighlight = null; // clear before the final (committed) render
  dragGuide = null;
  if (wasActive) {
    recordChange(change);
    commitModel();
    dragJustHappened = true;
    setTimeout(() => { dragJustHappened = false; }, 300);
  }
}

function applyDrag(kind, id, deltaDays, shift) {
  if (deltaDays === 0) return;
  if (kind === "milestone") {
    const ms = model.workstreams[id.wsIndex].milestones[id.msIndex];
    ms.date = fmtDate(new Date(+parseDate(ms.date) + deltaDays * DAY_MS));
    return;
  }
  const t = modelTaskByName(id.name);
  if (!t) return;
  if (kind === "task-body") {
    if (shift && startParent(t)) addLag(t, deltaDays);
    else translateTree(t, deltaDays);
  } else if (kind === "task-left") {
    resizeStart(t, deltaDays);
  } else if (kind === "task-right") {
    resizeEnd(t, deltaDays);
  }
}

function shiftDateSpec(spec, deltaDays) {
  return ["date", fmtDate(new Date(+parseDate(spec[1]) + deltaDays * DAY_MS))];
}
function translateTree(t, deltaDays) {
  // Shift every absolute date endpoint across the whole connected tree. Relative
  // starts (chained/after) and duration ends follow automatically on resolve; an
  // absolute ["date", …] end would otherwise stay pinned and stretch the bar.
  const root = rootOf(t);
  const names = new Set([root.name, ...descendantsOf(root.name)]);
  for (const name of names) {
    const task = modelTaskByName(name);
    if (!task) continue;
    if (Array.isArray(task.start) && task.start[0] === "date") task.start = shiftDateSpec(task.start, deltaDays);
    if (Array.isArray(task.end) && task.end[0] === "date") task.end = shiftDateSpec(task.end, deltaDays);
  }
}
function addLag(t, deltaDays) {
  const p = startParent(t);
  const newLag = startLag(t) + deltaDays;
  t.start = newLag === 0 ? p : ["after", p, ["days", newLag]];
}
function setEndSpec(t, durDays, endDate) {
  // Resizing is day-precise: keep an absolute date end as a date, otherwise store
  // a duration — clean weeks only when it lands exactly on a week, else days.
  durDays = Math.max(1, durDays);
  if (Array.isArray(t.end) && t.end[0] === "date") t.end = ["date", fmtDate(endDate)];
  else if (durDays % 7 === 0) t.end = ["weeks", durDays / 7];
  else t.end = ["days", durDays];
}
function resizeEnd(t, deltaDays) {
  const r = dragState.resolved[t.name];
  const newEnd = new Date(+r.endDate + deltaDays * DAY_MS);
  setEndSpec(t, Math.max(1, dayDiff(newEnd, r.startDate)), newEnd);
}
function resizeStart(t, deltaDays) {
  const r = dragState.resolved[t.name];
  let ns = new Date(+r.startDate + deltaDays * DAY_MS);
  if (dayDiff(r.endDate, ns) < 1) ns = new Date(+r.endDate - DAY_MS); // keep \u22651 day
  if (typeof t.start === "string" || (Array.isArray(t.start) && t.start[0] === "after")) {
    const p = startParent(t), pe = dragState.resolved[p] && dragState.resolved[p].endDate;
    if (pe) { const lag = dayDiff(ns, pe); t.start = lag === 0 ? p : ["after", p, ["days", lag]]; }
    else t.start = ["date", fmtDate(ns)];
  } else {
    t.start = ["date", fmtDate(ns)];
  }
  setEndSpec(t, Math.max(1, dayDiff(r.endDate, ns)), r.endDate); // keep end fixed
}

// \u2500\u2500\u2500 Drag affordance tooltip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let dragTipEl = null;
function showDragTip(e, date) {
  if (!dragTipEl) {
    dragTipEl = document.createElement("div");
    dragTipEl.id = "drag-tip";
    document.body.appendChild(dragTipEl);
  }
  dragTipEl.textContent = fmtShort(date);
  dragTipEl.style.display = "block";
  dragTipEl.style.left = (e.clientX + 14) + "px";
  dragTipEl.style.top = (e.clientY + 14) + "px";
}
function hideDragTip() { if (dragTipEl) dragTipEl.style.display = "none"; }

// ─── Capacity-lane hover → highlight the activities using that cluster now ──
let hoverHL = null;        // { tasks:Set<name>, color }
function capLaneHover(clName, color, clientX) {
  if (dragState) return;
  const ctm = lastSvg.getScreenCTM();
  const userX = (clientX - ctm.e) / ctm.a;             // viewport → SVG user x
  const time = xToTime(lastLayout, userX);
  const tasks = new Set();
  for (const ws of lastLayout.workstreams)
    for (const t of ws.tasks)
      if (t.cluster === clName && t.startDate <= time && time < t.endDate) tasks.add(t.name);
  // only redraw the overlay if the set changed (avoids needless work while moving)
  if (hoverHL && hoverHL.color === color && hoverHL.tasks.size === tasks.size &&
      [...tasks].every(n => hoverHL.tasks.has(n))) return;
  hoverHL = { tasks, color };
  renderHighlights();
}
function clearCapHover() { if (hoverHL) { hoverHL = null; renderHighlights(); } }

// \u2500\u2500\u2500 SVG interaction handles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function addTaskHandles(svg, t) {
  const hitH = Math.max(t.barH, 14);
  const yTop = t.y - hitH / 2;
  const x1 = t.x1, x2 = Math.max(t.x2, t.x1 + 2), w = x2 - x1;
  const id = { name: t.name, wsIndex: t.wsIndex, taskIndex: t.taskIndex, link: t.link, tooltip: t.tooltip };
  const body = el("rect", { x: x1, y: yTop, width: w, height: hitH, fill: "transparent", cursor: "grab" });
  attachItemEvents(body, t.tooltip, e => beginDrag("task-body", id, e), () => openTaskModal(t.wsIndex, t.taskIndex));
  if (t.cluster) {
    body.addEventListener("mouseenter", () => setClusterHL(t.cluster, t.x1, t.x2)); // highlight the pool/time it draws from
    body.addEventListener("mouseleave", () => setClusterHL(null));
  }
  body.addEventListener("mouseenter", () => setDepHover(t.name));
  body.addEventListener("mouseleave", () => setDepHover(null));
  svg.appendChild(body);
  if (w >= 14) {
    for (const [side, hx] of [["task-left", x1 - 3], ["task-right", x2 - 4]]) {
      const edge = el("rect", { x: hx, y: yTop, width: 7, height: hitH, fill: "transparent", cursor: "ew-resize" });
      edge.addEventListener("pointerdown", e => beginDrag(side, id, e));
      edge.addEventListener("dblclick", e => { e.preventDefault(); openTaskModal(t.wsIndex, t.taskIndex); });
      svg.appendChild(edge);
    }
  }
}
function addMilestoneHandles(svg, m, hitW) {
  const rect = el("rect", { x: m.x - 9, y: m.y - 10, width: Math.max(hitW, 18), height: 20, fill: "transparent", cursor: "grab" });
  attachItemEvents(rect, m.tooltip, e => beginDrag("milestone", { wsIndex: m.wsIndex, msIndex: m.msIndex }, e),
    () => openMilestoneModal(m.wsIndex, m.msIndex));
  rect.addEventListener("mouseenter", () => setDepHover(m.name));
  rect.addEventListener("mouseleave", () => setDepHover(null));
  svg.appendChild(rect);
}
// Shared wiring: hover tooltip, pointerdown\u2192drag, dblclick\u2192modal
function attachItemEvents(rect, tooltip, onDown, onDbl) {
  rect.addEventListener("pointerdown", e => onDown(e));
  rect.addEventListener("dblclick", e => { e.preventDefault(); onDbl(); });
  if (tooltip) {
    rect.addEventListener("mouseenter", e => showTooltip(tooltip, e));
    rect.addEventListener("mousemove", e => { if (tooltipVisible) positionTooltip(e); });
    rect.addEventListener("mouseleave", hideTooltip);
  }
}

// \u2500\u2500\u2500 Modal editor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
let modalEl = null;
function closeModal() {
  if (!modalEl) return;
  modalEl.remove(); modalEl = null;
  document.removeEventListener("keydown", modalKeydown, true);
}
function modalKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); modalEl._save(); }
  else if (e.key === "Tab") {
    const f = modalEl.querySelectorAll("input,select,textarea,button");
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
function openModalShell(title, bodyHtml, onSave) {
  closeModal();
  modalEl = document.createElement("div");
  modalEl.id = "modal-overlay";
  modalEl.innerHTML =
    `<div id="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
       <div class="modal-title">${esc(title)}</div>
       <div class="modal-body">${bodyHtml}</div>
       <div class="modal-actions">
         <button type="button" data-act="cancel">Cancel</button>
         <button type="button" data-act="save">Save</button>
       </div>
     </div>`;
  document.body.appendChild(modalEl);
  modalEl._save = onSave;
  modalEl.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
  modalEl.querySelector('[data-act="save"]').addEventListener("click", onSave);
  modalEl.addEventListener("pointerdown", e => { if (e.target === modalEl) closeModal(); });
  document.addEventListener("keydown", modalKeydown, true);
  const first = modalEl.querySelector("input,select,textarea");
  if (first) first.focus();
}
function field(label, inner) { return `<label class="modal-field"><span>${esc(label)}</span>${inner}</label>`; }

// Free chips on this task's cluster at its start (capacity minus what other
// activities are using then) — the default allocation in the modal
function remainingChips(wsIndex, taskIndex) {
  let clone;
  try { clone = JSON.parse(JSON.stringify(model)); validate(clone); resolveSpans(clone); }
  catch (e) { return null; }
  const t = clone.workstreams[wsIndex].tasks[taskIndex];
  const cl = capCluster(clone, t.cluster);
  if (!cl) return null;
  const cap = capChipsAt(cl, t._start);
  let used = 0;
  for (const ws of clone.workstreams)
    for (const o of ws.tasks) {
      if (o === t || o.cluster !== t.cluster) continue;
      if (o._start <= t._start && t._start < o._end) used += (o.chips != null ? o.chips : capChipsAt(cl, t._start));
    }
  return Math.max(0, cap - used);
}

function openTaskModal(wsIndex, taskIndex) {
  const t = model.workstreams[wsIndex].tasks[taskIndex];
  const oldName = t.name;
  const oldTask = clone(t);
  const oldWsName = model.workstreams[wsIndex].name;
  const cl = capCluster(model, t.cluster);
  const maxChips = cl ? capMaxChips(cl) : "";
  const remChips = remainingChips(wsIndex, taskIndex);
  const chipsVal = t.chips != null ? t.chips : (remChips != null ? remChips : "");
  const wsOpts = model.workstreams.map((w, i) => `<option value="${i}" ${i === wsIndex ? "selected" : ""}>${esc(w.name)}</option>`).join("");
  const isAfter = typeof t.start === "string" || (Array.isArray(t.start) && t.start[0] === "after");
  const startDateVal = (Array.isArray(t.start) && t.start[0] === "date") ? t.start[1] : "";
  const afterName = startParent(t) || "";
  const taskOpts = modelTasks().filter(x => x.name !== oldName).map(x => `<option ${x.name === afterName ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  const isEndDate = Array.isArray(t.end) && t.end[0] === "date";
  const clusterOpts = ["", ...(model.capacity || []).map(c => c.name)]
    .map(c => `<option ${c === (t.cluster || "") ? "selected" : ""}>${esc(c)}</option>`).join("");
  const body =
    field("Name", `<input id="m-name" type="text" value="${esc(t.name)}">`) +
    field("Workstream", `<select id="m-ws">${wsOpts}</select>`) +
    `<fieldset class="modal-group"><legend>Start</legend>
       <label class="modal-radio"><input type="radio" name="m-startkind" id="m-sk-date" ${isAfter ? "" : "checked"}> On date
         <input id="m-startdate" type="date" value="${esc(startDateVal)}"></label>
       <label class="modal-radio"><input type="radio" name="m-startkind" id="m-sk-after" ${isAfter ? "checked" : ""}> After
         <select id="m-after">${taskOpts}</select> + <input id="m-lag" type="number" value="${startLag(t)}" style="width:4em"> days lag</label>
     </fieldset>` +
    `<fieldset class="modal-group"><legend>End</legend>
       <label class="modal-radio"><input type="radio" name="m-endkind" id="m-ek-dur" ${isEndDate ? "" : "checked"}>
         <input id="m-durn" type="number" value="${isEndDate ? 4 : t.end[1]}" style="width:4em">
         <select id="m-durunit">${["days", "weeks", "months"].map(u => `<option ${(!isEndDate && t.end[0] === u) ? "selected" : ""}>${u}</option>`).join("")}</select></label>
       <label class="modal-radio"><input type="radio" name="m-endkind" id="m-ek-date" ${isEndDate ? "checked" : ""}> On date
         <input id="m-enddate" type="date" value="${esc(isEndDate ? t.end[1] : "")}"></label>
     </fieldset>` +
    field("Significance", `<input id="m-sig" type="number" min="0" value="${esc(t.significance != null ? t.significance : "")}">`) +
    field("Cluster", `<select id="m-cluster">${clusterOpts}</select>`) +
    field("Chips", `<input id="m-chips" type="number" min="1" ${maxChips ? `max="${maxChips}"` : ""} value="${esc(chipsVal)}"> <span style="font-size:11px;color:#888">max ${maxChips || "?"}${remChips != null ? ` · ${remChips} free at start` : ""}</span>`) +
    field("Link", `<input id="m-link" type="url" value="${esc(t.link || "")}">`) +
    field("Tooltip (markdown)", `<textarea id="m-tip" rows="8">${esc(t.tooltip || "")}</textarea>`);
  openModalShell("Edit activity", body, () => {
    const g = id => modalEl.querySelector("#" + id);
    const nt = { name: g("m-name").value.trim() || oldName };
    if (g("m-sk-after").checked) {
      const after = g("m-after").value, lag = +g("m-lag").value || 0;
      nt.start = lag === 0 ? after : ["after", after, ["days", lag]];
    } else nt.start = ["date", g("m-startdate").value];
    if (g("m-ek-date").checked) nt.end = ["date", g("m-enddate").value];
    else nt.end = [g("m-durunit").value, +g("m-durn").value || 1];
    if (g("m-sig").value !== "") nt.significance = +g("m-sig").value;
    if (g("m-cluster").value) nt.cluster = g("m-cluster").value;
    if (g("m-chips").value !== "") nt.chips = +g("m-chips").value;
    if (g("m-link").value.trim()) nt.link = g("m-link").value.trim();
    if (g("m-tip").value) nt.tooltip = g("m-tip").value;
    // rename \u2192 repoint any dependents (count them for the history summary)
    let repointed = 0;
    if (nt.name !== oldName)
      for (const x of modelTasks()) {
        if (x.start === oldName) { x.start = nt.name; repointed++; }
        else if (Array.isArray(x.start) && x.start[0] === "after" && x.start[1] === oldName) { x.start[1] = nt.name; repointed++; }
      }
    const newWs = +g("m-ws").value;
    if (newWs === wsIndex) {
      model.workstreams[wsIndex].tasks[taskIndex] = nt; // replace in place (keep order)
    } else {
      model.workstreams[wsIndex].tasks.splice(taskIndex, 1);
      model.workstreams[newWs].tasks.push(nt);
    }
    // One node per save; pick the most salient verb (rename > reassign > field edit).
    let desc;
    if (nt.name !== oldName)
      desc = { source: "modal-task", verb: "rename", targetType: "task", targetName: nt.name,
        details: { oldName, newName: nt.name, affectedCount: repointed } };
    else if (newWs !== wsIndex)
      desc = { source: "modal-task", verb: "reassign", targetType: "task", targetName: nt.name,
        details: { fromWs: oldWsName, toWs: model.workstreams[newWs].name } };
    else
      desc = { source: "modal-task", verb: "edit", targetType: "task", targetName: nt.name,
        details: { fields: changedFields(oldTask, nt, TASK_FIELDS) } };
    recordChange(desc);
    commitModel(); closeModal();
  });
}

function openMilestoneModal(wsIndex, msIndex) {
  const m = model.workstreams[wsIndex].milestones[msIndex];
  const oldMs = clone(m);
  const body =
    field("Name", `<input id="m-name" type="text" value="${esc(m.name)}">`) +
    field("Date", `<input id="m-date" type="date" value="${esc(m.date)}">`) +
    field("Emoji", `<input id="m-emoji" type="text" value="${esc(m.emoji || "")}" style="width:4em">`) +
    field("Marker line", `<input id="m-line" type="text" placeholder="#c0392b or empty" value="${esc(m.line || "")}">`) +
    field("Tooltip (markdown)", `<textarea id="m-tip" rows="8">${esc(m.tooltip || "")}</textarea>`);
  openModalShell("Edit milestone", body, () => {
    const g = id => modalEl.querySelector("#" + id);
    const nm = { name: g("m-name").value.trim() || m.name, date: g("m-date").value };
    if (g("m-emoji").value.trim()) nm.emoji = g("m-emoji").value.trim();
    if (g("m-line").value.trim()) nm.line = g("m-line").value.trim();
    if (g("m-tip").value) nm.tooltip = g("m-tip").value;
    model.workstreams[wsIndex].milestones[msIndex] = nm;
    const desc = (nm.name !== oldMs.name)
      ? { source: "modal-milestone", verb: "rename", targetType: "milestone", targetName: nm.name,
          details: { oldName: oldMs.name, newName: nm.name } }
      : { source: "modal-milestone", verb: "edit", targetType: "milestone", targetName: nm.name,
          details: { fields: changedFields(oldMs, nm, MS_FIELDS) } };
    recordChange(desc);
    commitModel(); closeModal();
  });
}

function setStatus(msg, isError) {
  const el = document.getElementById("status-msg");
  el.textContent = msg;
  el.className = isError ? "error" : "";
}

// ─── CodeMirror Setup ────────────────────────────────────────────
const cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
  mode: "application/json",
  lineNumbers: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  gutters: ["CodeMirror-lint-markers"],
  lint: true,
  tabSize: 2,
  indentWithTabs: false
});

// ═══════════════════════════════════════════════════════════════════
//  Theme engine — local-only, follows the OS light/dark preference
// ═══════════════════════════════════════════════════════════════════
// A theme is a token map (see src/themes.js). Built-ins live in code; imported
// themes (same shape) live in localStorage. The selection binds one theme to the
// system LIGHT slot and one to the DARK slot; we apply whichever matches the OS.
// Nothing is ever uploaded — themes + selection live only in this browser.
const THEME_CUSTOM_KEY = "plantt-themes-custom";
const THEME_SELECTION_KEY = "plantt-theme-selection";

function loadCustomThemes() {
  try { const a = JSON.parse(localStorage.getItem(THEME_CUSTOM_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function saveCustomThemes(arr) { localStorage.setItem(THEME_CUSTOM_KEY, JSON.stringify(arr)); }
// builtins first; a custom theme may override a builtin by reusing its id.
function allThemes() {
  const map = new Map();
  for (const t of BUILTIN_THEMES) map.set(t.id, { ...t, builtin: true });
  for (const t of loadCustomThemes()) map.set(t.id, { ...t, builtin: false });
  return [...map.values()];
}
function themeById(id) { return allThemes().find((t) => t.id === id) || null; }

function loadSelection() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(THEME_SELECTION_KEY) || "null"); } catch (e) { /* ignore */ }
  if (!s || typeof s !== "object") s = {};
  return { light: s.light || DEFAULT_THEME_ID, dark: s.dark || DEFAULT_THEME_ID };
}
let themeSelection = loadSelection();
function saveSelection() { localStorage.setItem(THEME_SELECTION_KEY, JSON.stringify(themeSelection)); }
let refreshThemeUI = () => {}; // reassigned by the picker UI once the DOM is wired

const prefersDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
function activeThemeId() { return prefersDark() ? themeSelection.dark : themeSelection.light; }

// Push a theme's tokens to <html> (for the CSS/HTML UI) and into the JS render
// palette (for the SVG chart). Plan-DATA colors are untouched.
function applyThemeColors(t) {
  const tk = t.tokens || {};
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(tk)) root.setProperty(k, v);
  document.documentElement.setAttribute("data-theme", t.id || "");
  document.documentElement.setAttribute("data-appearance", t.appearance || "");
  BACKGROUND = tk["--bg"]; TEXT = tk["--fg"]; HEADING = tk["--heading"]; LABEL = tk["--label"];
  FAINT = tk["--faint"]; MUTED_TEXT = tk["--muted"]; GRID_COLOR = tk["--grid"]; RULE = tk["--rule"];
  TODAY_COLOR = tk["--today"]; DANGER = tk["--danger"]; DRAG_HL = tk["--accent"];
  DEP_COLOR = tk["--dep"]; DEP_HL = tk["--dep-hl"]; HIST_LINE = tk["--hist-line"];
  if (Array.isArray(t.barPalette) && t.barPalette.length) WORKSTREAM_COLORS = t.barPalette;
}
function applyActiveTheme(rerender = true) {
  const t = themeById(activeThemeId()) || themeById(DEFAULT_THEME_ID) || BUILTIN_THEMES[0];
  applyThemeColors(t);
  if (rerender && model) { try { renderFromModel(); } catch (e) { /* invalid model mid-edit */ } if (vizOpen) renderViz(); }
  refreshThemeUI();
}
// Live-update when the OS flips light/dark.
if (window.matchMedia) {
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyActiveTheme()); }
  catch (e) { /* older Safari */ }
}

const STORAGE_KEY = "plantt-json-legacy"; // legacy key, migrated into a plan on first load
// Open a plan: shared #hash (by uuid) > current-plan pointer > most-recent > built-in default.
// This sets the globals: model, history, currentPlan, showTodayLine, compactMode.
const hashState = location.hash.length > 1 ? decodeState(location.hash.slice(1)) : null;
bootstrapPlans(hashState);
applyActiveTheme(false); // set the palette + CSS vars before the first paint
cm.setValue(JSON.stringify(model, null, 2)); // explicit loadModelFromText below does the first render

let debounceTimer = null;
cm.on("change", function () {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function () {
    if (programmaticChange) { programmaticChange = false; return; } // ignore our own writes
    loadModelFromText(cm.getValue());
  }, 300);
});

// Text edits coalesce into ONE history node per editing session: capture a baseline
// on focus, record the structural diff on blur (after flushing the pending debounce).
cm.on("focus", function () { if (!isTimeTraveling) editorBaseline = clone(model); });
cm.on("blur", flushEditorSession);
window.addEventListener("pagehide", flushEditorSession);          // never-blurred session safety net
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "hidden") flushEditorSession();
});

// ─── Editor Panel Toggle ─────────────────────────────────────────
const panel = document.getElementById("editor-panel");

function togglePanel() {
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
    setTimeout(function () { cm.refresh(); }, 260);
  }
  adjustChartPadding();
}

function closePanel() {
  panel.classList.remove("open");
  adjustChartPadding();
}

function adjustChartPadding() {
  if (panel.classList.contains("open")) {
    container.style.paddingBottom = panel.offsetHeight + "px";
  } else {
    container.style.paddingBottom = "0";
  }
}

document.getElementById("close-btn").addEventListener("click", closePanel);

const depsBtn = document.getElementById("deps-btn");
applyDepsUI();
depsBtn.addEventListener("click", cycleDeps);

const todayToggle = document.getElementById("toggle-today");
todayToggle.checked = showTodayLine;
todayToggle.addEventListener("change", function () {
  showTodayLine = this.checked;
  localStorage.setItem(TODAY_KEY, showTodayLine ? "1" : "0");
  if (lastValidData) render(lastValidData);
  schedulePersist(); // saved with the plan; view toggles are excluded from undo AND the URL
});

const compactToggle = document.getElementById("toggle-compact");
compactToggle.checked = compactMode;
document.body.classList.toggle("compact-mode", compactMode);
compactToggle.addEventListener("change", function () {
  compactMode = this.checked;
  localStorage.setItem(COMPACT_KEY, compactMode ? "1" : "0");
  document.body.classList.toggle("compact-mode", compactMode);
  if (lastValidData) render(lastValidData);
  schedulePersist(); // saved with the plan; view toggles are excluded from undo AND the URL
});

// Mouse-following crosshair across the whole chart
container.addEventListener("mousemove", function (e) { updateCrosshair(e.clientX); });
container.addEventListener("mouseleave", hideCrosshair);

document.addEventListener("keydown", function (e) {
  if (e.ctrlKey && e.key === "\\") {
    e.preventDefault();
    togglePanel();
    return;
  }
  // Bare-key shortcuts must not fire while typing in the editor or a form field.
  const typing = cm.hasFocus() || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ""));
  const plainKey = !e.metaKey && !e.ctrlKey && !e.altKey;
  // ? → toggle keyboard & interaction help (don't fight other modals)
  if (e.key === "?" && !typing) {
    if (document.getElementById("modal-overlay") && !helpEl) return; // a different dialog is open
    e.preventDefault(); openHelpModal(); return;
  }
  // / → toggle the workstreams show/hide list
  if (e.key === "/" && plainKey && !typing) {
    if (document.getElementById("modal-overlay") && !wsModalEl) return;
    e.preventDefault(); openWorkstreamsModal(); return;
  }
  // c → toggle the compute-capacity section
  if ((e.key === "c" || e.key === "C") && plainKey && !typing && !document.getElementById("modal-overlay")) {
    e.preventDefault();
    showCapacity = !showCapacity;
    if (lastValidData) render(lastValidData);
    schedulePersist();
    setStatus(showCapacity ? "Capacity shown" : "Capacity hidden", false);
    return;
  }
  // d → toggle the dependency arrows overlay
  if ((e.key === "d" || e.key === "D") && plainKey && !typing && !document.getElementById("modal-overlay")) {
    e.preventDefault();
    cycleDeps();
    return;
  }
  // Ctrl+Y → history visualizer (note: this deliberately overrides Windows' redo)
  if (e.ctrlKey && !e.metaKey && (e.key === "y" || e.key === "Y")) { e.preventDefault(); openHistoryViz(); return; }
  // Ctrl+O → plans manager
  if (e.ctrlKey && !e.metaKey && (e.key === "o" || e.key === "O")) { e.preventDefault(); openPlansModal(); return; }
  // Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z redo — but let CodeMirror own undo while it has focus,
  // and don't fight an open modal/visualizer.
  if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
    if (cm.hasFocus()) return;
    if (document.getElementById("modal-overlay")) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
});

// ─── Panel Resizer ───────────────────────────────────────────────
const resizer = document.getElementById("panel-resizer");
let isResizing = false;

resizer.addEventListener("mousedown", function (e) {
  e.preventDefault();
  isResizing = true;
  document.body.style.cursor = "ns-resize";
  document.body.style.userSelect = "none";
});

document.addEventListener("mousemove", function (e) {
  if (!isResizing) return;
  const newHeight = window.innerHeight - e.clientY;
  const clamped = Math.max(120, Math.min(newHeight, window.innerHeight - 80));
  panel.style.height = clamped + "px";
  panel.style.transition = "none";
  cm.refresh();
  adjustChartPadding();
});

document.addEventListener("mouseup", function () {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    panel.style.transition = "";
    if (lastValidData) {
      render(lastValidData);
    }
  }
});

// ─── Window Resize ───────────────────────────────────────────────
let resizeTimer = null;
window.addEventListener("resize", function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    if (lastValidData) render(lastValidData);
    adjustChartPadding();
  }, 200);
});

// ─── History / plans toolbar wiring ──────────────────────────────
document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("redo-btn").addEventListener("click", redo);
document.getElementById("history-btn").addEventListener("click", openHistoryViz);
document.getElementById("plans-btn").addEventListener("click", openPlansModal);
document.getElementById("help-btn").addEventListener("click", openHelpModal);

// ─── Initial Render ──────────────────────────────────────────────
loadModelFromText(cm.getValue());
persistPlan();            // ensure the opened plan (incl. any migration/seed) is stored
updateHistoryButtons();
if (!lastValidData) {
  panel.classList.add("open");
  setTimeout(function () { cm.refresh(); }, 260);
  adjustChartPadding();
}

// Expose the (serializable) history tree for inspection / future visualization.
window.__history = exportHistory;

// ─── Remote control ────────────────────────────────────────────────
// A small programmatic surface + an optional poller that lets a local tool drive
// the active plan. Enabled only with ?agent=1, so a normal visit exposes nothing
// reachable. The page POLLS a localhost relay (it cannot listen itself); the relay
// is run by the external tool. Edits go through the same internals as manual ones,
// so undo/redo, the editor, the URL and persistence all stay consistent.
// ── helpers shared by the granular ops (all operate on a passed-in model `m`) ──
function _wsByName(m, name) {
  const ws = m.workstreams.find((w) => w.name === name);
  if (!ws) throw new Error(`No workstream named "${name}"`);
  return ws;
}
function _findItem(m, name) {
  for (const ws of m.workstreams) {
    let i = ws.tasks.findIndex((t) => t.name === name);
    if (i >= 0) return { ws, arr: ws.tasks, idx: i, item: ws.tasks[i], kind: "task" };
    if (ws.milestones) {
      i = ws.milestones.findIndex((x) => x.name === name);
      if (i >= 0) return { ws, arr: ws.milestones, idx: i, item: ws.milestones[i], kind: "milestone" };
    }
  }
  return null;
}
function _requireItem(m, name) {
  const f = _findItem(m, name);
  if (!f) throw new Error(`No task or milestone named "${name}"`);
  return f;
}
function _allItems(m) {
  const out = [];
  for (const ws of m.workstreams) { for (const t of ws.tasks) out.push(t); if (ws.milestones) for (const x of ws.milestones) out.push(x); }
  return out;
}
function _repointDeps(m, oldName, newName) {
  for (const it of _allItems(m)) if (Array.isArray(it.deps)) it.deps = it.deps.map((d) => (d === oldName ? newName : d));
}
function _stripDep(m, name) {
  for (const it of _allItems(m)) if (Array.isArray(it.deps)) it.deps = it.deps.filter((d) => d !== name);
}
function _capIndex(m, name) {
  const i = (m.capacity || []).findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`No capacity named "${name}"`);
  return i;
}
function _clusterIndex(m, label) {
  const i = (m.clusters || []).findIndex((c) => c.label === label);
  if (i < 0) throw new Error(`No cluster labelled "${label}"`);
  return i;
}
function _mergeSet(obj, set) { for (const k of Object.keys(set || {})) { if (set[k] === null) delete obj[k]; else obj[k] = set[k]; } }

// Apply ONE op to model `m` (mutates it). Throws on any problem; the batch aborts.
function _applyOp(m, op) {
  switch (op.op) {
    // — milestones & tasks (activities) —
    case "addMilestone": {
      const ws = _wsByName(m, op.workstream); if (!ws.milestones) ws.milestones = [];
      if (!op.milestone || !op.milestone.name) throw new Error("addMilestone needs milestone.name");
      ws.milestones.push(op.milestone); break;
    }
    case "addTask": {
      const ws = _wsByName(m, op.workstream);
      if (!op.task || !op.task.name) throw new Error("addTask needs task.name");
      ws.tasks.push(op.task); break;
    }
    case "update": {
      const f = _requireItem(m, op.name);
      if (op.set && "name" in op.set) throw new Error("use op 'rename' to change a name (it repoints deps)");
      _mergeSet(f.item, op.set); break;
    }
    case "rename": {
      const f = _requireItem(m, op.name); if (!op.to) throw new Error("rename needs 'to'");
      if (_findItem(m, op.to)) throw new Error(`"${op.to}" already exists`);
      f.item.name = op.to; _repointDeps(m, op.name, op.to); break;
    }
    case "setDeps": { _requireItem(m, op.name).item.deps = op.deps || []; break; }
    case "remove": { const f = _requireItem(m, op.name); f.arr.splice(f.idx, 1); _stripDep(m, op.name); break; }
    case "moveTask": {
      const f = _requireItem(m, op.name); if (f.kind !== "task") throw new Error(`"${op.name}" is not a task`);
      const dest = _wsByName(m, op.toWorkstream); f.arr.splice(f.idx, 1); dest.tasks.push(f.item); break;
    }
    // — workstreams —
    case "addWorkstream": {
      const w = op.workstream || { name: op.name, note: op.note };
      if (!w.name) throw new Error("addWorkstream needs a name");
      if (m.workstreams.some((x) => x.name === w.name)) throw new Error(`Workstream "${w.name}" already exists`);
      if (!Array.isArray(w.tasks)) w.tasks = []; m.workstreams.push(w); break;
    }
    case "renameWorkstream": { const ws = _wsByName(m, op.name); if (!op.to) throw new Error("renameWorkstream needs 'to'"); ws.name = op.to; break; }
    case "updateWorkstream": {
      const ws = _wsByName(m, op.name);
      if (op.set && "name" in op.set) throw new Error("use op 'renameWorkstream' to change a workstream name");
      _mergeSet(ws, op.set); break;
    }
    case "removeWorkstream": {
      const idx = m.workstreams.findIndex((w) => w.name === op.name);
      if (idx < 0) throw new Error(`No workstream named "${op.name}"`);
      const ws = m.workstreams[idx];
      const gone = [...ws.tasks.map((t) => t.name), ...(ws.milestones || []).map((x) => x.name)];
      m.workstreams.splice(idx, 1); for (const n of gone) _stripDep(m, n); break;
    }
    case "moveWorkstream": {
      const idx = m.workstreams.findIndex((w) => w.name === op.name);
      if (idx < 0) throw new Error(`No workstream named "${op.name}"`);
      const [ws] = m.workstreams.splice(idx, 1);
      const to = Math.max(0, Math.min(m.workstreams.length, op.toIndex | 0)); m.workstreams.splice(to, 0, ws); break;
    }
    // — capacity (compute) — tasks reference these by `cluster` (= capacity.name) —
    case "addCapacity": {
      if (!m.capacity) m.capacity = [];
      if (!op.capacity || !op.capacity.name) throw new Error("addCapacity needs capacity.name");
      if (m.capacity.some((c) => c.name === op.capacity.name)) throw new Error(`Capacity "${op.capacity.name}" already exists`);
      m.capacity.push(op.capacity); break;
    }
    case "updateCapacity": {
      const i = _capIndex(m, op.name);
      if (op.set && "name" in op.set) throw new Error("use op 'renameCapacity' (it repoints task.cluster refs)");
      _mergeSet(m.capacity[i], op.set); break;
    }
    case "renameCapacity": {
      const i = _capIndex(m, op.name); if (!op.to) throw new Error("renameCapacity needs 'to'");
      const old = m.capacity[i].name; m.capacity[i].name = op.to;
      for (const it of _allItems(m)) if (it.cluster === old) it.cluster = op.to; break;
    }
    case "removeCapacity": {
      const i = _capIndex(m, op.name); const cname = m.capacity[i].name; m.capacity.splice(i, 1);
      for (const it of _allItems(m)) if (it.cluster === cname) delete it.cluster; break; // drop now-dangling refs
    }
    // — clusters (vertical date markers) — addressed by label —
    case "addCluster": {
      if (!m.clusters) m.clusters = [];
      if (!op.cluster || !op.cluster.label) throw new Error("addCluster needs cluster.label");
      m.clusters.push(op.cluster); break;
    }
    case "updateCluster": { _mergeSet(m.clusters[_clusterIndex(m, op.label)], op.set); break; }
    case "removeCluster": { m.clusters.splice(_clusterIndex(m, op.label), 1); break; }
    // — plan-level fields (title, note) —
    case "setPlan": { _mergeSet(m, op.set); break; }
    default: throw new Error(`Unknown op: "${op.op}"`);
  }
}
function _summarizeOps(ops) {
  const c = {}; for (const o of ops) c[o.op] = (c[o.op] || 0) + 1;
  return "Remote: " + Object.entries(c).map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(", ");
}

window.plantt = {
  version: 2,
  // Self-describing contract (model shape, DSL semantics, op vocabulary, a valid
  // example). Served by the relay at GET /schema so a remote LLM needs no repo.
  describe() {
    return {
      version: 2, schema: SCHEMA, ops: OPS, example: EXAMPLE,
      themes: {
        tokens: TOKENS, // [[--name, description], …] every theme must define
        note: "Themes are local-only (localStorage), follow the OS light/dark preference, and bind " +
          "one theme to each system slot. Manage via window.plantt.themes / the relay /theme* endpoints.",
      },
    };
  },
  // ── reads ──
  getState() {
    return { uuid: currentPlan ? currentPlan.uuid : null, name: currentPlan ? currentPlan.name : null, model: clone(model) };
  },
  // Compact "what exists" view — names, deps, dates only (no tooltips/notes/significance).
  outline() {
    return {
      title: model.title, name: currentPlan ? currentPlan.name : null,
      workstreams: model.workstreams.map((ws) => ({
        name: ws.name,
        tasks: ws.tasks.map((t) => ({ name: t.name, start: t.start, end: t.end, cluster: t.cluster, deps: t.deps || [] })),
        milestones: (ws.milestones || []).map((m) => ({ name: m.name, date: m.date, emoji: m.emoji, deps: m.deps || [] })),
      })),
      capacity: (model.capacity || []).map((c) => ({ name: c.name, chip: c.chip, chips: c.chips, from: c.from, to: c.to })),
      clusters: (model.clusters || []).map((c) => ({ label: c.label, date: c.date })),
    };
  },
  get(name) { const f = _findItem(model, name); return f ? clone(f.item) : null; },
  getDeps(name) { const f = _findItem(model, name); return f ? (f.item.deps || []).slice() : null; },      // its prerequisites
  getDependents(name) { return _allItems(model).filter((it) => Array.isArray(it.deps) && it.deps.includes(name)).map((it) => it.name); }, // who needs it
  // ── writes ──
  // Replace the whole model. Validates first; on failure the live plan is untouched.
  setModel(next, summary) {
    try {
      validate(next); model = next;
      recordChange({ source: "remote", verb: "replace", details: { label: summary || "Remote edit" } });
      commitModel(); return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  // Apply a batch of name-addressed ops atomically → ONE undo node. All-or-nothing:
  // any op error (or a final validate failure) aborts the whole batch, plan untouched.
  apply(ops, summary) {
    if (!Array.isArray(ops)) return { ok: false, error: "apply(ops) expects an array" };
    const work = clone(model);
    try {
      ops.forEach((op, i) => { try { _applyOp(work, op); } catch (e) { throw new Error(`op[${i}] (${op && op.op}): ${e.message}`); } });
      validate(work);
    } catch (e) { return { ok: false, error: e.message }; }
    model = work;
    recordChange({ source: "remote", verb: "replace", details: { label: summary || _summarizeOps(ops) } });
    commitModel();
    return { ok: true, applied: ops.length };
  },
  // ── themes (local-only; follow the OS light/dark preference) ──
  themes: {
    tokens() { return TOKENS; }, // [[--name, description], …] — what a theme must define
    list() { return allThemes().map((t) => ({ id: t.id, name: t.name, appearance: t.appearance, builtin: !!t.builtin })); },
    current() { return { light: themeSelection.light, dark: themeSelection.dark, active: activeThemeId(), appearance: prefersDark() ? "dark" : "light" }; },
    get(id) {
      const t = themeById(id);
      return t ? { id: t.id, name: t.name, appearance: t.appearance, tokens: t.tokens, barPalette: t.barPalette || null, builtin: !!t.builtin } : null;
    },
    // Bind a theme to the system light or dark slot.
    set(slot, id) {
      if (slot !== "light" && slot !== "dark") return { ok: false, error: 'slot must be "light" or "dark"' };
      if (!themeById(id)) return { ok: false, error: "unknown theme id: " + id };
      themeSelection[slot] = id; saveSelection(); applyActiveTheme();
      return { ok: true, current: window.plantt.themes.current() };
    },
    // Add custom theme(s): a theme object, a JSON string, an array, or {themes:[…]}.
    import(input) {
      let data = input;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return { ok: false, error: "invalid JSON: " + e.message }; } }
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.themes) ? data.themes : [data]);
      const custom = loadCustomThemes(); const added = [];
      for (const one of list) {
        const v = validateTheme(one); if (!v.ok) return { ok: false, error: (one && one.id ? one.id + ": " : "") + v.error };
        const clean = { id: one.id, name: one.name, appearance: one.appearance || "light", tokens: one.tokens, barPalette: one.barPalette || null };
        const i = custom.findIndex((c) => c.id === one.id);
        if (i >= 0) custom[i] = clean; else custom.push(clean);
        added.push(one.id);
      }
      saveCustomThemes(custom); applyActiveTheme();
      return { ok: true, added };
    },
    export(id) {
      const t = themeById(id); if (!t) return { ok: false, error: "unknown theme id: " + id };
      return { ok: true, theme: { id: t.id, name: t.name, appearance: t.appearance, tokens: t.tokens, barPalette: t.barPalette || null } };
    },
    exportAll() { return { ok: true, themes: loadCustomThemes() }; }, // custom only — built-ins ship with the app
    remove(id) {
      const custom = loadCustomThemes(); const i = custom.findIndex((c) => c.id === id);
      if (i < 0) return { ok: false, error: "no custom theme: " + id };
      custom.splice(i, 1); saveCustomThemes(custom);
      let changed = false;
      for (const slot of ["light", "dark"]) if (themeSelection[slot] === id) { themeSelection[slot] = DEFAULT_THEME_ID; changed = true; }
      if (changed) saveSelection();
      applyActiveTheme();
      return { ok: true };
    },
  },
};

// ─── Theme picker UI (palette button + popover) ──────────────────────
(function initThemeUI() {
  const btn = document.getElementById("theme-btn");
  const pop = document.getElementById("theme-popover");
  if (!btn || !pop) return;
  const selLight = document.getElementById("theme-light");
  const selDark = document.getElementById("theme-dark");
  const activeLbl = document.getElementById("theme-active");
  const importArea = document.getElementById("theme-import-area");
  const importText = document.getElementById("theme-import-text");
  const importFile = document.getElementById("theme-import-file");
  const importMsg = document.getElementById("theme-import-msg");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function optionsHTML(selectedId) {
    const all = allThemes();
    const opt = (t) => `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`;
    const std = all.filter((t) => t.builtin), cust = all.filter((t) => !t.builtin);
    let h = `<optgroup label="Standard">${std.map(opt).join("")}</optgroup>`;
    if (cust.length) h += `<optgroup label="Imported">${cust.map(opt).join("")}</optgroup>`;
    return h;
  }
  // Reassign the module-level hook so applyActiveTheme() keeps the UI in sync.
  refreshThemeUI = function () {
    selLight.innerHTML = optionsHTML(themeSelection.light);
    selDark.innerHTML = optionsHTML(themeSelection.dark);
    const t = themeById(activeThemeId());
    const mode = prefersDark() ? "dark" : "light";
    activeLbl.textContent = "Active: " + (t ? t.name : "—") + " · " + mode + " mode" + (t && !t.builtin ? " · imported" : "");
  };

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function doImport(text) {
    const r = window.plantt.themes.import(text);
    importMsg.textContent = r.ok ? "Added: " + r.added.join(", ") : "Error: " + r.error;
    importMsg.style.color = r.ok ? "var(--muted)" : "var(--danger)";
    if (r.ok) { importText.value = ""; refreshThemeUI(); }
  }

  selLight.addEventListener("change", () => window.plantt.themes.set("light", selLight.value));
  selDark.addEventListener("change", () => window.plantt.themes.set("dark", selDark.value));
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) refreshThemeUI(); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) pop.hidden = true; });
  document.getElementById("theme-import-btn").addEventListener("click", () => { importArea.hidden = !importArea.hidden; importMsg.textContent = ""; });
  document.getElementById("theme-export-btn").addEventListener("click", () => {
    const r = window.plantt.themes.export(activeThemeId());
    if (r.ok) downloadJSON(r.theme.id + ".plantt-theme.json", r.theme);
  });
  document.getElementById("theme-export-all-btn").addEventListener("click", () => {
    downloadJSON("plantt-themes.json", { themes: window.plantt.themes.exportAll().themes });
  });
  document.getElementById("theme-import-apply").addEventListener("click", () => doImport(importText.value));
  importFile.addEventListener("change", () => {
    const f = importFile.files && importFile.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => doImport(String(reader.result));
    reader.readAsText(f);
  });
  refreshThemeUI();
})();

(function initRemoteControl() {
  const params = new URLSearchParams(location.search);
  if (!params.get("agent")) return;        // opt-in only
  const relay = (params.get("relay") || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stop = false;
  window.addEventListener("pagehide", () => { stop = true; });

  // Tiny connection badge so it's obvious the page is under remote control.
  const badge = document.createElement("div");
  badge.id = "remote-badge";
  badge.style.cssText =
    "position:fixed;bottom:10px;right:10px;z-index:9999;font:11px/1.4 ui-monospace,monospace;" +
    "padding:4px 8px;border-radius:10px;background:#222;color:#ddd;opacity:.85;user-select:none;";
  const setBadge = (txt, color) => { badge.textContent = "● remote: " + txt; badge.style.color = color; };
  setBadge("connecting…", "#e6b800");
  document.body.appendChild(badge);

  function run(cmd) {
    const P = window.plantt;
    switch (cmd.type) {
      case "describe":      return { ok: true, data: P.describe() };
      case "getState":      return { ok: true, data: P.getState() };
      case "outline":       return { ok: true, data: P.outline() };
      case "get":           return { ok: true, data: P.get(cmd.name) };
      case "getDeps":       return { ok: true, data: P.getDeps(cmd.name) };
      case "getDependents": return { ok: true, data: P.getDependents(cmd.name) };
      case "setModel":      return P.setModel(cmd.model, cmd.summary);
      case "apply":         return P.apply(cmd.ops, cmd.summary);
      case "themes.list":     return { ok: true, data: P.themes.list() };
      case "themes.current":  return { ok: true, data: P.themes.current() };
      case "themes.get":      return { ok: true, data: P.themes.get(cmd.themeId) };
      case "themes.set":      return P.themes.set(cmd.slot, cmd.themeId);
      case "themes.import":   return P.themes.import(cmd.theme);
      case "themes.export":   return cmd.themeId ? P.themes.export(cmd.themeId) : P.themes.exportAll();
      case "themes.remove":   return P.themes.remove(cmd.themeId);
      default:              return { ok: false, error: "unknown command type: " + cmd.type };
    }
  }

  async function loop() {
    while (!stop) {
      let commands = [];
      try {
        const r = await fetch(relay + "/poll", { method: "GET" }); // long-poll
        commands = r.ok ? ((await r.json()).commands || []) : [];
        setBadge(commands.length ? "working…" : "connected", "#3ea66b");
      } catch (e) {
        setBadge("offline", "#c0392b");      // relay down (e.g. tool finished + killed it)
        await sleep(2000);
        continue;
      }
      const results = commands.map((c) => ({ id: c.id, ...run(c) }));
      // Always echo fresh state back, so the relay's /state is current after every cycle.
      try {
        await fetch(relay + "/ack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ results, state: window.plantt.getState() }),
        });
      } catch (e) { /* relay vanished mid-cycle; next /poll handles the offline state */ }
    }
  }
  loop();
})();

// Reconcile a shared URL version against the local tree (load / graft / detached + toast).
processPendingImport();

// Pasting a shared link into the running tab only changes the #fragment (no reload), so
// reconcile on hashchange too. Our own writes use replaceState, which does NOT fire this.
window.addEventListener("hashchange", function () {
  const hs = location.hash.length > 1 ? decodeState(location.hash.slice(1)) : null;
  if (!hs || !hs.uuid) return;
  if (currentPlan && hs.uuid === currentPlan.uuid) {
    pendingImport = computeImport(hs);
    processPendingImport();
  } else {
    location.reload(); // a different plan → let bootstrap handle the switch cleanly
  }
});

})();
