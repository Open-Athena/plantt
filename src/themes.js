// ─── Themes: single source of truth ─────────────────────────────────────────
//
// A theme is plain data: a map of semantic CSS custom properties (tokens) plus a
// bar palette and metadata. Applying a theme sets those tokens on <html>; the
// HTML UI reads them via var(--x) and the SVG chart reads the resolved values in
// JS (see applyThemeColors / re-render in main.js). Adding a theme — built-in or
// imported — is just adding one of these objects; no other code changes.
//
// Built-ins live here; user-imported themes have the SAME shape and live in
// localStorage. The relay serves describe() (incl. TOKENS) at GET /schema so a
// remote LLM knows exactly which tokens a theme must define.
//
// If you add a token, add it to TOKENS, give every built-in a value, wire it in
// applyThemeColors()/style.css, and run `npm test`.

// The canonical token set every theme must define. Order is display order.
export const TOKENS = [
  ["--bg",        "page background"],
  ["--surface",   "panels, modal, tooltip, button backgrounds"],
  ["--fg",        "primary text / titles / milestone diamonds"],
  ["--heading",   "section + workstream headings"],
  ["--label",     "task/milestone labels"],
  ["--faint",     "de-emphasized italic notes"],
  ["--muted",     "axis ticks, cluster names, secondary text"],
  ["--grid",      "vertical gridlines"],
  ["--rule",      "cluster/marker reference lines"],
  ["--border",    "panel/modal/button borders"],
  ["--accent",    "selection/drag highlight, links"],
  ["--today",     "today line"],
  ["--danger",    "violations, capacity over-subscription"],
  ["--dep",       "dependency arrows"],
  ["--dep-hl",    "highlighted dependency chain"],
  ["--hist-line", "history-tree edges"],
  ["--font-serif","body/serif font stack"],
  ["--font-mono", "monospace (editor, code, mono labels)"],
];
export const TOKEN_NAMES = TOKENS.map(([k]) => k);

const SERIF = '"ET Book", Palatino, "Palatino Linotype", Georgia, serif';
const MONO = '"SF Mono", Menlo, Consolas, monospace';

// Compact constructor: theme(id, name, appearance, tokenValues, barPalette).
// tokenValues omits fonts unless overridden (defaults to SERIF/MONO).
function theme(id, name, appearance, t, barPalette) {
  return {
    id, name, appearance,
    tokens: { "--font-serif": SERIF, "--font-mono": MONO, ...t },
    barPalette,
  };
}

export const BUILTIN_THEMES = [
  // — Tufte (the original look; default for both light and dark slots) —
  theme("tufte", "Tufte", "light", {
    "--bg": "#fffff8", "--surface": "#f4f1e8", "--fg": "#111111", "--heading": "#333333",
    "--label": "#444444", "--faint": "#999999", "--muted": "#888888", "--grid": "#cccccc",
    "--rule": "#555555", "--border": "#e0ddd4", "--accent": "#2b6cb0", "--today": "#c0392b",
    "--danger": "#c0392b", "--dep": "#97a0ac", "--dep-hl": "#5f7488", "--hist-line": "#d6d2c6",
  }, ["#b8c4cc", "#c4bab0", "#a8b8a0", "#c0b0c4", "#b0c0c4"]),

  // — Solarized —
  theme("solarized-light", "Solarized Light", "light", {
    "--bg": "#fdf6e3", "--surface": "#eee8d5", "--fg": "#586e75", "--heading": "#073642",
    "--label": "#586e75", "--faint": "#93a1a1", "--muted": "#93a1a1", "--grid": "#e3dcc8",
    "--rule": "#93a1a1", "--border": "#e3dcc8", "--accent": "#268bd2", "--today": "#dc322f",
    "--danger": "#dc322f", "--dep": "#93a1a1", "--dep-hl": "#268bd2", "--hist-line": "#e3dcc8",
  }, ["#268bd2", "#2aa198", "#859900", "#b58900", "#6c71c4", "#d33682"]),
  theme("solarized-dark", "Solarized Dark", "dark", {
    "--bg": "#002b36", "--surface": "#073642", "--fg": "#93a1a1", "--heading": "#eee8d5",
    "--label": "#93a1a1", "--faint": "#586e75", "--muted": "#657b83", "--grid": "#0a3a45",
    "--rule": "#586e75", "--border": "#0a3a45", "--accent": "#268bd2", "--today": "#dc322f",
    "--danger": "#dc322f", "--dep": "#586e75", "--dep-hl": "#268bd2", "--hist-line": "#0a3a45",
  }, ["#268bd2", "#2aa198", "#859900", "#b58900", "#6c71c4", "#d33682"]),

  // — LaTeX (paper white, Latin Modern serif, classic black ink) —
  theme("latex", "LaTeX", "light", {
    "--bg": "#ffffff", "--surface": "#fafafa", "--fg": "#000000", "--heading": "#000000",
    "--label": "#1a1a1a", "--faint": "#555555", "--muted": "#333333", "--grid": "#dadada",
    "--rule": "#333333", "--border": "#cccccc", "--accent": "#0a3a7a", "--today": "#aa0000",
    "--danger": "#aa0000", "--dep": "#666666", "--dep-hl": "#0a3a7a", "--hist-line": "#cccccc",
    "--font-serif": '"Latin Modern Roman", "CMU Serif", "Computer Modern", Georgia, "Times New Roman", serif',
    "--font-mono": '"Latin Modern Mono", "CMU Typewriter Text", Menlo, monospace',
  }, ["#5b6770", "#7a848c", "#99a1a8", "#b8bec4", "#43505a"]),

  // — Catppuccin (Latte = light, Mocha = dark) —
  theme("catppuccin-latte", "Catppuccin Latte", "light", {
    "--bg": "#eff1f5", "--surface": "#e6e9ef", "--fg": "#4c4f69", "--heading": "#4c4f69",
    "--label": "#5c5f77", "--faint": "#8c8fa1", "--muted": "#9ca0b0", "--grid": "#ccd0da",
    "--rule": "#9ca0b0", "--border": "#dce0e8", "--accent": "#1e66f5", "--today": "#d20f39",
    "--danger": "#d20f39", "--dep": "#9ca0b0", "--dep-hl": "#1e66f5", "--hist-line": "#ccd0da",
  }, ["#1e66f5", "#179299", "#40a02b", "#df8e1d", "#8839ef", "#ea76cb"]),
  theme("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    "--bg": "#1e1e2e", "--surface": "#313244", "--fg": "#cdd6f4", "--heading": "#cdd6f4",
    "--label": "#bac2de", "--faint": "#6c7086", "--muted": "#a6adc8", "--grid": "#313244",
    "--rule": "#6c7086", "--border": "#313244", "--accent": "#89b4fa", "--today": "#f38ba8",
    "--danger": "#f38ba8", "--dep": "#6c7086", "--dep-hl": "#89b4fa", "--hist-line": "#313244",
  }, ["#89b4fa", "#94e2d5", "#a6e3a1", "#f9e2af", "#cba6f7", "#f5c2e7"]),

  // — Nord —
  theme("nord-light", "Nord Light", "light", {
    "--bg": "#eceff4", "--surface": "#e5e9f0", "--fg": "#2e3440", "--heading": "#2e3440",
    "--label": "#3b4252", "--faint": "#7b88a1", "--muted": "#4c566a", "--grid": "#d8dee9",
    "--rule": "#4c566a", "--border": "#d8dee9", "--accent": "#5e81ac", "--today": "#bf616a",
    "--danger": "#bf616a", "--dep": "#9aa5ba", "--dep-hl": "#5e81ac", "--hist-line": "#d8dee9",
  }, ["#5e81ac", "#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead", "#d08770"]),
  theme("nord", "Nord", "dark", {
    "--bg": "#2e3440", "--surface": "#3b4252", "--fg": "#d8dee9", "--heading": "#eceff4",
    "--label": "#d8dee9", "--faint": "#4c566a", "--muted": "#7b88a1", "--grid": "#3b4252",
    "--rule": "#4c566a", "--border": "#3b4252", "--accent": "#88c0d0", "--today": "#bf616a",
    "--danger": "#bf616a", "--dep": "#4c566a", "--dep-hl": "#81a1c1", "--hist-line": "#3b4252",
  }, ["#88c0d0", "#8fbcbb", "#a3be8c", "#ebcb8b", "#b48ead", "#81a1c1"]),

  // — Gruvbox —
  theme("gruvbox-light", "Gruvbox Light", "light", {
    "--bg": "#fbf1c7", "--surface": "#ebdbb2", "--fg": "#3c3836", "--heading": "#282828",
    "--label": "#3c3836", "--faint": "#a89984", "--muted": "#7c6f64", "--grid": "#e6d8a8",
    "--rule": "#7c6f64", "--border": "#e0d6b0", "--accent": "#076678", "--today": "#9d0006",
    "--danger": "#9d0006", "--dep": "#a89984", "--dep-hl": "#076678", "--hist-line": "#e0d6b0",
  }, ["#076678", "#427b58", "#79740e", "#b57614", "#8f3f71", "#af3a03"]),
  theme("gruvbox-dark", "Gruvbox Dark", "dark", {
    "--bg": "#282828", "--surface": "#3c3836", "--fg": "#ebdbb2", "--heading": "#fbf1c7",
    "--label": "#ebdbb2", "--faint": "#928374", "--muted": "#a89984", "--grid": "#3c3836",
    "--rule": "#928374", "--border": "#3c3836", "--accent": "#83a598", "--today": "#fb4934",
    "--danger": "#fb4934", "--dep": "#928374", "--dep-hl": "#83a598", "--hist-line": "#3c3836",
  }, ["#83a598", "#8ec07c", "#b8bb26", "#fabd2f", "#d3869b", "#fe8019"]),

  // — Dracula —
  theme("dracula", "Dracula", "dark", {
    "--bg": "#282a36", "--surface": "#44475a", "--fg": "#f8f8f2", "--heading": "#f8f8f2",
    "--label": "#f8f8f2", "--faint": "#6272a4", "--muted": "#6272a4", "--grid": "#44475a",
    "--rule": "#6272a4", "--border": "#44475a", "--accent": "#bd93f9", "--today": "#ff5555",
    "--danger": "#ff5555", "--dep": "#6272a4", "--dep-hl": "#8be9fd", "--hist-line": "#44475a",
  }, ["#bd93f9", "#8be9fd", "#50fa7b", "#f1fa8c", "#ff79c6", "#ffb86c"]),

  // — Rosé Pine (Dawn = light, main = dark) —
  theme("rose-pine-dawn", "Rosé Pine Dawn", "light", {
    "--bg": "#faf4ed", "--surface": "#fffaf3", "--fg": "#575279", "--heading": "#575279",
    "--label": "#575279", "--faint": "#9893a5", "--muted": "#797593", "--grid": "#e4dcd4",
    "--rule": "#9893a5", "--border": "#e4dcd4", "--accent": "#907aa9", "--today": "#b4637a",
    "--danger": "#b4637a", "--dep": "#9893a5", "--dep-hl": "#56949f", "--hist-line": "#e4dcd4",
  }, ["#56949f", "#286983", "#ea9d34", "#d7827e", "#907aa9", "#b4637a"]),
  theme("rose-pine", "Rosé Pine", "dark", {
    "--bg": "#191724", "--surface": "#1f1d2e", "--fg": "#e0def4", "--heading": "#e0def4",
    "--label": "#e0def4", "--faint": "#6e6a86", "--muted": "#908caa", "--grid": "#26233a",
    "--rule": "#6e6a86", "--border": "#26233a", "--accent": "#c4a7e7", "--today": "#eb6f92",
    "--danger": "#eb6f92", "--dep": "#6e6a86", "--dep-hl": "#9ccfd8", "--hist-line": "#26233a",
  }, ["#9ccfd8", "#31748f", "#f6c177", "#ebbcba", "#c4a7e7", "#eb6f92"]),

  // — Print / High-contrast (ink on paper; pairs with compact/print mode) —
  theme("print", "Print / High-contrast", "light", {
    "--bg": "#ffffff", "--surface": "#ffffff", "--fg": "#000000", "--heading": "#000000",
    "--label": "#000000", "--faint": "#333333", "--muted": "#222222", "--grid": "#999999",
    "--rule": "#000000", "--border": "#000000", "--accent": "#000000", "--today": "#000000",
    "--danger": "#000000", "--dep": "#000000", "--dep-hl": "#000000", "--hist-line": "#000000",
  }, ["#222222", "#555555", "#777777", "#999999", "#444444"]),
];

export const DEFAULT_THEME_ID = "tufte"; // both light & dark slots default here

// Validate a theme object (used for imports). Returns {ok, error}.
export function validateTheme(t) {
  if (!t || typeof t !== "object") return { ok: false, error: "theme must be an object" };
  if (!t.id || typeof t.id !== "string") return { ok: false, error: "theme needs a string 'id'" };
  if (!t.name || typeof t.name !== "string") return { ok: false, error: "theme needs a 'name'" };
  if (!t.tokens || typeof t.tokens !== "object") return { ok: false, error: "theme needs a 'tokens' object" };
  const missing = TOKEN_NAMES.filter((k) => !(k in t.tokens));
  if (missing.length) return { ok: false, error: "missing tokens: " + missing.join(", ") };
  if (t.barPalette != null && !Array.isArray(t.barPalette)) return { ok: false, error: "'barPalette' must be an array" };
  return { ok: true };
}
