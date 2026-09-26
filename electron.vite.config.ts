import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  preload: ["src/preload/index.ts"],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "main/[name].[hash].js",
        chunkFileNames: "commonchunks/[name].[hash].js",
        assetFileNames: "assets/[name].[hash].[ext]",
      },
    },
  },
});
