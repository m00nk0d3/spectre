import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    extensions: [".js", ".json", ".ts", ".tsx"],
  },
  base: "./",
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
