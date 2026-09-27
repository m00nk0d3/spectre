# SPECTRE Project: Architecture and Implementation

## Overview
Local personal assistant operating with zero latency.
Visual interface based on a reactive "Digital Noir" floating orb, with fully local AI processing and audio.

## Tech Stack
*   **OS/WM:** Arch Linux (Omarchy) + Hyprland
*   **Interface:** Electron + React + `@react-three/fiber` (Three.js)
*   **Voice (In/Out):** `@ricky0123/vad-web` (VAD) + Whisper.cpp (STT) + Kokoro (TTS)
*   **Brain:** LM Studio (Local LLM via OpenAI SDK)

---

## Implementation Phases

### 1. Foundation and Integration into Hyprland (Electron + React)
*   **Setup:** Initialize with `npm create @quick-start/electron spectre --template react-ts`.
*   **Main Process (`main.ts`):**
    *   Configure the `BrowserWindow` for `transparent: true`, `frame: false`, `hasShadow: false`, `alwaysOnTop: true`.
    *   CSS global: `body { background-color: rgba(0,0,0); }`
    *   Set `windowClassName = process.env.WINDOW_MANAGER_CLASS || "spectre"` for Hyprland rule matching
*   **Hyprland Rules (`~/.config/hyprland/hyprland.conf`):**
  - Uses `windowrulev2` with regex pattern matching on window class:
  ```hypr
  # Pattern: class:^(spectre)$ matches exactly "spectre"
  windowrulev2 = float, class:^(spectre)$       # Floating (no stacking group)
  windowrulev2 = noborder, class:^(spectre)$    # Disable borders and shadows
  windowrulev2 = pin, class:^(spectre)$         # Pin to all workspaces
  windowrulev2 = noanim, class:^(spectre)$      # Disable fade animations
  ```
  - Set `WINDOW_MANAGER_CLASS` in `.env` to customize the class name pattern

### 2. Attentive Ear (VAD and Capture - Renderer Process)
*   **Library:** Install `@ricky0123/vad-web` (processing via WebAssembly).
*   **Logic:**
    *   Monitor VAD state for speech activity detection.
    *   On silence timeout, convert the collected `Float32Array` to WAV buffer.
    *   Send buffer via IPC to Main Process.

#### VAD Event Flow (Voice Activity Detection)

**Entry Points:**

| File | Function | Line Range | Responsibility |
|------|----------|------------|----------------|
| `src/renderer/vad.ts` | `createVad()` | 22-152 | Factory function creating VAD instance with state management |
| `src/renderer/vad.ts` | `vadModule` | 156-170 | Module exports with audio buffer collection methods |
| `src/renderer/vad.ts` | `MicVAD.new()` | 44-52 | WebAssembly-based VAD initialization from `@ricky0123/vad-web` |

**State Management:**

```typescript
interface VADState {
  isSpeaking: boolean;        // Currently in speech (listening state)
  lastSpeechTime: number \| null;  // Timestamp of last speech activity
}

const DEFAULT_SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS ?? "1500", 10);
```

**Event Emission Flow:**

| Event | Trigger | IPC Method Called |
|-------|---------|-------------------|
| Speech Start | VAD detects voice activity (`vad.listening === true`) | `window.electron.notifySpeechStart()` |
| Speech End | Silence exceeds `SILENCE_TIMEOUT_MS` (default 1500ms) | `window.electron.notifySpeechEnd()` |

**Audio Buffer Collection:**

```typescript
// Global buffer collection for VAD module
const collectedBuffers: Float32Array[] = [];

// Methods exposed for IPC handling
export const vadModule = (() => {
  const collectedBuffers: Float32Array[] = [];

  return Object.assign(createVad(), {
    collectedBuffers,
    setCollectedBuffers: (buffers: Float32Array[]) => { /* ... */ },
    addCollectedBuffer: (buffer: Float32Array) => { /* ... */ },
  });
})();
```

**Audio Conversion Trigger:**

When speech ends, the VAD triggers audio conversion to WAV:

```typescript
// In App.tsx, within notifySpeechEnd handler:
if (typeof window.electron.createWavBuffer === "function") {
  // Flatten collected buffers
  const flattenedData = new Float32Array(totalLength);
  for (const buf of collectedData) {
    flattenedData.set(buf, offset);
    offset += buf.length;
  }

  // Convert to WAV via IPC
  window.electron.createWavBuffer(flattenedData).then((result) => {
    if (result.success && result.buffer) {
      console.log("[APP] Audio converted to WAV successfully");
      vadModule.collectedBuffers.length = 0;
    }
  });
}
```

### 3. Transcription and Brain (STT + LLM - Main Process)
*   **Transcription (Whisper.cpp):**
    *   Run the local Whisper binary pointing to the temporary WAV file using `child_process.exec`.
*   **Response Generation (LM Studio):**
    *   Use the native `openai` package.
    *   Base URL: `http://localhost:1234/v1`.
    *   Critical parameter: `stream: true`.

### 4. Dynamic Speech (TTS and Chunking)
*   **Stream Chunking:**
    *   Accumulate tokens in a temporary buffer.
    *   Parse the string looking for final punctuation (`.`, `!`, `?`).
    *   Once a sentence is validated, extract from buffer and submit to TTS queue.
    *   **Implementation:** [`stream-tts.ts`](./src/main/stream-tts.ts) implements AsyncGenerator pattern with sequence tracking; IPC conversion to ReadableStream in [`main.ts`](./src/main/main.ts#143-172); types in [`ipc.ts`](./src/types/ipc.ts).
    *   **Documentation:** See [`issues/15-shader-pipeline.md`](./issues/15-shader-pipeline.md) for Epic-to-issue tracing and acceptance criteria validation.
*   **Local Synthesis:**
    *   Use local **Kokoro TTS** server (via Python) for ultra-fast generation.
    *   Send generated audio back to Renderer (React) via IPC for sequential playback without blocking LLM response.

### 5. Digital Noir Aesthetic (3D Orb in Three.js)

#### Shader Uniforms Reference

| Uniform | Type | Source of Data |
|---------|------|-----------------|
| `time` | `float` | `clock.elapsedTime` from React Three Fiber (seconds since load) |
| `amplitude` | `float` | RMS calculation from microphone audio input (0.0–0.3 range) |
| `noiseTime` | `float` | Per-frame noise seed: `Date.now() / 1000` for procedural texture variation |

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

// Simplex noise function for procedural texture generation
float hash(float n) { return fract(sin(n * 1e4) * 1e4); }
float snoise(vec3 x) { /* Simplex noise implementation */ }

void main() {
  // Combine static time-based noise with per-frame seed
  float noise = snoise(vec3(vUv.x, vUv.y, time)) * 0.1 + noiseTime;

  // Digital Noir palette: dark gray base color
  vec3 baseColor = vec3(0.08, 0.07, 0.06);

  // Subtle pulsation for idle animation
  float pulse = sin(time * 2.0) * 0.05;

  gl_FragColor = vec4(baseColor + noise * 0.1 + pulse * 0.1, 1.0);
}
```

**Features:**
- **Procedural texture:** Simplex noise generates dynamic surface details without external textures
- **Digital Noir palette:** Base color `vec3(0.08, 0.07, 0.06)` creates dark gray tones characteristic of noir aesthetics
- **Idle animation:** `pulse = sin(time * 2.0) * 0.05` adds subtle breathing effect
- **Amplitude modulation:** Orb scales via `mesh.scale.setScalar(1.2 + amplitude * Math.sin(time * 8))` during active speech
- **Noise perturbation:** Static noise uniforms create texture depth and visual interest

#### React Integration (useFrame Hook)

```typescript
useFrame(({ clock }) => {
  const time = clock.elapsedTime;
  noiseTimeRef.current = Date.now() / 1000;

  if (meshRef.current && materialRef.current) {
    // Scale orb based on speech amplitude with sine wave modulation
    meshRef.current.scale.setScalar(1.2 + amplitude * Math.sin(time * 8));
    materialRef.current.uniforms.time.value = time;
    materialRef.current.uniforms.noiseTime.value = noiseTimeRef.current;
  }
});
```

Updates shader uniforms and orb scale each frame based on speech amplitude, creating a reactive visual that responds to audio input in real-time.

#### Documentation Reference

Complete pipeline documentation available in [`issues/15-shader-pipeline.md`](./issues/15-shader-pipeline.md) including Epic-to-issue tracing, FFT→uniform mapping implementation details, and acceptance criteria validation (AC-01/AC-02/AC-03).

---

## IPC Method Signatures (Preload ContextBridge)

All methods exposed via `contextBridge.exposeInMainWorld("electron", ...)` in [`src/preload/index.ts`](./src/preload/index.ts):

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
- `LM_STUDIO_API_KEY=your-api-key` - Your LM Studio API key for TTS functionality

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
[✓] LM_STUDIO_API_KEY is configured
```

### Troubleshooting

**Window not floating:**
1. Verify `hyprland.conf` is properly configured with all five rules (float, noborder, pin, noanim, transparent)
2. Check that the WINDOW_MANAGER_CLASS matches your environment's window class pattern
3. Restart Hyprland session: `hyprctl dispatch restartworkspace 0`

**Transparency not applied:**
1. Confirm the transparency rule syntax is correct: `windowrulev2 = transparent <value>, class:^(spectre)$`
2. The `<value>` must be a decimal between 0.0 (fully transparent) and 1.0 (fully opaque)

### Pattern Matching Notes

The class pattern uses **regex syntax** where:
- `^` matches start of string
- `$` matches end of string
- `^(spectre)$` matches exactly "spectre" (no prefix/suffix)

If using a custom class name, update the rules in `hyprland.conf` and `.env` accordingly.

---
