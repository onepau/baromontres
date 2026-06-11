import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(here, "src/index.html"),
        en: resolve(here, "src/en/index.html"),
      },
      output: {
        manualChunks: {
          chart: [
            "chart.js",
            "chartjs-adapter-date-fns",
            "chartjs-plugin-zoom",
            "date-fns",
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
