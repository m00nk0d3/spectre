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
    *   CSS global: `body { background-color: rgba(0,0,0,0); }`
*   **Hyprland Rules (`~/.config/hyprland/hyprland.conf`):**
  ```text
  windowrulev2 = float, class:^(spectre)$
  windowrulev2 = noborder, class:^(spectre)$
  windowrulev2 = pin, class:^(spectre)$
  windowrulev2 = noanim, class:^(spectre)$
  ```

### 2. Attentive Ear (VAD and Capture - Renderer Process)
*   **Library:** Install `@ricky0123/vad-web` (processing via WebAssembly).
*   **Logic:**
    *   Monitor `onSpeechStart` and `onSpeechEnd` events.
    *   On `onSpeechEnd`, convert the generated `Float32Array` to WAV buffer.
    *   Send buffer via IPC to Main Process.

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
*   **Local Synthesis:**
    *   Use local **Kokoro TTS** server (via Python) for ultra-fast generation.
    *   Send generated audio back to Renderer (React) via IPC for sequential playback without blocking LLM response.

### 5. Digital Noir Aesthetic (3D Orb in Three.js)
*   **Components:** Use `<sphereGeometry />` with a custom `shaderMaterial` (GLSL).
*   **Reactivity:**
    *   *Idle:* Slow rotation with procedural noise (Simplex Noise).
    *   *Listening:* Increase amplitude and expansion based on static uniforms.
    *   *Speaking:* Connect the TTS audio output to an AnalyserNode. Map real-time frequency data to GLSL variables, creating pulsation strictly synchronized with voice.

---
