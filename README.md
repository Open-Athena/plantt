# plantt

A small, single-page Gantt / planning tool for compute-and-training-style roadmaps:
workstreams of tasks with dependencies, milestones, and compute-capacity utilization
lanes rendered underneath. Tufte-flavored, no backend — the whole plan lives in a JSON
document you can edit inline, share via URL, and undo/redo through a history tree.

**Live:** https://open-athena.github.io/plantt/

## Features

- Direct-manipulation editing — drag to move/resize, snap, wire dependencies, edit via modal.
- A JSON editor (CodeMirror) as the source of truth, with live validation.
- Compute-capacity lanes: per-cluster utilization, FLOPs-scaled lane heights, over-subscription.
- Dependency arrows with a violations-only / all / off cycle.
- Undo/redo **history tree** (branches preserved), named plans, and shareable `#`-URLs.
- Capacity, today-line, compact (print) and workstream-visibility view controls.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/  (deployed to GitHub Pages by .github/workflows/deploy.yml)
```

The app is plain ES modules bundled by Vite; `src/main.js` is the whole app.

## Remote control (optional)

Loading the app with `?agent=1` lets a local tool drive the active plan over a small
localhost relay — see [`.claude/skills/plantt-remote`](.claude/skills/plantt-remote).
It exposes a `window.plantt` API (`getState`, `outline`, `getDeps`, `getDependents`,
`setModel`, and an atomic name-addressed `apply(ops)`); a normal visit (without
`?agent=1`) exposes nothing reachable.
