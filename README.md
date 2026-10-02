# SPECTRE

Local Portuguese voice assistant for Electron with a transparent, audio-reactive
Digital Noir orb.

## Runtime pipeline

1. `@ricky0123/vad-web` runs in the renderer and calls `onSpeechStart` /
   `onSpeechEnd(audio)`. The completed speech segment is a 16 kHz
   `Float32Array`; there is no second microphone capture path.
2. The preload bridge sends the segment over typed IPC to the main-process
   `ConversationOrchestrator`.
3. Main writes a temporary WAV under Electron's `userData` directory,
   transcribes it with Whisper.cpp, then removes it in `finally`.
4. LM Studio streams `qwen/qwen3.5-9b` from
   `http://127.0.0.1:1234/v1/chat/completions` with the Portuguese
   `CONTEXT_MESSAGES`.
5. `SentenceChunker` emits grammatical `.?!;:` boundaries, strategic commas,
   and max-length word-boundary chunks without dropping punctuation.
6. Each chunk is synthesized serially by local Kokoro at
   `http://127.0.0.1:1235/tts`. Kokoro defaults to Brazilian Portuguese
   (`lang_code=p`) and `pf_dora`.
7. The renderer reorders chunks by sequence and schedules decoded WAV buffers
   continuously through one `AnalyserNode`. FFT amplitude, bass, and treble
   drive the R3F shader every frame and decay smoothly to its idle motion.

Starting a new speech segment cancels the current LM Studio/Kokoro work and
stops queued playback. Conversation state, transcript, reply, audio, completion,
and error events use the shared types in `src/types/ipc.ts`.

## Setup

```bash
npm install
npm run setup:runtime
```

The managed Python 3.12 runtime is stored at
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/python`. Override it with
`SPECTRE_PYTHON_RUNTIME`, or set `PYTHON_CMD` to use another compatible
interpreter.

The managed Whisper.cpp runtime and multilingual base model are stored at
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/whisper`. Override that location
with `SPECTRE_WHISPER_RUNTIME`, or use `WHISPER_CPP_PATH` and
`WHISPER_MODEL_PATH` for a custom installation.

Start LM Studio on port 1234 with `qwen/qwen3.5-9b` loaded, then run:

```bash
npm run dev
```

The Electron main process starts the Kokoro FastAPI service on dedicated port
1235. `TTS_SERVER_PORT`, `TTS_VOICE`, `KOKORO_LANG_CODE`,
`LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `WHISPER_CPP_PATH`, and
`WHISPER_MODEL_PATH` can override defaults.

## Validation and packaging

```bash
npm test
npm run type-check
npm run lint
npm run build
npm run build:electron
```

`electron-builder.jsonc` keeps `src/main/python_server/**` outside `app.asar`
so the managed Python interpreter can execute the server files in packaged
builds.

## Main modules

- `src/main/conversation-orchestrator.ts`: cancellation-safe STT → LLM → TTS
  pipeline and temporary-file cleanup.
- `src/main/sentence-chunker.ts`: incremental grammatical text chunking.
- `src/main/lm-studio.ts`: SSE chat-completion stream.
- `src/main/kokoro-client.ts`: local WAV synthesis.
- `src/renderer/vad.ts`: MicVAD callback integration.
- `src/renderer/audio-playback-queue.ts`: sequence ordering, gapless scheduling,
  and FFT analysis.
- `src/renderer/App.tsx`: status UI and procedural audio-reactive R3F orb.

The window remains frameless, always-on-top, and fully transparent for
Hyprland. The default class is `spectre` and can be changed with
`WINDOW_MANAGER_CLASS`.
