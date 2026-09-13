// Pure, name-addressed plan ops. Runs in the browser (window.plantt.apply) AND in the
// Pages Functions Worker (/api/plans/:id/apply), so there is exactly ONE implementation
// of every op. No DOM, no globals: every function takes the model `m` it operates on.
//
// The op set here must exactly equal the keys of OPS in src/schema.js — `npm test`
// enforces it. If you add/rename an op: schema.js OPS, this switch, and the skill doc.

// ── helpers shared by the granular ops (all operate on a passed-in model `m`) ──
export function _wsByName(m, name) {
  const ws = m.workstreams.find((w) => w.name === name);
  if (!ws) throw new Error(`No workstream named "${name}"`);
  return ws;
}
export function _findItem(m, name) {
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
export function _requireItem(m, name) {
  const f = _findItem(m, name);
  if (!f) throw new Error(`No task or milestone named "${name}"`);
  return f;
}
export function _allItems(m) {
  const out = [];
  for (const ws of m.workstreams) { for (const t of ws.tasks) out.push(t); if (ws.milestones) for (const x of ws.milestones) out.push(x); }
  return out;
}
export function _repointDeps(m, oldName, newName) {
  for (const it of _allItems(m)) if (Array.isArray(it.deps)) it.deps = it.deps.map((d) => (d === oldName ? newName : d));
}
export function _stripDep(m, name) {
  for (const it of _allItems(m)) if (Array.isArray(it.deps)) it.deps = it.deps.filter((d) => d !== name);
}
export function _capIndex(m, name) {
  const i = (m.capacity || []).findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`No capacity named "${name}"`);
  return i;
}
export function _mergeSet(obj, set) { for (const k of Object.keys(set || {})) { if (set[k] === null) delete obj[k]; else obj[k] = set[k]; } }

// Apply ONE op to model `m` (mutates it). Throws on any problem; the batch aborts.
export function _applyOp(m, op) {
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
    case "moveCapacity": {
      const i = _capIndex(m, op.name); const [c] = m.capacity.splice(i, 1);
      const to = Math.max(0, Math.min(m.capacity.length, op.toIndex | 0));
      m.capacity.splice(to, 0, c); break;
    }
    // — annotations (dated band-edge markers) — addressed by index —
    case "addAnnotation": {
      if (!m.annotations) m.annotations = [];
      const a = op.annotation;
      if (!a || !a.text || !a.date || !a.target) throw new Error("addAnnotation needs annotation { text, date, target }");
      m.annotations.push(a); break;
    }
    case "updateAnnotation": {
      const a = (m.annotations || [])[op.index];
      if (!a) throw new Error(`No annotation at index ${op.index}`);
      _mergeSet(a, op.set); break;
    }
    case "removeAnnotation": {
      if (!Array.isArray(m.annotations) || !m.annotations[op.index]) throw new Error(`No annotation at index ${op.index}`);
      m.annotations.splice(op.index, 1); break;
    }
    // — plan-level fields (title, note) —
    case "setPlan": { _mergeSet(m, op.set); break; }
    default: throw new Error(`Unknown op: "${op.op}"`);
  }
}
export function _summarizeOps(ops) {
  const c = {}; for (const o of ops) c[o.op] = (c[o.op] || 0) + 1;
  return "Remote: " + Object.entries(c).map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(", ");
}
