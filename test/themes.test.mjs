// Anti-drift test for the theme registry. Pure Node. Run via `npm test`.
import { BUILTIN_THEMES, TOKENS, TOKEN_NAMES, DEFAULT_THEME_ID, validateTheme } from "../src/themes.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

ok("TOKENS is a non-empty [name, desc] list", Array.isArray(TOKENS) && TOKENS.length > 0 && TOKENS.every((t) => Array.isArray(t) && t.length === 2));
ok("TOKEN_NAMES matches TOKENS", TOKEN_NAMES.length === TOKENS.length && TOKEN_NAMES.every((n, i) => n === TOKENS[i][0]));

// every built-in must validate and define every token
for (const t of BUILTIN_THEMES) {
  const v = validateTheme(t);
  const missing = TOKEN_NAMES.filter((k) => !(k in (t.tokens || {})));
  ok(`theme "${t.id}" valid + complete`, v.ok && missing.length === 0, v.ok ? (missing.length ? "missing: " + missing.join(", ") : "") : v.error);
  ok(`theme "${t.id}" has a barPalette`, Array.isArray(t.barPalette) && t.barPalette.length > 0);
  ok(`theme "${t.id}" appearance is light|dark`, t.appearance === "light" || t.appearance === "dark");
}

// ids unique
const ids = BUILTIN_THEMES.map((t) => t.id);
ok("theme ids are unique", new Set(ids).size === ids.length, ids.join(", "));

// the default exists
ok(`DEFAULT_THEME_ID "${DEFAULT_THEME_ID}" exists`, ids.includes(DEFAULT_THEME_ID));

// validateTheme rejects bad input
ok("validateTheme rejects missing tokens", !validateTheme({ id: "x", name: "X", tokens: {} }).ok);
ok("validateTheme rejects non-object", !validateTheme(null).ok);
ok("validateTheme rejects bad barPalette", !validateTheme({ id: "x", name: "X", tokens: Object.fromEntries(TOKEN_NAMES.map((k) => [k, "#000"])), barPalette: "nope" }).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
