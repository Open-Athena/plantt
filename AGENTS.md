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

## Remote control

`window.plantt` (gated behind `?agent=1`) is the on-page API: `describe`, `getState`, `outline`,
`get`, `getDeps`, `getDependents`, `setModel`, and the atomic `apply(ops)`. The
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
