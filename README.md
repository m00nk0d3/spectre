# SPECTRE

Local US English voice assistant for Electron with a transparent, audio-reactive
Digital Noir orb.

## Install a release

Spectre currently publishes Linux x86_64 AppImage and Debian assets. The
user-level installer verifies release checksums, installs the AppImage under
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/app`, creates the `spectre`
launcher and desktop entry, provisions managed Python 3.12 with `uv`, installs
the local voice dependencies, and downloads the Faster Whisper `small` model.
It does not use `sudo` or modify system Python.

```bash
curl -fsSL \
  https://github.com/m00nk0d3/spectre/releases/latest/download/install-spectre.sh \
  -o /tmp/install-spectre.sh
bash /tmp/install-spectre.sh
```

LM Studio remains a separate local prerequisite. Load any chat model and run
LM Studio on port 1234 before launching `spectre`.

Install a specific release or skip the large managed voice runtime:

```bash
bash /tmp/install-spectre.sh --version 1.0.0
bash /tmp/install-spectre.sh --no-runtime
```

Uninstall the application while retaining downloaded model runtimes:

```bash
spectre-uninstall
```

Pass `--purge-runtime` to also remove Spectre's managed Python and Whisper
runtimes. The uninstaller never removes Obsidian vaults, LM Studio models, or
Spectre user configuration.

## Runtime pipeline

1. `@ricky0123/vad-web` runs in the renderer and calls `onSpeechStart` /
   `onSpeechEnd(audio)`. The completed speech segment is a 16 kHz
   `Float32Array`; there is no second microphone capture path.
2. The preload bridge sends the segment over typed IPC to the main-process
   `ConversationOrchestrator`.
3. Main writes a temporary WAV under Electron's `userData` directory,
   transcribes it with Whisper.cpp, then removes it in `finally`.
4. Spectre discovers the LLM currently loaded in LM Studio and streams it from
   `http://127.0.0.1:1234/v1/chat/completions` with the US English
   `CONTEXT_MESSAGES`. OpenAI-compatible tool calls can retrieve the current
   date/time, local system status, and the user's Obsidian second brain.
   Vault access supports secure search, read, create, and append operations;
   execution is bounded to four calls per request.
5. `SentenceChunker` emits grammatical `.?!;:` boundaries, strategic commas,
   and max-length word-boundary chunks without dropping punctuation.
6. Each chunk is synthesized serially by local Kokoro at
   `http://127.0.0.1:1235/tts`. Kokoro defaults to US English
   (`lang_code=a`) and the male `am_michael` voice.
7. The renderer reorders chunks by sequence and schedules decoded WAV buffers
   continuously through one `AnalyserNode`. FFT amplitude, bass, and treble
   drive the R3F shader every frame and decay smoothly to its idle motion.
8. MicVAD pauses before assistant audio is scheduled and resumes 350 ms after
   the playback queue becomes idle, preventing speaker output from cancelling
   or starting another conversation.

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

The managed Whisper runtimes and multilingual small models are stored at
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/whisper`. Override that location
with `SPECTRE_WHISPER_RUNTIME`, or use `WHISPER_CPP_PATH` and
`WHISPER_MODEL_PATH` for a custom installation. Spectre selects the optimized
Haswell/AVX2 GGML backend when the CPU supports it and otherwise uses the
portable x64 backend for legacy whisper.cpp calls. Live conversations use a
warm CTranslate2 int8 model in the local Python service to avoid loading a new
model for every utterance. Set `WHISPER_BACKEND_PATH` to choose another
whisper.cpp backend. Its decoding prompt targets US English and its
hotword list preserves common Spectre stack names.

Spectre discovers the active vault from
`~/.config/obsidian/obsidian.json`. Set `SPECTRE_OBSIDIAN_VAULT` to use a
different vault. Vault writes are append-only and restricted to the standard
`00 Inbox`, `10 Projects`, `20 Decisions`, `30 Knowledge`, and `40 Sessions`
folders. Hidden paths, traversal, external symlinks, oversized notes, and
content resembling credentials are rejected.

Start LM Studio on port 1234 and load the chat model you want Spectre to use.
Spectre discovers the single loaded LLM through LM Studio's local API. If
multiple LLMs are loaded, set `LM_STUDIO_MODEL` to the desired instance ID.

Then run:

```bash
npm run dev
```

The Electron main process starts the Kokoro FastAPI service on dedicated port
1235. `TTS_SERVER_PORT`, `TTS_VOICE`, `KOKORO_LANG_CODE`,
`LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `WHISPER_CPP_PATH`, and
`WHISPER_MODEL_PATH` can override defaults. `LM_STUDIO_MODEL` is optional and
only needed to select among multiple loaded LLMs.

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

## Publishing a release

1. Update `package.json` to the intended semantic version and merge the release
   commit.
2. Create and push the matching tag, for example `v1.1.0`.
3. The `Release` GitHub Actions workflow validates that the tag equals the
   package version, runs the project checks, builds AppImage and Debian
   packages, stages installer assets, creates `SHA256SUMS`, and publishes a
   GitHub Release with generated notes.

The workflow can also be dispatched manually for an existing `v`-prefixed tag.
`scripts/prepare-release-assets.sh` reproduces the exact published asset set
from local files under `release/`.

## Main modules

- `src/main/conversation-orchestrator.ts`: cancellation-safe STT → LLM → TTS
  pipeline and temporary-file cleanup.
- `src/main/sentence-chunker.ts`: incremental grammatical text chunking.
- `src/main/lm-studio.ts`: SSE chat-completion stream.
- `src/main/spectre-tools.ts`: validated local tool registry and dispatch.
- `src/main/obsidian-vault.ts`: contained vault discovery, retrieval, and
  append-only writes.
- `src/main/kokoro-client.ts`: local WAV synthesis.
- `src/renderer/vad.ts`: MicVAD callback integration.
- `src/renderer/audio-playback-queue.ts`: sequence ordering, gapless scheduling,
  and FFT analysis.
- `src/renderer/App.tsx`: status UI and procedural audio-reactive R3F orb.

The window remains frameless, always-on-top, and fully transparent for
Hyprland. The default class is `spectre` and can be changed with
`WINDOW_MANAGER_CLASS`.
