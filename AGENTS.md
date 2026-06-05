# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What plantt is

A single-page, front-end-only Gantt planner for AI/compute roadmaps. The entire app is
`src/main.js` (an IIFE bundled by Vite); there is **no backend**. A plan is one JSON
document; the running app is the source of truth and can be driven remotely.

## The plan data model has ONE source of truth: `src/schema.js`

`src/schema.js` exports `validate()`, `SCHEMA`, `OPS`, and `EXAMPLE`. It is imported by:

- **the app** — `src/main.js` uses `validate()` on every edit and ships `SCHEMA`/`OPS`/`EXAMPLE`
  via `window.plantt.describe()` (served to remote callers at the relay's `GET /schema`);
- **the test** — `test/schema.test.mjs` cross-checks it against the code;
- **the skill docs** — `.claude/skills/plantt-remote/SKILL.md` mirrors it for offline reading.

Because three consumers read one module, the contract can't silently drift — *as long as you
keep `src/schema.js` honest*.

### If you change the model, the DSL, or the op vocabulary — do ALL of this:

1. Update `src/schema.js` (`SCHEMA` / `OPS` / `EXAMPLE`, and `validate()` if invariants changed).
2. If you added/removed/renamed an `apply` op, update `_applyOp()` in `src/main.js`. The op set in
   `OPS` must exactly equal the `case` labels in `_applyOp()` — the test enforces this.
3. Update the "Plan model schema" + op tables in `.claude/skills/plantt-remote/SKILL.md` to match.
4. Run **`npm test`** (it must pass) and **`npm run build`** (must succeed).

`npm test` is pure Node (no browser) and runs in CI before every Pages deploy, so drift between
`src/schema.js` and `_applyOp()` will fail the build.

## Themes have ONE source of truth: `src/themes.js`

`src/themes.js` exports `BUILTIN_THEMES`, `TOKENS`/`TOKEN_NAMES` (the canonical CSS-variable set),
`DEFAULT_THEME_ID`, and `validateTheme()`. Themes are local-only (localStorage), follow the OS
light/dark preference, and are exposed via `window.plantt.themes` + the relay `/theme*` endpoints.

### If you add/change a theme or token:
1. A token must exist in **three** places kept in lockstep: `TOKENS` (src/themes.js), the `:root`
   defaults + `var(--x)` usages in `style.css`, and the `applyThemeColors()` assignment in
   `src/main.js` (for the SVG render palette). Every built-in theme must define every token.
2. Run **`npm test`** — `test/themes.test.mjs` asserts every built-in is valid and complete.
3. Keep the built-in id list in `.claude/skills/plantt-remote/SKILL.md` current.

Plan-DATA colors (`cluster.color`, `capacity.color`, `milestone.line`) are deliberately NOT themed.

## Remote control

`window.plantt` (gated behind `?agent=1`) is the on-page API: `describe`, `getState`, `outline`,
`get`, `getDeps`, `getDependents`, `setModel`, the atomic `apply(ops)`, and the `themes` namespace
(`list`/`current`/`set`/`import`/`export`/`remove`). NOTE: relay commands that carry a payload field
must NOT name it `id` — `enqueue()` overwrites `cmd.id` with the command counter (theme commands use
`themeId`). The
`.claude/skills/plantt-remote/relay.mjs` localhost bridge exposes these over HTTP. Keep the relay
endpoints, the poller `run()` switch in `src/main.js`, and `window.plantt` in sync with each other.

## Conventions

- Match the surrounding code style in `src/main.js` (terse, comment-the-why, no framework).
- Don't add a build/runtime dependency without good reason; the app ships `lz-string` only.
- The default plan (`DEFAULT_DATA` in `src/main.js`) must stay **generic demo data** — no real
  internal roadmaps, since the site is public.

## Commands

```bash
npm run dev      # local dev server (http://localhost:5173)
npm test         # schema/op consistency test — run after any model change
npm run build    # production build → dist/
```
