import { app, BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: -1, // Allow window manager to position
    y: -1,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: process.env.ELECTRON_RENDERER_PATH || "./src/preload/index.ts",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("./src/renderer/index.html");
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
