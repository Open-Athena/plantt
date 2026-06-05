// ─── Plan data model: single source of truth ────────────────────────────────
//
// This module is the authoritative description of a plantt plan. It is imported
// by the app (src/main.js, for validate() and window.plantt.describe()) AND by
// the test (test/schema.test.mjs), so the runtime contract and the docs cannot
// silently drift. The remote-control relay serves describe() at GET /schema, so
// an LLM that only has the skill (not the repo) can fetch the current contract.
//
// If you change the model, the DSL, or the op vocabulary: update SCHEMA / OPS /
// EXAMPLE here (and _applyOp in main.js for ops), then run `npm test`.

// Structural invariants enforced at every edit. Throws on the first problem.
// NOTE: validate() only checks the hard invariants below. The richer DSL
// semantics (start/end forms, capacity windows) are documented in SCHEMA and
// resolved at render time by resolveSpans() in main.js — they're tolerant, not
// strictly validated here.
export function validate(data) {
  if (!data || typeof data !== "object") throw new Error("Root must be an object");
  if (!Array.isArray(data.workstreams)) throw new Error("'workstreams' must be an array");
  // Names must be unique across BOTH activities and milestones, since dependencies
  // reference items by name.
  const allNames = new Set();
  const dup = (n) => { throw new Error(`Duplicate name: '${n}' — names must be unique across activities and milestones`); };
  for (const ws of data.workstreams) {
    if (!ws.name) throw new Error("Every workstream needs a 'name'");
    if (!Array.isArray(ws.tasks)) throw new Error(`Workstream '${ws.name}': 'tasks' must be an array`);
    for (const t of ws.tasks) {
      if (!t.name) throw new Error(`A task in '${ws.name}' is missing a 'name'`);
      if (allNames.has(t.name)) dup(t.name);
      allNames.add(t.name);
    }
    if (ws.milestones) for (const m of ws.milestones) {
      if (!m.name) throw new Error(`A milestone in '${ws.name}' is missing a 'name'`);
      if (allNames.has(m.name)) dup(m.name);
      allNames.add(m.name);
    }
  }
  // deps must be arrays of known names.
  const checkDeps = (item) => {
    if (item.deps == null) return;
    if (!Array.isArray(item.deps)) throw new Error(`'${item.name}': 'deps' must be an array of names`);
    for (const d of item.deps) if (!allNames.has(d)) throw new Error(`'${item.name}' depends on unknown item: '${d}'`);
  };
  for (const ws of data.workstreams) {
    for (const t of ws.tasks) checkDeps(t);
    if (ws.milestones) for (const m of ws.milestones) checkDeps(m);
  }
}

// Human/LLM-readable description of the document shape and field semantics.
export const SCHEMA = {
  description:
    "A plantt plan: workstreams of tasks (activities) and milestones, scheduled across " +
    "named compute clusters. Names are unique across ALL tasks and milestones; dependencies " +
    "reference items by that name.",
  chips: ["H100", "H200", "B200", "A100", "v4p", "v5e", "v5p", "v6e"], // known accelerator types (FLOPs-scaled)
  fields: {
    title: "string — plan title",
    note: "string? — subtitle/description",
    annotations:
      "array? of dated markers pinned to a band edge: { text:string, date:'YYYY-MM-DD', " +
      "target:'<workstream name>'|'@compute' (the compute-capacity section), " +
      "edge:'top'|'bottom' (default 'bottom'), color?:'#hex' (defaults to the band colour), " +
      "icon?:string (default '↓') }. Free-form labels; NOT the compute pools (those are `capacity`).",
    capacity:
      "array? of compute pools (utilization lanes under the chart): { name:string (referenced " +
      "by a task's `cluster`), chip:<one of chips>, chips:number (initial count at `from`), " +
      "flops?:number (FLOP/s per chip; overrides the chip-type default), from:'YYYY-MM-DD', " +
      "to?:'YYYY-MM-DD' (retired/removed), color:'#hex', " +
      "grows?:[{date:'YYYY-MM-DD', to:number}] (each event sets the new TOTAL chip count — add or remove), note?:string }.",
    workstreams:
      "array (required) of { name:string, note?:string, tasks:[Task], milestones?:[Milestone] }.",
  },
  task: {
    name: "string — unique across all tasks AND milestones",
    start:
      "one of: '<taskName>' (start when that task ends) | ['date','YYYY-MM-DD'] | " +
      "['after','<taskName>',['days',N]] (N days after that task ends)",
    end: "duration from start: ['days'|'weeks'|'months', N] | ['date','YYYY-MM-DD']",
    significance: "number? — bar thickness in px (visual weight)",
    cluster: "string? — must match a capacity[].name; drives the utilization lanes",
    chips: "number? — chips this task uses from its cluster (defaults to the whole pool)",
    link: "url? — opens on bar click",
    tooltip: "markdown? — shown on hover",
    deps: "array? of item names — drawn as dependency arrows (red if violated)",
  },
  milestone: {
    name: "string — unique across all tasks AND milestones",
    date: "'YYYY-MM-DD'",
    emoji: "string? — shown instead of the diamond marker",
    line: "'#hex'? — draws a full-height vertical line in this color",
    tooltip: "markdown?",
    deps: "array? of item names",
  },
  rules: [
    "workstreams is required and an array; each workstream needs a name and a tasks array (may be empty).",
    "Every task/milestone needs a name; names are unique across all tasks AND milestones.",
    "deps must be arrays of names that exist somewhere in the plan.",
    "A task's cluster should reference an existing capacity[].name.",
  ],
};

// Op vocabulary for window.plantt.apply(ops). Each `op` here MUST be handled by
// _applyOp() in main.js (the test enforces this set equality).
export const OPS = {
  addTask: "{ workstream, task:{...} } — append a task to a workstream",
  addMilestone: "{ workstream, milestone:{...} } — append a milestone to a workstream",
  update: "{ name, set:{...} } — patch fields on a task/milestone (NOT name; use rename)",
  rename: "{ name, to } — rename a task/milestone; auto-repoints every dependent's deps",
  setDeps: "{ name, deps:[...] } — replace an item's deps",
  remove: "{ name } — delete a task/milestone; auto-strips it from all other deps",
  moveTask: "{ name, toWorkstream } — move a task to another workstream",
  addWorkstream: "{ workstream:{name,note?,tasks?,milestones?} } or { name, note? }",
  renameWorkstream: "{ name, to }",
  updateWorkstream: "{ name, set:{...} } — patch (NOT name; use renameWorkstream)",
  removeWorkstream: "{ name } — remove a workstream + its items; cleans deps referencing them",
  moveWorkstream: "{ name, toIndex } — reorder",
  addCapacity: "{ capacity:{...} } — add a compute pool",
  updateCapacity: "{ name, set:{...} } — patch (NOT name; use renameCapacity)",
  renameCapacity: "{ name, to } — rename a pool; repoints task.cluster refs",
  removeCapacity: "{ name } — remove a pool; drops now-dangling task.cluster refs",
  moveCapacity: "{ name, toIndex } — reorder a pool (lane order)",
  // — annotations (dated band-edge markers) — addressed by index into `annotations` —
  addAnnotation: "{ annotation:{ text, date, target:'<workstream>'|'@compute', edge?:'top'|'bottom', color?, icon? } }",
  updateAnnotation: "{ index, set:{...} }",
  removeAnnotation: "{ index }",
  setPlan: "{ set:{ title?, note? } } — plan-level fields",
};

// A minimal valid plan, used in describe() and asserted by the test to pass validate().
export const EXAMPLE = {
  title: "Example",
  annotations: [{ text: "Cluster A online", date: "2026-02-01", target: "@compute", edge: "bottom", icon: "↓" }],
  capacity: [{ name: "Cluster A", chip: "H100", chips: 128, from: "2026-02-01", color: "#5f7488" }],
  workstreams: [
    {
      name: "Build",
      tasks: [
        { name: "Foundations", start: ["date", "2026-02-03"], end: ["weeks", 3], cluster: "Cluster A" },
        { name: "Service v1", start: ["after", "Foundations", ["days", 3]], end: ["weeks", 6], cluster: "Cluster A", deps: ["Foundations"] },
      ],
      milestones: [
        { name: "Launch", date: "2026-05-01", emoji: "🚀", deps: ["Service v1"] },
      ],
    },
  ],
};
