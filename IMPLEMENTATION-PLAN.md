# SPECTRE implementation

## Process boundaries

### Renderer

- `MicVAD` owns microphone acquisition and supplies complete 16 kHz speech
  segments through `onSpeechEnd(audio)`.
- The renderer calls `processConversation(Float32Array)` on the typed preload
  API. It does not write files, invoke Whisper, or directly call AI services.
- `AudioPlaybackQueue` buffers out-of-order sequence numbers, decodes in FIFO
  order, and schedules every `AudioBufferSourceNode` against one continuous
  Web Audio timeline.
- Every source connects to the same `AnalyserNode`. `analyze()` exposes
  amplitude, bass, treble, and playback state.
- The R3F orb reads those values in `useFrame`, applies attack/decay smoothing,
  and updates `uAmplitude`, `uBass`, and `uTreble`. Valid procedural value noise
  produces idle deformation; audio increases displacement and scale.

### Preload

`src/preload/index.ts` exposes only typed methods:

- `processConversation(audio)`
- `cancelConversation()`
- `onConversationEvent(listener)`, returning a listener-removal function
- compatible legacy WAV, Whisper, Python status, and TTS methods

### Main

`ConversationOrchestrator` owns one active request and one `AbortController`.
For each speech segment it:

1. writes a unique WAV below `app.getPath("userData")`;
2. invokes the existing Whisper.cpp handler;
3. streams LM Studio using the US English system context and default
   `qwen/qwen3.5-9b`;
4. feeds every token to `SentenceChunker`;
5. serializes Kokoro `/tts` calls and emits numbered WAV events;
6. emits state, transcript, incremental reply, completion, and explicit error
   events;
7. removes the WAV in `finally`.

New speech aborts the old request. Abort signals propagate to LM Studio and
Kokoro fetches; stale requests cannot emit further audio.

## Text and speech

`SentenceChunker` preserves delimiters and emits:

- sentences at `.`, `?`, and `!`;
- clauses at `;` and `:`;
- long clauses at strategic commas;
- oversized text at the nearest preceding word boundary;
- remaining text on stream completion.

Kokoro is kept hot by the FastAPI lifespan. It uses `KPipeline(lang_code="a")`
by default, selects CUDA when available, defaults to `am_michael`, and returns
24 kHz PCM WAV from port 1235.

## Visual design

The Electron window, root element, and R3F canvas are transparent at full
window size. The shader uses a near-black graphite core, cold high-contrast rim
halo, procedural surface noise, and subtle idle breathing/rotation. Playback
FFT values provide stronger bass scale/deformation and treble detail, then
decay to the idle baseline.

## Build and runtime

```bash
npm run setup:python
npm run dev
npm test
npm run type-check
npm run lint
npm run build
npm run build:electron
```

LM Studio listens on `127.0.0.1:1234`; Kokoro uses `127.0.0.1:1235`.
Electron Builder includes the Python sources and unpacks
`src/main/python_server/**/*` from ASAR.
