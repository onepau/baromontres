import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function chartModulePreload(): Plugin {
  return {
    name: "chart-modulepreload",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        return Object.keys(ctx.bundle)
          .filter((f) => f.startsWith("assets/chart") && f.endsWith(".js"))
          .map((href) => ({
            tag: "link",
            attrs: {
              rel: "modulepreload",
              crossorigin: true,
              href: `/${href}`,
            },
            injectTo: "head" as const,
          }));
      },
    },
  };
}

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
  plugins: [chartModulePreload()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
