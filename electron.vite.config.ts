import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { Plugin } from "vite";

const entries = {
  main: "src/main/main.ts",
  preload: ["src/preload/index.ts"],
} as const;

const srcAlias = fileURLToPath(new URL("./src", import.meta.url));

function vadAssets(): Plugin {
  const assetFiles = [
    [
      "vad.worklet.bundle.min.js",
      "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
    ],
    [
      "silero_vad_legacy.onnx",
      "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx",
    ],
    [
      "ort-wasm-simd-threaded.mjs",
      "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
    ],
    [
      "ort-wasm-simd-threaded.wasm",
      "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    ],
  ] as const;
  const assets = new Map(
    assetFiles.map(([name, source]) => [
      `/${name}`,
      path.resolve(process.cwd(), source),
    ]),
  );

  return {
    name: "spectre-local-vad-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const source = assets.get(request.url?.split("?")[0] ?? "");
        if (!source) {
          next();
          return;
        }
        response.setHeader(
          "Content-Type",
          source.endsWith(".wasm")
            ? "application/wasm"
            : source.endsWith(".onnx")
              ? "application/octet-stream"
              : "text/javascript",
        );
        response.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [urlPath, source] of assets) {
        this.emitFile({
          type: "asset",
          fileName: urlPath.slice(1),
          source: readFileSync(source),
        });
      }
    },
  };
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@": srcAlias,
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@": srcAlias,
      },
    },
  },
  renderer: {
    plugins: [react(), vadAssets()],
    resolve: {
      alias: {
        "@": srcAlias,
      },
    },
  },
});

void entries;
