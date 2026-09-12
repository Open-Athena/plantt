import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // Served from the root of plantt.oa.dev (Cloudflare Pages). Set PLANTT_BASE to build
  // for a sub-path host (the old GitHub Pages deploy used "/plantt/").
  base: process.env.PLANTT_BASE || "/",
  server: {
    open: true,   // open the browser on `npm run dev`
    host: true,
    // The API and sign-in routes are Pages Functions; run `npm run dev:api` alongside
    // `npm run dev` and Vite forwards them to wrangler on :8788.
    proxy: {
      "/api": "http://127.0.0.1:8788",
      "/auth": "http://127.0.0.1:8788",
    },
  },
});
