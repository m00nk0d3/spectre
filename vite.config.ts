import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { loadEnv } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
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
  };
};
});
