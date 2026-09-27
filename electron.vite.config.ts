import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: "src/main/main.ts",
  preload: ["src/preload/index.ts"],
  plugins: [react()],
});
