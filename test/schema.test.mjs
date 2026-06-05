// Anti-drift test for the plan data model. Pure Node (no browser): imports the
// single-source schema module and cross-checks it against main.js. Run: `npm test`.
import { validate, SCHEMA, OPS, EXAMPLE } from "../src/schema.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// 1) The documented EXAMPLE must actually be valid.
ok("EXAMPLE passes validate()", !throws(() => validate(EXAMPLE)));

// 2) validate() rejects the core invariant violations it documents.
ok("rejects missing workstreams", throws(() => validate({})));
ok("rejects duplicate names", throws(() => validate({
  workstreams: [{ name: "W", tasks: [{ name: "dup" }, { name: "dup" }] }],
})));
ok("rejects dep on unknown item", throws(() => validate({
  workstreams: [{ name: "W", tasks: [{ name: "A", deps: ["ghost"] }] }],
})));
ok("accepts a workstream with empty tasks", !throws(() => validate({
  workstreams: [{ name: "W", tasks: [] }],
})));

// 3) The op vocabulary in OPS must EXACTLY match the cases _applyOp() handles.
const src = readFileSync(join(ROOT, "src/main.js"), "utf8");
const fnStart = src.indexOf("function _applyOp(m, op)");
const fnEnd = src.indexOf("function _summarizeOps", fnStart);
if (fnStart < 0 || fnEnd < 0) { ok("located _applyOp in main.js", false); }
else {
  const body = src.slice(fnStart, fnEnd);
  const handled = new Set([...body.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]));
  const documented = new Set(Object.keys(OPS));
  const undocumented = [...handled].filter((x) => !documented.has(x));
  const unhandled = [...documented].filter((x) => !handled.has(x));
  ok("located _applyOp in main.js", true);
  ok("every handled op is documented in OPS", undocumented.length === 0, undocumented.length ? "missing from OPS: " + undocumented.join(", ") : "");
  ok("every documented op is handled by _applyOp", unhandled.length === 0, unhandled.length ? "missing from _applyOp: " + unhandled.join(", ") : "");
  ok("op count matches", handled.size === documented.size, `_applyOp=${handled.size} OPS=${documented.size}`);
}

// 4) SCHEMA shape sanity — the pieces describe() ships and the skill mirrors.
ok("SCHEMA has fields/task/milestone/rules", !!(SCHEMA.fields && SCHEMA.task && SCHEMA.milestone && Array.isArray(SCHEMA.rules)));
ok("SCHEMA.chips is a non-empty list", Array.isArray(SCHEMA.chips) && SCHEMA.chips.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
