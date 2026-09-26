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

## Hyprland Integration

Add the following rules to `~/.config/hyprland/hyprland.conf`:

```conf
windowrulev2 = float, class:^(spectre)$
windowrulev2 = noborder, class:^(spectre)$
windowrulev2 = pin, class:^(spectre)$
windowrulev2 = noanim, class:^(spectre)$
```

## Architecture

### Main Process (`src/main/main.ts`)
- Configures transparent, frameless BrowserWindow
- Manages IPC communication between renderer and main process

### Preload Script (`src/preload/index.ts`)
- Exposes safe IPC methods via contextBridge:
  - `onSpeechStart` / `onSpeechEnd` for VAD events
  - `sendAudioBuffer` for audio data transfer

### Renderer Process (`src/renderer/`)
- React app with Three.js Canvas
- Digital Noir shader material on 3D orb
- Listens to speech events and renders visual feedback

## License

MIT
