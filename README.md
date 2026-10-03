# SPECTRE

Local English voice assistant for Electron with a transparent, audio-reactive
Digital Noir orb.

## Install a release

Spectre currently publishes Linux x86_64 AppImage and Debian assets. The
user-level installer verifies release checksums, installs the AppImage under
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/app`, creates the `spectre`
launcher and desktop entry, provisions managed Python 3.12 with `uv`, installs
the local voice dependencies, and downloads the Faster Whisper
`large-v3-turbo` model.
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
   `http://127.0.0.1:1234/v1/chat/completions` with the concise English
   `CONTEXT_MESSAGES`. OpenAI-compatible tool calls can retrieve the current
   date/time, local system status, the user's Obsidian second brain, approved
   local Git projects, and Sandcastle workflow status. Spectre may prepare an
   immutable issue-implementation plan, but the model cannot start it directly.
   It can also read the local GitHub monitor's recent pull request activity.
   Vault access supports secure search, read, create, and append operations.
   Every request receives an optional planning pass over the complete safe tool
   registry. Spectre can compose results across as many as twelve planning
   rounds and thirty-two bounded tool calls, while deterministic routes remain
   fast paths rather than required phrases.
   Before the request, Spectre retrieves a bounded set of recent and
   topic-relevant completed conversation turns from its local memory. Recalled
   text is clearly labelled as historical data, not instructions.
   Spectre can also search the public web and read public pages. Explicit
   research requests route directly to this capability; for ordinary factual
   questions, the local model may choose it when current external information
   is needed.
5. `SentenceChunker` emits grammatical `.?!;:` boundaries, strategic commas,
   and max-length word-boundary chunks without dropping punctuation.
6. Each chunk is synthesized serially by local Kokoro at
   `http://127.0.0.1:1235/tts`. The default American English voice is the
   male `am_michael` model at speed `1.1`; override either choice with
   `TTS_VOICE` or `TTS_SPEED`. Kokoro uses CUDA when available and keeps the
   warm model in memory so subsequent replies synthesize with low latency.
7. The renderer reorders chunks by sequence and schedules decoded WAV buffers
   continuously through one `AnalyserNode`. FFT amplitude, bass, and treble
   drive the R3F shader every frame and decay smoothly to its idle motion.
8. MicVAD remains active during playback with browser echo cancellation.
   Speech immediately stops assistant audio. Follow-up speech during active
   tool work is queued without cancelling the task and is processed afterward.

Starting a new speech segment while Spectre is speaking cancels that spoken
turn and stops queued playback. Speech received while a tool task is still
thinking is queued instead, so the active task can finish. Conversation state,
progress, transcript, reply, audio, completion, and error events use the shared
types in `src/types/ipc.ts`.

Only successfully completed conversations are remembered. Failed, cancelled,
and partial turns are not retained. Memory is stored atomically with mode
`0600` below Electron's `userData/conversation-memory/`. The live history is
bounded to 200 turns; older turns are deterministically compacted in batches of
40 into bounded summaries. The Memory panel shows recent retained turns and
allows retention to be paused, resumed, or permanently erased with a native
confirmation. Pausing memory also disables recall.

Spectre has an in-app text presentation surface for material that should not be
read aloud in full. Confirmations, grilling questions, terminal commands, setup
instructions, plans, and other long text appear in a selectable, copyable
panel. Voice output gives only a short contextual cue that directs the user to
the panel. Long multi-item results such as repository, issue, branch, release,
or workflow listings are automatically converted into spaced list cards rather
than filling the transcript or being read aloud. Internal tool-call syntax is
never shown in the transcript: compatible fallback calls are executed through
the typed tool boundary, and malformed or unexecuted calls fail closed.

Voice activity detection remains active while Spectre is speaking. Browser echo
cancellation limits self-triggering; when the user starts talking, Spectre
immediately stops current and queued audio and begins listening. Spoken replies
remain interruptible, while active tool work is preserved and additional speech
is queued. The previous transcript remains visible until transcription of the
new utterance begins the next turn.

Long tasks publish concise progress events for planning and each tool step.
Spectre shows the latest steps in an in-app task list with working, completed,
and failed states. The first active tool step and periodic later milestones may
also play a short conversational cue such as “I'm working on it, man. Give me
a minute,” without reading the task details aloud. Spectre speaks like a polite,
concise close friend and may use occasional dry humor or mild profanity when it
fits naturally. Tool use, code, reports, confirmations, and risk judgments
remain strictly professional.

Spectre can inspect the local filesystem through typed operations: list
directories, inspect metadata, read bounded text files, and search filenames.
Read access follows the current user's filesystem permissions but always blocks
credentials, SSH/GPG material, browser profiles and sessions, environment
secrets, communications data, and virtual or privileged system paths such as
`/proc`, `/sys`, `/dev`, `/run`, and `/root`. Mutations are limited to
non-sensitive paths inside the user's home directory, support typed
create/write/copy/move/delete operations, and require an exact in-app
confirmation every time. Spectre has no arbitrary shell interface.

When a user asks Spectre to open or show an answer in Neovim, a code editor, or
a Herdr pane, Spectre allows a larger response, skips speech synthesis for that
long report, writes it as a mode-`0600` Markdown file below Electron's
`userData/presentations/`, creates a sibling Herdr pane, and runs
`nvim -R -M` so the report is read-only and non-modifiable. Spectre passes no
user-provided command to the shell. If Spectre inherited a Herdr pane context,
the new pane is split from it; otherwise Herdr uses the currently focused pane.

## Setup

```bash
npm install
npm run setup:runtime
```

The managed Python 3.12 runtime is stored at
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/python`. Override it with
`SPECTRE_PYTHON_RUNTIME`, or set `PYTHON_CMD` to use another compatible
interpreter.

The managed Whisper runtimes and multilingual `large-v3-turbo` models are stored at
`${XDG_DATA_HOME:-$HOME/.local/share}/spectre/whisper`. Override that location
with `SPECTRE_WHISPER_RUNTIME`, or use `WHISPER_CPP_PATH` and
`WHISPER_MODEL_PATH` for a custom installation. Spectre selects the optimized
Haswell/AVX2 GGML backend when the CPU supports it and otherwise uses the
portable x64 backend for legacy whisper.cpp calls. Live conversations use a
warm CTranslate2 model in the local Python service to avoid loading a new model
for every utterance. It defaults to CUDA `int8_float16` and falls back
explicitly to CPU `int8` if GPU loading fails. Set `WHISPER_MODEL`,
`WHISPER_DEVICE`, or `WHISPER_COMPUTE_TYPE` to override those choices. Set
`WHISPER_BACKEND_PATH` to choose another whisper.cpp backend. Its decoding
prompt targets US English and its hotword list preserves common
Spectre stack names.

Spectre discovers the active vault from
`~/.config/obsidian/obsidian.json`. Set `SPECTRE_OBSIDIAN_VAULT` to use a
different vault. Vault writes are append-only and restricted to the standard
`00 Inbox`, `10 Projects`, `20 Decisions`, `30 Knowledge`, and `40 Sessions`
folders. Hidden paths, traversal, external symlinks, oversized notes, and
content resembling credentials are rejected.

Spectre discovers Git repositories under `~/dev` for its Sandcastle workflow
panel and tools. Set `SPECTRE_PROJECT_ROOTS` to a platform path-delimited list
of other approved roots. Symlinked directories and repositories outside those
roots are rejected.

Install the Grove Sandcastle runtime so `grove-sandcastle` and `herdr` are on
`PATH`. Spectre talks only to the runtime's JSON control plane; it does not
expose arbitrary shell execution. An issue workflow must first be rendered as
an immutable, hashed plan. Plans expire after 15 minutes, can be opened as a
read-only temporary Markdown file, and require a native Electron confirmation before Spectre starts `imp --draft` in a visible Herdr pane. The
Workflows panel polls
the runtime for live steps, agents, progress, blocked states, and failures.
Stopping a run requires a second native confirmation and uses Sandcastle's
owned-process validation. Spectre also requires the runtime's `capabilities`
response to advertise draft pull request support; it refuses to start rather
than allowing an older runtime to publish a normal PR.

Authenticate the GitHub CLI with `gh auth login` to enable the read-only PR
monitor. Spectre silently establishes a baseline for every non-archived
repository owned by the active account, then polls every 60 seconds with
per-repository ETags. Only later opens, updates, new commits, ready-for-review
transitions, closes, and reopens produce local events and desktop
notifications. State is written atomically with mode `0600` below Electron's
`userData/github-monitor/`; private repository data is not sent to another
service. Set `SPECTRE_GITHUB_POLL_INTERVAL_MS` to an interval of at least
15,000 milliseconds.

Spectre also exposes a typed `gh` control plane for repositories owned by the
active personal account. Reads cover repositories, issues, pull requests,
branches, releases, and Actions runs. Confirmed writes cover issue creation,
editing, comments and state; pull request creation, editing, comments, reviews,
draft/ready state and merges; branch-ref creation and deletion; release
creation, editing and deletion; and Actions dispatch, rerun, and cancellation.
Every write displays an in-app confirmation containing the repository,
operation, and exact payload before any mutating `gh` command runs. Spectre
does not expose arbitrary `gh` arguments or a general shell, and repositories
outside the authenticated user's personal account are rejected.

Owned repositories can also be cloned through a typed `repository_clone`
operation. The destination is restricted to configured project roots
(`~/dev` by default), must not already exist, and is shown in the confirmation
before `gh repo clone` runs.

## Optional Discord bot

Spectre can run an official Discord application bot alongside the desktop
assistant. It is disabled by default and never supports user tokens or
self-bots. DMs are accepted, with non-owners restricted to chat only. In
guilds, Spectre responds only
when explicitly mentioned in an allowlisted text channel; an empty allowlist
fails closed.

See [`docs/discord-setup.md`](docs/discord-setup.md) for the complete
beginner-friendly server, Developer Portal, deployment, security, smoke-test,
troubleshooting, token-rotation, and incident-response guide.

Set the following process environment variables; `.env.example` lists the same
keys for development and launcher configuration:

```dotenv
SPECTRE_DISCORD_ENABLED=true
SPECTRE_DISCORD_TOKEN=
SPECTRE_DISCORD_OWNER_USER_ID=123456789012345678
SPECTRE_DISCORD_ALLOWED_CHANNEL_IDS=234567890123456789
SPECTRE_DISCORD_ALLOWED_VOICE_CHANNEL_IDS=345678901234567890
SPECTRE_DISCORD_VOICE_TEXT_CHANNEL_MAP=345678901234567890:234567890123456789
SPECTRE_DISCORD_COMMAND_GUILD_IDS=456789012345678901
SPECTRE_DISCORD_REQUEST_TIMEOUT_MS=90000
SPECTRE_DISCORD_RATE_LIMIT_PER_MINUTE=8
SPECTRE_DISCORD_MAX_INPUT_CHARACTERS=1800
```

Optional settings control confirmation expiry, notification polling and digest
intervals, and the enabled notification types. The supported notification
types are `review_requested`, `ci_failed`, `issue_assigned`,
`github_mention`, and `workflow_completed`. Actionable events are sent
immediately to the owner DM. Events marked routine are queued for the digest;
none of the initial event sources are routine by default.

The owner receives Spectre's typed capabilities. Read tools may run directly,
but every Discord-initiated GitHub, filesystem, Obsidian, or Sandcastle
mutation requires a short-lived owner-only button confirmation in the owner's
DM. Confirmation custom IDs contain only a random one-time nonce. Other Discord
users receive chat only: the tool registry is empty in code, not merely hidden
by a prompt. Discord memory is stored separately below Electron `userData`,
partitioned by user plus guild text channel, voice channel, or DM, and is never
mixed with desktop voice memory.

Discord voice is controlled only by the configured owner:

- `/spectre join` joins the owner's current standard voice channel only when
  its ID is in `SPECTRE_DISCORD_ALLOWED_VOICE_CHANNEL_IDS` and it has a linked
  text channel in `SPECTRE_DISCORD_VOICE_TEXT_CHANNEL_MAP`.
- `/spectre leave` disconnects and cancels transient voice processing.
- `/spectre status` reports the current channel and active-speaker state.

The mapping is a comma-separated list of `voiceChannelId:textChannelId` pairs.
Every allowlisted voice channel must have one mapping. Voice fails closed when
the allowlist is empty. `SPECTRE_DISCORD_COMMAND_GUILD_IDS` is a
comma-separated guild allowlist used to synchronize guild-scoped slash
commands immediately; when it is empty, the command is registered globally and
Discord's normal propagation delay applies.

After joining, Spectre posts a visible privacy notice in the linked text
channel. It listens to speakers in that channel but processes an utterance only
when Faster Whisper hears the wake word “Spectre”; the wake word is stripped
before the request reaches the model. Only one speaker is captured and
processed at a time. Overlapping speakers are ignored rather than mixed or
queued. Owner voice requests use the owner tool policy; every other speaker has
an empty tool registry and conversational chat only.

Incoming Opus is decoded to PCM in memory, wrapped as an in-memory WAV for the
existing local Faster Whisper endpoint, and zeroed after completion or failure.
Raw audio is never written to disk. Only the wake-word-stripped request and
assistant response may enter the existing isolated Discord conversation memory.
Raw transcripts are not logged by the Discord voice path. Concise responses
are synthesized by the existing local Kokoro service and played into Discord;
long or structured output goes to the linked text channel instead. Mutation
confirmations remain owner-bound, short-lived Discord buttons sent privately
to the owner, with a visible linked-channel status notice.

Voice uses `@discordjs/voice`, `prism-media`, and the pure-JavaScript
`opusscript` codec. Development requires Node.js 22.12 or newer, matching
`@discordjs/voice`; packaged Electron includes its own compatible Node runtime.
The raw-PCM pipeline does not require FFmpeg or a native Opus compiler.

For long guild work Spectre creates or reuses a thread; DMs stay in the DM.
Replies are split below Discord's message limit. Discord content is treated as
untrusted context and cannot authorize tools or override system policy. Token
values are never logged.

Prompt-injection resistance is defense in depth, not an absolute security
guarantee. Caller authority comes only from configured Discord IDs. Spectre
builds a fixed tool set in code before model invocation, gives non-owners no
tools, wraps current requests, memory, and tool results in explicit untrusted
data envelopes, and requires server-side owner confirmation for mutations.
Confirmations are bound to the validated typed operation, payload, owner,
originating session, original request, one-use nonce, and expiry. Discord
messages, voice transcripts, replies, usernames, channel metadata, webpages,
GitHub content, notes, and tool output remain untrusted data even when they
claim to be system instructions or authorization.

Discord security regression coverage is release-blocking. The release workflow
runs `npm run test:discord-security` before the complete test, type-check, lint,
build, and packaging steps.

In the Discord Developer Portal:

1. Create an application and add a Bot user.
2. Enable the privileged **Message Content Intent**. Spectre also uses the
   standard Guilds, Guild Messages, Direct Messages, and Guild Voice States
   intents. Guild Voice States is not privileged but is required for joining,
   receiving speakers, and detecting disconnects.
3. Install the bot with the `bot` scope and only the channel permissions it
   needs: View Channels, Send Messages, Read Message History, Connect, Speak,
   Use Voice Activity, and Create Public Threads/Send Messages in Threads when
   thread replies are desired. Add the `applications.commands` scope so the
   `/spectre` command can be synchronized.
4. Enable Developer Mode in Discord, copy the owner user ID and allowed channel
   IDs, then set the environment variables above. Do not paste a real token
   into source control.

Invalid Discord configuration is logged explicitly and disables only the
transport. Login or runtime network failures never stop Electron desktop
startup.

Public web research uses DuckDuckGo's public HTML search and direct HTTP/HTTPS
page reads. It requires no web account or API key. Requests are GET-only,
bounded to 15 seconds and 1 MB, and accept only readable text, HTML, XHTML, or
JSON. Spectre rejects credentials embedded in URLs, downloads, local hostnames,
literal private addresses, DNS names resolving to private addresses, and
redirects into local/private networks. It does not submit forms, execute page
scripts, preserve cookies, use authenticated browser sessions, or perform web
writes. Retrieved pages are labelled as untrusted reference material and source
URLs are supplied to the model for attribution.

An explicit web-research request is handled as a report rather than a long
spoken answer. Spectre generates and remembers the full sourced result, opens
it read-only in a new Neovim/Herdr pane, updates the transcript with a short
completion acknowledgement, and synthesizes only that acknowledgement. If no
readable evidence is available, Spectre speaks the failure and does not open an
editor report.

Start LM Studio on port 1234 and load the chat model you want Spectre to use.
Spectre discovers the single loaded LLM through LM Studio's local API. If
multiple LLMs are loaded, set `LM_STUDIO_MODEL` to the desired instance ID.

Then run:

```bash
npm run dev
```

The Electron main process starts the Kokoro/Faster Whisper FastAPI service on
dedicated port 1235. `TTS_SERVER_PORT`, `TTS_VOICE`, `TTS_SPEED`,
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
- `src/main/sandcastle-service.ts`: approved project discovery, immutable
  workflow planning, and the constrained `grove-sandcastle` JSON client.
- `src/main/github-monitor.ts`: read-only owned-repository PR polling, ETag
  cursors, durable local event history, and observe-and-propose notifications.
- `src/main/obsidian-vault.ts`: contained vault discovery, retrieval, and
  append-only writes.
- `src/main/kokoro-client.ts`: local Kokoro WAV synthesis client.
- `src/renderer/vad.ts`: MicVAD callback integration.
- `src/renderer/audio-playback-queue.ts`: sequence ordering, gapless scheduling,
  and FFT analysis.
- `src/renderer/App.tsx`: status UI and procedural audio-reactive R3F orb.

The window remains frameless, always-on-top, and fully transparent for
Hyprland. The default class is `spectre` and can be changed with
`WINDOW_MANAGER_CLASS`.
