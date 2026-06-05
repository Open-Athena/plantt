import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // Served from https://open-athena.github.io/plantt/ (project Pages), so assets
  // need the repo-name prefix. Use "/" for a user/org root or a custom domain.
  base: "/plantt/",
  server: {
    open: true,   // open the browser on `npm run dev`
    host: true,
  },
});
