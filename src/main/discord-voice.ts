import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  Events,
  GuildMember,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type DMChannel,
  type NewsChannel,
  type NonThreadGuildBasedChannel,
  type TextChannel,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";
import { synthesizeSpeech } from "./kokoro-client";
import {
  discordCallerPolicy,
  discordMemoryScopeKey,
  splitDiscordMessage,
  type DiscordConfig,
  type DiscordMemoryStore,
} from "./discord-transport";
import {
  DiscordRateLimiter,
  securityHash,
  type DiscordRequestOrigin,
} from "./discord-security";
import { streamLMStudioResponse } from "./lm-studio";
import type { SpectreMutationPlan } from "./spectre-tools";
import { transcribeAudioBuffer } from "./whisper";

const INPUT_SAMPLE_RATE = 48_000;
const INPUT_CHANNELS = 2;
const MAX_UTTERANCE_SECONDS = 30;
const MAX_PCM_BYTES =
  INPUT_SAMPLE_RATE * INPUT_CHANNELS * 2 * MAX_UTTERANCE_SECONDS;
const MIN_PCM_BYTES = INPUT_SAMPLE_RATE * INPUT_CHANNELS * 2 / 4;
const SPEAKER_SILENCE_MS = 900;
const VOICE_RESPONSE_CHARACTER_LIMIT = 420;
const OVERLAP_NOTICE_COOLDOWN_MS = 5_000;

const VOICE_COMMAND = new SlashCommandBuilder()
  .setName("spectre")
  .setDescription("Control Spectre's Discord voice connection")
  .addSubcommand((command) =>
    command.setName("join").setDescription("Join your allowlisted voice channel")
  )
  .addSubcommand((command) =>
    command.setName("leave").setDescription("Leave the current voice channel")
  )
  .addSubcommand((command) =>
    command.setName("status").setDescription("Show Spectre's voice status")
  );

export interface VoiceJoinDecision {
  accepted: boolean;
  reason?: string;
}

export function isOwnerVoiceCommand(
  config: DiscordConfig,
  userId: string,
): boolean {
  return userId === config.ownerUserId;
}

export interface VoiceResponseRoute {
  spoken: string;
  textDetail?: string;
}

export interface DiscordVoiceControllerOptions {
  client: Client;
  config: DiscordConfig;
  memory: DiscordMemoryStore;
  confirmMutation: (
    plan: SpectreMutationPlan,
    linkedTextChannelId: string,
    origin: DiscordRequestOrigin,
    revalidate: () => Promise<boolean>,
  ) => Promise<boolean>;
}

export function evaluateVoiceJoin(input: {
  config: DiscordConfig;
  userId: string;
  voiceChannelId: string | null;
}): VoiceJoinDecision {
  if (!isOwnerVoiceCommand(input.config, input.userId)) {
    return { accepted: false, reason: "Only Spectre's owner can do that." };
  }
  if (input.config.allowedVoiceChannelIds.size === 0) {
    return {
      accepted: false,
      reason: "Discord voice is not configured with an allowlist.",
    };
  }
  if (!input.voiceChannelId) {
    return {
      accepted: false,
      reason: "Join an allowlisted voice channel first.",
    };
  }
  if (!input.config.allowedVoiceChannelIds.has(input.voiceChannelId)) {
    return {
      accepted: false,
      reason: "That voice channel is not allowlisted for Spectre.",
    };
  }
  if (!input.config.voiceTextChannelMap.has(input.voiceChannelId)) {
    return {
      accepted: false,
      reason: "That voice channel has no linked text channel configured.",
    };
  }
  return { accepted: true };
}

export function extractWakeWordRequest(transcript: string): string | null {
  const match = transcript.match(
    /(?:^|[\s,.;!?])spectre\b[\s,.:;!?\-–—]*(.+)$/i,
  );
  const request = match?.[1]?.trim() ?? "";
  return request || null;
}

export class VoiceConversationSessions {
  private readonly expiresAt = new Map<string, number>();

  constructor(
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  request(
    userId: string,
    voiceChannelId: string,
    transcript: string,
  ): string | null {
    const key = `${voiceChannelId}:${userId}`;
    const wakeWordRequest = extractWakeWordRequest(transcript);
    const now = this.now();
    if (wakeWordRequest) {
      this.expiresAt.set(key, now + this.timeoutMs);
      return wakeWordRequest;
    }
    const expiresAt = this.expiresAt.get(key) ?? 0;
    if (expiresAt <= now) {
      this.expiresAt.delete(key);
      return null;
    }
    const request = transcript.trim();
    if (!request) return null;
    this.expiresAt.set(key, now + this.timeoutMs);
    return request;
  }

  isActive(userId: string, voiceChannelId: string): boolean {
    const key = `${voiceChannelId}:${userId}`;
    const expiresAt = this.expiresAt.get(key) ?? 0;
    if (expiresAt <= this.now()) {
      this.expiresAt.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.expiresAt.clear();
  }
}

export class ActiveVoiceSpeaker {
  private userId: string | null = null;

  acquire(userId: string): boolean {
    if (this.userId !== null) return false;
    this.userId = userId;
    return true;
  }

  release(userId: string): void {
    if (this.userId === userId) this.userId = null;
  }

  current(): string | null {
    return this.userId;
  }

  clear(): void {
    this.userId = null;
  }
}

export function shouldLeaveForChannelDeletion(input: {
  deletedChannelId: string;
  voiceChannelId: string | null;
  linkedTextChannelId: string | null;
}): boolean {
  return input.deletedChannelId === input.voiceChannelId
    || input.deletedChannelId === input.linkedTextChannelId;
}

export function shouldLeaveForBotVoiceState(input: {
  botUserId: string | null;
  updatedUserId: string;
  activeVoiceChannelId: string | null;
  newVoiceChannelId: string | null;
}): boolean {
  return Boolean(
    input.botUserId
    && input.activeVoiceChannelId
    && input.updatedUserId === input.botUserId
    && input.newVoiceChannelId !== input.activeVoiceChannelId,
  );
}

export async function withTransientAudio<T>(
  audio: Buffer,
  operation: (audio: Buffer) => Promise<T>,
): Promise<T> {
  try {
    return await operation(audio);
  } finally {
    audio.fill(0);
  }
}

export function cleanupVoiceResources(resources: {
  abortController: AbortController | null;
  player: Pick<AudioPlayer, "stop">;
  connection: Pick<VoiceConnection, "destroy"> | null;
  speaker: Pick<ActiveVoiceSpeaker, "clear">;
}): void {
  resources.abortController?.abort();
  resources.player.stop(true);
  resources.connection?.destroy();
  resources.speaker.clear();
}

export function routeVoiceResponse(
  response: string,
  detailedOutputSent: boolean,
  toolOutput = false,
): VoiceResponseRoute {
  const trimmed = response.trim();
  if (
    detailedOutputSent
    || toolOutput
    || trimmed.length > VOICE_RESPONSE_CHARACTER_LIMIT
    || splitDiscordMessage(trimmed).length > 1
  ) {
    return {
      spoken: detailedOutputSent
        ? trimmed
        : "I put the details in the linked Discord channel.",
      textDetail: detailedOutputSent ? undefined : trimmed,
    };
  }
  return { spoken: trimmed };
}

function pcmToWav(
  pcm: Buffer,
  sampleRate = INPUT_SAMPLE_RATE,
  channels = INPUT_CHANNELS,
): Buffer {
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

interface ParsedWav {
  sampleRate: number;
  channels: number;
  pcm: Buffer;
}

function parsePcm16Wav(value: ArrayBuffer): ParsedWav {
  const wav = Buffer.from(value);
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Kokoro returned an invalid WAV file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let pcm: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, wav.length);
    if (id === "fmt " && size >= 16) {
      audioFormat = wav.readUInt16LE(start);
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bitsPerSample = wav.readUInt16LE(start + 14);
    } else if (id === "data") {
      pcm = wav.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (
    audioFormat !== 1
    || bitsPerSample !== 16
    || (channels !== 1 && channels !== 2)
    || sampleRate < 8_000
    || !pcm
  ) {
    throw new Error("Kokoro WAV must contain mono or stereo PCM16 audio");
  }
  return { sampleRate, channels, pcm };
}

export function wavToDiscordPcm(value: ArrayBuffer): Buffer {
  const input = parsePcm16Wav(value);
  const inputFrames = Math.floor(input.pcm.length / (input.channels * 2));
  const outputFrames = Math.max(
    1,
    Math.round(inputFrames * INPUT_SAMPLE_RATE / input.sampleRate),
  );
  const output = Buffer.allocUnsafe(outputFrames * INPUT_CHANNELS * 2);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const sourceFrame = Math.min(
      inputFrames - 1,
      Math.floor(frame * input.sampleRate / INPUT_SAMPLE_RATE),
    );
    const sourceOffset = sourceFrame * input.channels * 2;
    const left = input.pcm.readInt16LE(sourceOffset);
    const right = input.channels === 2
      ? input.pcm.readInt16LE(sourceOffset + 2)
      : left;
    output.writeInt16LE(left, frame * 4);
    output.writeInt16LE(right, frame * 4 + 2);
  }
  return output;
}

export class DiscordVoiceController {
  private readonly player: AudioPlayer;
  private readonly speaker = new ActiveVoiceSpeaker();
  private readonly sessions: VoiceConversationSessions;
  private connection: VoiceConnection | null = null;
  private voiceChannelId: string | null = null;
  private linkedTextChannelId: string | null = null;
  private abortController: AbortController | null = null;
  private overlapNoticeAt = 0;
  private readonly rateLimiter: DiscordRateLimiter;
  private started = false;

  constructor(private readonly options: DiscordVoiceControllerOptions) {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    this.rateLimiter = new DiscordRateLimiter(
      options.config.rateLimitPerMinute,
      60_000,
    );
    this.sessions = new VoiceConversationSessions(
      options.config.voiceSessionTimeoutMs,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.registerCommands();
    this.options.client.on(
      Events.ChannelDelete,
      this.handleChannelDelete,
    );
    this.options.client.on(
      Events.ChannelUpdate,
      this.handleChannelUpdate,
    );
    this.options.client.on(
      Events.VoiceStateUpdate,
      this.handleVoiceStateUpdate,
    );
    this.started = true;
  }

  async stop(): Promise<void> {
    this.options.client.off(
      Events.ChannelDelete,
      this.handleChannelDelete,
    );
    this.options.client.off(
      Events.ChannelUpdate,
      this.handleChannelUpdate,
    );
    this.options.client.off(
      Events.VoiceStateUpdate,
      this.handleVoiceStateUpdate,
    );
    cleanupVoiceResources({
      abortController: this.abortController,
      player: this.player,
      connection: this.connection,
      speaker: this.speaker,
    });
    this.abortController = null;
    this.connection = null;
    this.voiceChannelId = null;
    this.linkedTextChannelId = null;
    this.speaker.clear();
    this.sessions.clear();
    this.started = false;
  }

  async handleCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    if (interaction.commandName !== "spectre") return false;
    if (!isOwnerVoiceCommand(this.options.config, interaction.user.id)) {
      await interaction.reply({
        content: "Only Spectre's configured owner can control voice.",
        ephemeral: true,
      });
      return true;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "status") {
      await interaction.reply({
        content: this.connection && this.voiceChannelId
          ? `Spectre is connected to <#${this.voiceChannelId}>. ${
            this.speaker.current()
              ? `Processing <@${this.speaker.current()}>.`
              : "Waiting for “Spectre” or an active conversation session."
          }`
          : "Spectre is not connected to voice.",
        ephemeral: true,
      });
      return true;
    }
    if (subcommand === "leave") {
      if (!this.connection) {
        await interaction.reply({
          content: "Spectre is not connected to voice.",
          ephemeral: true,
        });
        return true;
      }
      await this.leave("Left the voice channel.");
      await interaction.reply({ content: "Spectre left voice.", ephemeral: true });
      return true;
    }
    try {
      await this.join(interaction);
    } catch (error) {
      void error;
      await this.leave();
      const content =
        "Spectre couldn't join voice safely. Check the allowlist, linked channel, and bot permissions.";
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
    return true;
  }

  private async registerCommands(): Promise<void> {
    const applicationId = this.options.client.application?.id
      ?? this.options.client.user?.id;
    if (!applicationId) {
      throw new Error("Discord application ID is unavailable");
    }
    const rest = new REST({ version: "10" }).setToken(
      this.options.config.token,
    );
    const body = [VOICE_COMMAND.toJSON()];
    if (this.options.config.commandGuildIds.size > 0) {
      for (const guildId of this.options.config.commandGuildIds) {
        await rest.put(
          Routes.applicationGuildCommands(applicationId, guildId),
          { body },
        );
      }
      return;
    }
    await rest.put(Routes.applicationCommands(applicationId), { body });
  }

  private async join(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({
        content: "Voice commands must be used in a configured guild.",
        ephemeral: true,
      });
      return;
    }
    const member = interaction.member instanceof GuildMember
      ? interaction.member
      : await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    const decision = evaluateVoiceJoin({
      config: this.options.config,
      userId: interaction.user.id,
      voiceChannelId: voiceChannel?.id ?? null,
    });
    if (!decision.accepted || !voiceChannel) {
      await interaction.reply({
        content: decision.reason ?? "Spectre cannot join that voice channel.",
        ephemeral: true,
      });
      return;
    }
    if (voiceChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: "Spectre supports standard voice channels, not stage channels.",
        ephemeral: true,
      });
      return;
    }
    const botUser = this.options.client.user;
    const permissions = botUser
      ? voiceChannel.permissionsFor(botUser)
      : null;
    if (
      !voiceChannel.joinable
      || !voiceChannel.speakable
      || !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.UseVAD,
      ])
    ) {
      await interaction.reply({
        content: "Spectre lacks permission to view, join, or speak there.",
        ephemeral: true,
      });
      return;
    }
    const linkedTextChannelId =
      this.options.config.voiceTextChannelMap.get(voiceChannel.id)!;
    const linkedTextChannel = await this.fetchLinkedTextChannel(
      linkedTextChannelId,
    );
    if (linkedTextChannel.guildId !== interaction.guild.id) {
      throw new Error("Linked text channel must be in the same guild");
    }
    const textPermissions = botUser
      ? linkedTextChannel.permissionsFor(botUser)
      : null;
    if (!textPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ])) {
      throw new Error("Spectre cannot send messages in the linked text channel");
    }

    if (this.connection) await this.leave();
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection = connection;
    this.voiceChannelId = voiceChannel.id;
    this.linkedTextChannelId = linkedTextChannelId;
    connection.subscribe(this.player);
    connection.receiver.speaking.on("start", (userId) => {
      void this.handleSpeaker(userId).catch((error) => {
        void error;
        console.error("[DISCORD-VOICE] Speaker processing failed safely");
      });
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.recoverOrLeave(connection);
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection === connection) this.resetConnectionState();
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    await linkedTextChannel.send({
      content: [
        "🎙️ Spectre joined voice.",
        "Say “Spectre” once to open a five-minute natural conversation session. Each exchange refreshes the timer.",
        "Audio is processed transiently and raw recordings are not retained.",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    await interaction.reply({
      content: `Spectre joined <#${voiceChannel.id}>.`,
      ephemeral: true,
    });
  }

  private async handleSpeaker(userId: string): Promise<void> {
    const connection = this.connection;
    const voiceChannelId = this.voiceChannelId;
    const linkedTextChannelId = this.linkedTextChannelId;
    if (!connection || !voiceChannelId || !linkedTextChannelId) return;
    const user = await this.options.client.users.fetch(userId);
    if (user.bot) return;
    if (!this.speaker.acquire(userId)) {
      if (Date.now() - this.overlapNoticeAt >= OVERLAP_NOTICE_COOLDOWN_MS) {
        this.overlapNoticeAt = Date.now();
        await this.sendLinkedText(
          "Spectre is already processing another speaker; overlapping audio was ignored.",
        );
      }
      return;
    }

    const opus = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SPEAKER_SILENCE_MS,
      },
    });
    const decoder = new prism.opus.Decoder({
      rate: INPUT_SAMPLE_RATE,
      channels: INPUT_CHANNELS,
      frameSize: 960,
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const timeout = setTimeout(
      () => this.abortController?.abort(),
      this.options.config.requestTimeoutMs,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        decoder.on("data", (chunk: Buffer) => {
          byteLength += chunk.length;
          if (byteLength > MAX_PCM_BYTES) {
            decoder.destroy(new Error("Voice utterance exceeded 30 seconds"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        decoder.once("end", resolve);
        decoder.once("error", reject);
        opus.once("error", reject);
        opus.pipe(decoder);
      });
      if (byteLength < MIN_PCM_BYTES || signal.aborted) return;
      const pcm = Buffer.concat(chunks, byteLength);
      chunks.length = 0;
      await withTransientAudio(pcm, async (transientPcm) => {
        const wav = pcmToWav(transientPcm);
        try {
          const transcript = await transcribeAudioBuffer(wav, signal);
          const prompt = this.sessions.request(
            userId,
            voiceChannelId,
            transcript,
          );
          if (!prompt || signal.aborted) return;
          if (prompt.length > this.options.config.maxInputCharacters) {
            console.warn("[DISCORD-SECURITY] denied oversized_voice_request");
            await this.sendLinkedText(
              "That voice request is too large for Spectre to process safely.",
            );
            return;
          }
          const rateKey = `${userId}:${voiceChannelId}`;
          if (!this.rateLimiter.allow(rateKey)) {
            console.warn("[DISCORD-SECURITY] denied voice_rate_limit");
            await this.sendLinkedText(
              "Spectre is rate-limiting that speaker. Try again shortly.",
            );
            return;
          }
          await this.processRequest(
            userId,
            voiceChannelId,
            linkedTextChannelId,
            prompt,
            signal,
          );
        } finally {
          clearTimeout(timeout);
          wav.fill(0);
        }
      });
    } finally {
      chunks.forEach((chunk) => chunk.fill(0));
      chunks.length = 0;
      opus.destroy();
      decoder.destroy();
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
      this.speaker.release(userId);
    }
  }

  private async processRequest(
    userId: string,
    voiceChannelId: string,
    linkedTextChannelId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const owner = userId === this.options.config.ownerUserId;
    const scope = discordMemoryScopeKey({
      userId,
      channelId: `voice:${voiceChannelId}`,
      guildId: this.connection?.joinConfig.guildId ?? null,
    });
    const memoryContext = await this.options.memory.context(scope);
    let detailedOutputSent = false;
    let toolUsed = false;
    const parts: string[] = [];
    const origin: DiscordRequestOrigin = {
      ownerUserId: this.options.config.ownerUserId,
      callerUserId: userId,
      guildId: this.connection?.joinConfig.guildId ?? null,
      channelId: voiceChannelId,
      sessionId: scope,
      requestMessageId: null,
      requestContentHash: securityHash(prompt),
    };
    const callerPolicy = discordCallerPolicy(
      owner,
      (plan) =>
        this.options.confirmMutation(
          plan,
          linkedTextChannelId,
          origin,
          () => this.revalidateVoiceOrigin(origin),
        ),
    );
    callerPolicy.additionalSystemInstructions = [
      callerPolicy.additionalSystemInstructions,
      "This request will be answered in a Discord voice channel.",
      "Keep spoken output brief. Never speak secrets, raw sensitive payloads, long reports, or detailed tool output; direct those details to the linked text channel.",
    ].filter((value): value is string => Boolean(value)).join(" ");
    for await (const part of streamLMStudioResponse(prompt, {
      signal,
      memoryContext,
      callerPolicy,
      onToolCall: () => {
        toolUsed = true;
      },
      onProgress: async (update) => {
        await this.sendLinkedText(`⏳ <@${userId}> ${update.message}`);
      },
      onStructuredResult: async (result) => {
        detailedOutputSent = true;
        await this.sendDetailedText(result.title, result.content);
      },
    })) {
      parts.push(part);
    }
    const response = parts.join("").trim();
    if (!response || signal.aborted) return;
    const routed = routeVoiceResponse(response, detailedOutputSent, toolUsed);
    if (routed.textDetail) {
      await this.sendDetailedText(`Response for <@${userId}>`, routed.textDetail);
    }
    await this.speak(routed.spoken, signal).catch(async (error) => {
      void error;
      await this.sendLinkedText(
        "I couldn't play the voice response safely. The text result remains in the linked channel.",
      );
    });
    await this.options.memory.remember(scope, prompt, response);
  }

  private async speak(text: string, signal: AbortSignal): Promise<void> {
    if (!text.trim() || signal.aborted) return;
    const wav = await synthesizeSpeech(text, signal);
    const pcm = wavToDiscordPcm(wav);
    try {
      const resource = createAudioResource(Readable.from(pcm), {
        inputType: StreamType.Raw,
      });
      this.player.play(resource);
      await entersState(this.player, AudioPlayerStatus.Idle, 60_000);
    } finally {
      pcm.fill(0);
    }
  }

  private async sendDetailedText(title: string, content: string): Promise<void> {
    const chunks = splitDiscordMessage(`${title}\n\n${content}`);
    for (const chunk of chunks) await this.sendLinkedText(chunk);
  }

  private async sendLinkedText(content: string): Promise<void> {
    if (!this.linkedTextChannelId) return;
    const channel = await this.fetchLinkedTextChannel(
      this.linkedTextChannelId,
    );
    await channel.send({ content, allowedMentions: { parse: [] } });
  }

  private async fetchLinkedTextChannel(
    channelId: string,
  ): Promise<TextChannel | NewsChannel> {
    const channel = await this.options.client.channels.fetch(channelId);
    if (
      !channel
      || (
        channel.type !== ChannelType.GuildText
        && channel.type !== ChannelType.GuildAnnouncement
      )
    ) {
      throw new Error("Configured voice text channel is unavailable");
    }
    return channel;
  }

  private async recoverOrLeave(connection: VoiceConnection): Promise<void> {
    if (this.connection !== connection) return;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      await this.leave(
        "Spectre left voice after losing the connection or required permissions.",
      );
    }
  }

  private async revalidateVoiceOrigin(
    origin: DiscordRequestOrigin,
  ): Promise<boolean> {
    return Boolean(
      this.connection
      && this.voiceChannelId === origin.channelId
      && this.speaker.current() === origin.callerUserId
      && origin.ownerUserId === this.options.config.ownerUserId
      && origin.callerUserId === this.options.config.ownerUserId
      && origin.requestContentHash
      && this.options.config.allowedVoiceChannelIds.has(origin.channelId)
      && this.options.config.voiceTextChannelMap.has(origin.channelId),
    );
  }

  private async leave(notice?: string): Promise<void> {
    const linkedTextChannelId = this.linkedTextChannelId;
    cleanupVoiceResources({
      abortController: this.abortController,
      player: this.player,
      connection: this.connection,
      speaker: this.speaker,
    });
    this.abortController = null;
    this.resetConnectionState();
    if (notice && linkedTextChannelId) {
      await this.sendTextToChannel(linkedTextChannelId, notice).catch((error) => {
        console.error(
          "[DISCORD-VOICE] Leave notice failed safely",
        );
        void error;
      });
    }
  }

  private async sendTextToChannel(
    channelId: string,
    content: string,
  ): Promise<void> {
    const channel = await this.fetchLinkedTextChannel(channelId);
    await channel.send({ content, allowedMentions: { parse: [] } });
  }

  private resetConnectionState(): void {
    this.connection = null;
    this.voiceChannelId = null;
    this.linkedTextChannelId = null;
    this.speaker.clear();
    this.sessions.clear();
  }

  private readonly handleChannelDelete = (
    channel: DMChannel | NonThreadGuildBasedChannel,
  ): void => {
    if (shouldLeaveForChannelDeletion({
      deletedChannelId: channel.id,
      voiceChannelId: this.voiceChannelId,
      linkedTextChannelId: this.linkedTextChannelId,
    })) {
      void this.leave();
    }
  };

  private readonly handleVoiceStateUpdate = (
    _oldState: VoiceState,
    newState: VoiceState,
  ): void => {
    if (this.connection && shouldLeaveForBotVoiceState({
      botUserId: this.options.client.user?.id ?? null,
      updatedUserId: newState.id,
      activeVoiceChannelId: this.voiceChannelId,
      newVoiceChannelId: newState.channelId,
    })) {
      void this.leave();
    }
  };

  private readonly handleChannelUpdate = (
    _oldChannel: DMChannel | NonThreadGuildBasedChannel,
    newChannel: DMChannel | NonThreadGuildBasedChannel,
  ): void => {
    const botUser = this.options.client.user;
    if (!botUser || !this.connection) return;
    if (newChannel.id === this.voiceChannelId) {
      if (newChannel.type !== ChannelType.GuildVoice) {
        void this.leave();
        return;
      }
      const permissions = newChannel.permissionsFor(botUser);
      if (
        !newChannel.joinable
        || !newChannel.speakable
        || !permissions?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.UseVAD,
        ])
      ) {
        void this.leave(
          "Spectre left voice after losing required channel permissions.",
        );
      }
      return;
    }
    if (newChannel.id !== this.linkedTextChannelId) return;
    if (
      (
        newChannel.type !== ChannelType.GuildText
        && newChannel.type !== ChannelType.GuildAnnouncement
      )
      || !newChannel.permissionsFor(botUser)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])
    ) {
      void this.leave();
    }
  };
}
