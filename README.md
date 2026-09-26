# SPECTRE

Local personal assistant with Digital Noir aesthetic - Electron + React + Three.js

## Tech Stack

- **OS/WM:** Arch Linux (Omarchy) + Hyprland
- **Interface:** Electron + React + `@react-three/fiber` (Three.js)
- **Voice (In/Out):** VAD + Whisper.cpp (STT) + Kokoro (TTS)
- **Brain:** LM Studio (Local LLM via OpenAI SDK)

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Architecture

### Vite Configuration (`vite.config.ts` + `electron.vite.config.ts`)
- **Path:** `./vite.config.ts` (renderer) and `./electron.vite.config.ts` (Electron preload)
- **Entry:** Main process at `src/main/main.ts`, renderer at `src/renderer/main.tsx`
- **Preload index:** `src/preload/index.ts` exposed via `contextBridge`

### Main Process (`src/main/main.ts`)
- Configures transparent, frameless BrowserWindow with:
  - `transparent: true`, `frame: false`, `hasShadow: false`
  - `alwaysOnTop: true` for persistent visibility
  - IPC handlers for speech events and TTS synthesis

### Preload Script (`src/preload/index.ts`)
- Exposes safe IPC methods via contextBridge:
  - `notifySpeechStart` / `notifySpeechEnd` for VAD events
  - `getTTSAudio` for TTS audio buffer retrieval

### Renderer Process (`src/renderer/`)
- React app with Three.js Canvas at `src/renderer/App.tsx`
- Digital Noir shader material on 3D orb
- Transparent CSS background applied globally to ensure full transparency

## Hyprland Integration

Add the following rules to `~/.config/hyprland/hyprland.conf`:

```conf
windowrulev2 = float, class:^(spectre)$
windowrulev2 = noborder, class:^(spectre)$
windowrulev2 = pin, class:^(spectre)$
windowrulev2 = noanim, class:^(spectre)$
```

## License

MIT
