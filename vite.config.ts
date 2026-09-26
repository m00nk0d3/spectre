import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": __dirname + "/src",
      },
    },
    base: "./",
    css: {
      modules: {
        localsConvention: "camelCase",
      },
    },
  };
});
