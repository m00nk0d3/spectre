import { describe, expect, it, vi } from "vitest";
import {
  ActiveVoiceSpeaker,
  cleanupVoiceResources,
  evaluateVoiceJoin,
  extractWakeWordRequest,
  isVoiceCaptureSuppressed,
  isOwnerVoiceCommand,
  routeVoiceResponse,
  shouldLeaveForBotVoiceState,
  shouldLeaveForChannelDeletion,
  VoiceConversationSessions,
  withTransientAudio,
} from "../src/main/discord-voice";
import {
  discordToolNamesForCaller,
  loadDiscordConfig,
  type DiscordConfig,
} from "../src/main/discord-transport";

function voiceConfig(
  overrides: Partial<DiscordConfig> = {},
): DiscordConfig {
  return {
    enabled: true,
    token: "token",
    ownerUserId: "100",
    allowedChannelIds: new Set(["200"]),
    allowedVoiceChannelIds: new Set(["300"]),
    voiceTextChannelMap: new Map([["300", "200"]]),
    commandGuildIds: new Set(["400"]),
    confirmationTtlMs: 1_000,
    digestIntervalMs: 60_000,
    enabledNotifications: new Set(),
    requestTimeoutMs: 90_000,
    rateLimitPerMinute: 8,
    maxInputCharacters: 1_800,
    voiceSessionTimeoutMs: 300_000,
    ...overrides,
  };
}

describe("Discord voice authorization and configuration", () => {
  it("allows only the configured owner to control voice commands", () => {
    const config = voiceConfig();
    expect(isOwnerVoiceCommand(config, "100")).toBe(true);
    expect(isOwnerVoiceCommand(config, "101")).toBe(false);
    expect(evaluateVoiceJoin({
      config,
      userId: "101",
      voiceChannelId: "300",
    })).toEqual({
      accepted: false,
      reason: "Only Spectre's owner can do that.",
    });
  });

  it("fails closed without a voice allowlist or linked text channel", () => {
    expect(evaluateVoiceJoin({
      config: voiceConfig({
        allowedVoiceChannelIds: new Set(),
        voiceTextChannelMap: new Map(),
      }),
      userId: "100",
      voiceChannelId: "300",
    }).reason).toContain("not configured with an allowlist");
    expect(evaluateVoiceJoin({
      config: voiceConfig({ voiceTextChannelMap: new Map() }),
      userId: "100",
      voiceChannelId: "300",
    }).reason).toContain("no linked text channel");
  });

  it("parses explicit voice channels, text links, and guild commands", () => {
    const result = loadDiscordConfig({
      SPECTRE_DISCORD_ENABLED: "true",
      SPECTRE_DISCORD_TOKEN: "token",
      SPECTRE_DISCORD_OWNER_USER_ID: "100",
      SPECTRE_DISCORD_ALLOWED_CHANNEL_IDS: "200",
      SPECTRE_DISCORD_ALLOWED_VOICE_CHANNEL_IDS: "300",
      SPECTRE_DISCORD_VOICE_TEXT_CHANNEL_MAP: "300:200",
      SPECTRE_DISCORD_COMMAND_GUILD_IDS: "400",
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error("Expected enabled Discord config");
    expect([...result.config.allowedVoiceChannelIds]).toEqual(["300"]);
    expect([...result.config.voiceTextChannelMap]).toEqual([["300", "200"]]);
    expect([...result.config.commandGuildIds]).toEqual(["400"]);
  });

  it("rejects incomplete or non-allowlisted voice mappings", () => {
    expect(() => loadDiscordConfig({
      SPECTRE_DISCORD_ENABLED: "true",
      SPECTRE_DISCORD_TOKEN: "token",
      SPECTRE_DISCORD_OWNER_USER_ID: "100",
      SPECTRE_DISCORD_ALLOWED_CHANNEL_IDS: "200",
      SPECTRE_DISCORD_ALLOWED_VOICE_CHANNEL_IDS: "300",
    })).toThrow("linked text channel");
    expect(() => loadDiscordConfig({
      SPECTRE_DISCORD_ENABLED: "true",
      SPECTRE_DISCORD_TOKEN: "token",
      SPECTRE_DISCORD_OWNER_USER_ID: "100",
      SPECTRE_DISCORD_ALLOWED_CHANNEL_IDS: "200",
      SPECTRE_DISCORD_VOICE_TEXT_CHANNEL_MAP: "300:200",
    })).toThrow("allowlisted voice channels");
  });
});

describe("Discord voice utterance policy", () => {
  it("requires and strips the spoken wake word", () => {
    expect(extractWakeWordRequest("Spectre, check the CI status."))
      .toBe("check the CI status.");
    expect(extractWakeWordRequest("Hey Spectre — tell me a joke."))
      .toBe("tell me a joke.");
    expect(extractWakeWordRequest("Tell me a joke.")).toBeNull();
    expect(extractWakeWordRequest("Spectre")).toBeNull();
  });

  it("keeps a per-speaker conversation active until five minutes of inactivity", () => {
    let now = 1_000;
    const sessions = new VoiceConversationSessions(
      5 * 60 * 1_000,
      () => now,
    );

    expect(sessions.request("100", "300", "Tell me a joke.")).toBeNull();
    expect(sessions.request("100", "300", "Spectre, tell me a joke."))
      .toBe("tell me a joke.");
    expect(sessions.isActive("100", "300")).toBe(true);
    expect(sessions.request("100", "300", "Another one."))
      .toBe("Another one.");
    expect(sessions.request("101", "300", "Another one.")).toBeNull();
    expect(sessions.request("100", "301", "Another one.")).toBeNull();

    now += 4 * 60 * 1_000;
    expect(sessions.request("100", "300", "Keep going."))
      .toBe("Keep going.");
    now += 5 * 60 * 1_000 + 1;
    expect(sessions.request("100", "300", "Are you there?")).toBeNull();
    expect(sessions.isActive("100", "300")).toBe(false);
  });

  it("allows one active speaker and rejects overlaps without queueing", () => {
    const speaker = new ActiveVoiceSpeaker();
    expect(speaker.acquire("100")).toBe(true);
    expect(speaker.acquire("101")).toBe(false);
    expect(speaker.shouldNotifyOverlap()).toBe(true);
    expect(speaker.shouldNotifyOverlap()).toBe(false);
    expect(speaker.current()).toBe("100");
    speaker.release("101");
    expect(speaker.current()).toBe("100");
    expect(speaker.shouldNotifyOverlap()).toBe(false);
    speaker.release("100");
    expect(speaker.acquire("101")).toBe(true);
    expect(speaker.shouldNotifyOverlap()).toBe(true);
    speaker.clear();
    expect(speaker.current()).toBeNull();
    expect(speaker.shouldNotifyOverlap()).toBe(false);
  });

  it("suppresses receiver starts during the post-playback echo guard", () => {
    expect(isVoiceCaptureSuppressed(10_000, 12_000)).toBe(true);
    expect(isVoiceCaptureSuppressed(12_000, 12_000)).toBe(false);
    expect(isVoiceCaptureSuppressed(13_000, 12_000)).toBe(false);
  });

  it("maps owner voice to tools and other speakers to chat only", () => {
    expect(discordToolNamesForCaller(true)).toContain("github_read");
    expect(discordToolNamesForCaller(false)).toEqual([]);
  });
});

describe("Discord voice transient audio and response routing", () => {
  it("zeroes transient audio after success and error paths", async () => {
    const success = Buffer.from([1, 2, 3]);
    await expect(withTransientAudio(success, async () => "ok"))
      .resolves.toBe("ok");
    expect([...success]).toEqual([0, 0, 0]);

    const failure = Buffer.from([4, 5, 6]);
    await expect(withTransientAudio(failure, async () => {
      throw new Error("decode failed");
    })).rejects.toThrow("decode failed");
    expect([...failure]).toEqual([0, 0, 0]);
  });

  it("speaks concise replies and routes long details to linked text", () => {
    expect(routeVoiceResponse("Done.", false)).toEqual({ spoken: "Done." });
    const long = "Detailed result ".repeat(40);
    expect(routeVoiceResponse(long, false)).toEqual({
      spoken: "I put the details in the linked Discord channel.",
      textDetail: long.trim(),
    });
    expect(routeVoiceResponse("I put the repository list in Discord.", true))
      .toEqual({
        spoken: "I put the repository list in Discord.",
        textDetail: undefined,
      });
    expect(routeVoiceResponse("The build failed on test 42.", false, true))
      .toEqual({
        spoken: "I put the details in the linked Discord channel.",
        textDetail: "The build failed on test 42.",
      });
  });
});

describe("Discord voice disconnect policy", () => {
  it("leaves on channel deletion or when the bot is moved/disconnected", () => {
    expect(shouldLeaveForChannelDeletion({
      deletedChannelId: "300",
      voiceChannelId: "300",
      linkedTextChannelId: "200",
    })).toBe(true);
    expect(shouldLeaveForChannelDeletion({
      deletedChannelId: "999",
      voiceChannelId: "300",
      linkedTextChannelId: "200",
    })).toBe(false);
    expect(shouldLeaveForBotVoiceState({
      botUserId: "500",
      updatedUserId: "500",
      activeVoiceChannelId: "300",
      newVoiceChannelId: null,
    })).toBe(true);
    expect(shouldLeaveForBotVoiceState({
      botUserId: "500",
      updatedUserId: "101",
      activeVoiceChannelId: "300",
      newVoiceChannelId: null,
    })).toBe(false);
  });

  it("aborts work, stops playback, destroys voice, and clears the speaker", () => {
    const abortController = new AbortController();
    const player = { stop: vi.fn(() => true) };
    const connection = { destroy: vi.fn() };
    const speaker = { clear: vi.fn() };

    cleanupVoiceResources({
      abortController,
      player,
      connection,
      speaker,
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(player.stop).toHaveBeenCalledWith(true);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(speaker.clear).toHaveBeenCalledOnce();
  });
});
