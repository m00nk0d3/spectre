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

### Python Microservice FastAPI (TTS)

**Spawn Script:** [`scripts/spawn-python-server.ts`](./scripts/spawn-python-server.ts) launches the Python TTS server as a subprocess.
**Server Code:** `src/main/python_server/main.py` exposes `/tts` POST endpoint with Kokoro GPU for sub-second inference.
**Health Endpoint:** `GET /health` confirms server readiness.
**Requirements:** `src/main/python_server/requirements.txt`:
```
fastapi==0.115.0
uvicorn[standard]==0.32.0
onnxruntime-gpu>=1.18.0
transformers==4.46.0
torch>=2.4.0
pydantic==2.9.0
```
**Environment Variable:** `KOKORO_MODEL_PATH` points to Kokoro GGUF model directory (e.g., `pf_dora`).
**Lifecycle Management:** Server starts on app launch; killed on app close (no orphan processes).
**Endpoint:** `POST /tts` accepts `{text, voice}`, returns WAV audio as binary buffer.

### Preload Script (`src/preload/index.ts`)
- Exposes safe IPC methods via contextBridge:
  - `notifySpeechStart` / `notifySpeechEnd` for VAD events
  - `getTTSAudio(text)` for TTS audio buffer retrieval
  - `createWavBuffer(data)` for Float32Array to WAV conversion
  - `writeWavFile(data, path)` for writing WAV files to disk

### Renderer Process (`src/renderer/`)
- React app with Three.js Canvas at `src/renderer/App.tsx`
- Digital Noir shader material on 3D orb
- Transparent CSS background applied globally to ensure full transparency

---

## IPC Method Signatures (Preload ContextBridge)

| Method | Signature | Description |
|--------|-----------|-------------|
| `notifySpeechStart()` | `(()) => boolean` | Notify speech start from VAD |
| `notifySpeechEnd()` | `(()) => boolean` | Notify speech end to trigger WAV conversion |
| `getTTSAudio(text)` | `(text: string) => Promise<Buffer>` | Get TTS audio buffer as ArrayBuffer |
| `getTTSAudioStream(text)` | `(text: string) => Promise<ReadableStream<{ seq: number; data: ArrayBuffer }>>` | Streaming TTS chunks |
| `pythonStatusRequest()` | `(()) => Promise<boolean>` | Check if Python TTS server is ready |
| `pythonPid()` | `(()) => number \| null` | Get PID of Python subprocess |
| `createWavBuffer(data)` | `(float32Data: Float32Array) => Promise<ArrayBuffer>` | Convert Float32Array to WAV ArrayBuffer |
| `writeWavFile(data, path)` | `(float32Data: Float32Array, path: string) => Promise<void>` | Write WAV file to disk |
| `vadGetCollectedAudio()` | `() => Promise<{ success: boolean; buffers: Float32Array[] }>` | Get collected audio buffers from VAD |
| `vadTriggerWavConversion(config?)` | `(config?: { sampleRate?: number; channels?: number }) => Promise<ArrayBuffer>` | Trigger WAV conversion for collected audio |
| `vadCaptureStart()` | `(()) => boolean` | Start audio capture in renderer context |
| `vadCaptureStop()` | `(()) => boolean` | Stop audio capture in renderer context |
| `vadClearCollected()` | `(()) => boolean` | Clear collected buffers from VAD |
| `vadStatus()` | `() => Promise<{ status: string; samplesCollected: number }>` | Get VAD state and buffer count |
| `sendAudioBuffer(data)` | `(float32Data: Float32Array \| Buffer) => Promise<{ success: boolean; buffer?: ArrayBuffer }>` | Send audio buffer via IPC |
| `whisperTranscribe(path)` | `(wavPath: string) => Promise<string>` | Transcribe WAV file using Whisper.cpp |

---

## Three.js Shader Material (App.tsx)

### ShaderOrb Component

The 3D orb visualizes speech activity using a custom GLSL shader material with procedural noise textures.

#### Uniforms

| Uniform | Type | Description |
|---------|------|-------------|
| `time` | `float` | Current render time in seconds (from `clock.elapsedTime`) |
| `amplitude` | `float` | Speech activity level (0.0–0.3) for orb scaling |
| `noiseTime` | `float` | Per-frame noise seed based on wall clock time |

#### Vertex Shader

```glsl
uniform float time;
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
```

- Pass-through vertex shader with no geometry distortion
- UV coordinates passed to fragment shader for texture mapping

#### Fragment Shader (Digital Noir Aesthetic)

```glsl
uniform float time;
uniform float amplitude;
uniform float noiseTime;
varying vec2 vUv;

// Simplex noise function for procedural texture
float hash(float n) { return fract(sin(n * 1e4) * 1e4); }
float snoise(vec3 x) { /* Simplex noise implementation */ }

void main() {
  float noise = snoise(vec3(vUv.x, vUv.y, time)) * 0.1 + noiseTime;
  vec3 baseColor = vec3(0.08, 0.07, 0.06); // Dark gray (Digital Noir)
  float pulse = sin(time * 2.0) * 0.05;    // Subtle pulsation
  gl_FragColor = vec4(baseColor + noise * 0.1 + pulse * 0.1, 1.0);
}
```

**Features:**
- **Procedural texture:** Simplex noise generates dynamic surface details
- **Digital Noir palette:** Base color `vec3(0.08, 0.07, 0.06)` creates dark gray tones
- **Idle animation:** `pulse = sin(time * 2.0) * 0.05` adds subtle breathing
- **Amplitude modulation:** Orb scales via `mesh.scale.setScalar(1.2 + amplitude * Math.sin(time * 8))`
- **Noise perturbation:** Static noise uniforms create texture depth

#### React Integration (useFrame)

```typescript
useFrame(({ clock }) => {
  const time = clock.elapsedTime;
  noiseTimeRef.current = Date.now() / 1000;

  if (meshRef.current && materialRef.current) {
    meshRef.current.scale.setScalar(1.2 + amplitude * Math.sin(time * 8));
    materialRef.current.uniforms.time.value = time;
    materialRef.current.uniforms.noiseTime.value = noiseTimeRef.current;
  }
});
```

Updates shader uniforms and orb scale each frame based on speech amplitude.

#### Documentation Reference

Complete pipeline documentation available in [`issues/15-shader-pipeline.md`](./issues/15-shader-pipeline.md).

---

## Hyprland Integration

### Rules Applied to Windows Matching `class:^(spectre)$`

| Rule | Value | Effect |
|------|-------|--------|
| `float` | `class:^(spectre)$` | Floating window mode (excludes from stacking group) |
| `noborder` | `class:^(spectre)$` | Disables Hyprland borders and shadows |
| `pin` | `class:^(spectre)$` | Pins window to all workspaces (persistent) |
| `noanim` | `class:^(spectre)$` | Disables fade animations |

### Configuration

Add the following rules to `~/.config/hyprland.conf`:

```hypr
windowrulev2 = float, class:^(spectre)$
windowrulev2 = noborder, class:^(spectre)$
windowrulev2 = pin, class:^(spectre)$
windowrulev2 = noanim, class:^(spectre)$
windowrulev2 = transparent 0.95, class:^(spectre)$
```

### Installation

1. **Set Environment Variables:**

```bash
# Create .env from template (optional)
cp .env.example .env

# Edit .env with your values
nano .env
```

Required environment variables:
- `WINDOW_MANAGER_CLASS=spectre` - The Hyprland class name pattern for window rules (default: "spectre")
- `LM_STUDIO_API_KEY=your-api-key` - Your LM Studio API key for LLM integration
- `KOKORO_MODEL_PATH=/path/to/kokoro-model` - Path to Kokoro TTS GGUF model directory (e.g., `pf_dora`)

2. **Apply Hyprland Rules:**

```bash
# Method 1: Append to your existing hyprland.conf
cat /path/to/spectre/hyprland.conf >> ~/.config/hypr/hyprland.conf

# Method 2: Copy entire file (replace your config)
cp /path/to/spectre/hyprland.conf ~/.config/hyprland.conf
```

### Validation Script

Run the built-in validation script to verify setup:

```bash
node scripts/validate-hyprland.ts
```

Expected output:
```
[✓] hyprland.conf exists
[✓] Found: Floating window mode
[✓] Found: Disable Hyprland borders
[✓] Found: Workspace pinning (fixed on all workspaces)
[✓] Found: Disable window animations
[✓] All Hyprland integration rules validated successfully
[✓] WINDOW_MANAGER_CLASS is configured
[✓] KOKORO_MODEL_PATH is configured
```

### Troubleshooting

**Window not floating:**
1. Verify `hyprland.conf` is properly configured with all five rules (float, noborder, pin, noanim, transparent)
2. Check that the WINDOW_MANAGER_CLASS matches your environment's window class pattern
3. Restart Hyprland session: `hyprctl dispatch restartworkspace 0`

**Transparency not applied:**
1. Confirm the transparency rule syntax is correct: `windowrulev2 = transparent <value>, class:^(spectre)$`
2. The `<value>` must be a decimal between 0.0 (fully transparent) and 1.0 (fully opaque)

### Python TTS Server Troubleshooting

**Server not loading:**
1. Verify `KOKORO_MODEL_PATH` points to an existing directory containing the Kokoro GGUF model
2. Check that `onnxruntime-gpu` is installed and CUDA is available (`nvidia-smi`)
3. Confirm model file exists: `<KOKORO_MODEL_PATH>/ggml-model-f16.bin` (or similar naming convention)

**GPU not detected:**
1. Ensure NVIDIA drivers are installed on your system
2. Verify CUDA toolkit is properly configured
3. Check Python can import `onnxruntime-gpu`: `python -c "import onnxruntime; print(onnxruntime.get_device())"`

**Model loading timeout (>30s):**
1. The server has a 30-second timeout waiting for GPU model load indicator
2. Larger models may take longer; consider using smaller quantization (q4_0) if available

### Pattern Matching Notes

The class pattern uses **regex syntax** where:
- `^` matches start of string
- `$` matches end of string
- `^(spectre)$` matches exactly "spectre" (no prefix/suffix)

If using a custom class name, update the rules in `hyprland.conf` and `.env` accordingly.

---

## License

MIT
