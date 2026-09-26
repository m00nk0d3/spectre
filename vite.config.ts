import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { electron } from "electron-vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), electron()],
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
