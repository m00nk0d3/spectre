import type { ButtonBuilder, ButtonInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  applyDiscordEnvironment,
  DiscordConfirmationManager,
  discordMemoryScopeKey,
  discordToolNamesForCaller,
  loadDiscordConfig,
  routeDiscordMessage,
  shouldDeliverDiscordNotification,
  shouldUseDiscordThread,
  splitDiscordMessage,
  type DiscordConfig,
} from "../src/main/discord-transport";

function config(): DiscordConfig {
  return {
    enabled: true,
    token: "test-token",
    ownerUserId: "100",
    allowedChannelIds: new Set(["200"]),
    allowedVoiceChannelIds: new Set(),
    voiceTextChannelMap: new Map(),
    commandGuildIds: new Set(),
    confirmationTtlMs: 1_000,
    digestIntervalMs: 60_000,
    enabledNotifications: new Set([
      "review_requested",
      "ci_failed",
      "issue_assigned",
      "github_mention",
      "workflow_completed",
    ]),
    requestTimeoutMs: 90_000,
    rateLimitPerMinute: 8,
    maxInputCharacters: 1_800,
    voiceSessionTimeoutMs: 300_000,
  };
}

function interaction(
  customId: string,
  userId: string,
  replies: string[],
  updates: string[],
  messageId = "confirmation-message",
  channelId = "confirmation-channel",
): ButtonInteraction {
  return {
    customId,
    user: { id: userId },
    message: { id: messageId },
    channelId,
    reply: vi.fn(async (value: { content: string }) => {
      replies.push(value.content);
    }),
    update: vi.fn(async (value: { content: string }) => {
      updates.push(value.content);
    }),
  } as unknown as ButtonInteraction;
}

function confirmationRequest(revalidate: () => Promise<boolean> = async () => true) {
  return {
    origin: {
      ownerUserId: "100",
      callerUserId: "100",
      guildId: "300",
      channelId: "200",
      sessionId: "discord:guild:300:channel:200:user:100",
      requestMessageId: "request-message",
      requestContentHash: "request-hash",
    },
    plan: {
      toolName: "system_write",
      operation: "delete_path",
      title: "Delete a path",
      detail: "Path: /home/user/example",
      payload: { path: "/home/user/example" },
    },
    revalidate,
  };
}

function buttonCustomId(button: ButtonBuilder): string {
  const value = button.toJSON();
  if (!("custom_id" in value) || typeof value.custom_id !== "string") {
    throw new Error("Expected a custom button ID");
  }
  return value.custom_id;
}

describe("Discord configuration", () => {
  it("loads discord.env values without overriding the process environment", () => {
    const env: NodeJS.ProcessEnv = {
      SPECTRE_DISCORD_TOKEN: "process-token",
    };
    applyDiscordEnvironment([
      "SPECTRE_DISCORD_ENABLED=true",
      'SPECTRE_DISCORD_TOKEN="file-token"',
      "SPECTRE_DISCORD_OWNER_USER_ID=100",
    ].join("\n"), env);

    expect(env.SPECTRE_DISCORD_ENABLED).toBe("true");
    expect(env.SPECTRE_DISCORD_TOKEN).toBe("process-token");
    expect(env.SPECTRE_DISCORD_OWNER_USER_ID).toBe("100");
  });
  it("is disabled unless explicitly enabled", () => {
    expect(loadDiscordConfig({})).toEqual({ enabled: false });
  });

  it("fails closed when enabled without a channel allowlist", () => {
    expect(() => loadDiscordConfig({
      SPECTRE_DISCORD_ENABLED: "true",
      SPECTRE_DISCORD_TOKEN: "token",
      SPECTRE_DISCORD_OWNER_USER_ID: "100",
    })).toThrow("SPECTRE_DISCORD_ALLOWED_CHANNEL_IDS");
  });

  it("loads strict IDs and notification configuration", () => {
    const result = loadDiscordConfig({
      SPECTRE_DISCORD_ENABLED: "true",
      SPECTRE_DISCORD_TOKEN: "token",
      SPECTRE_DISCORD_OWNER_USER_ID: "100",
      SPECTRE_DISCORD_ALLOWED_CHANNEL_IDS: "200, 201",
      SPECTRE_DISCORD_NOTIFICATION_TYPES: "ci_failed,github_mention",
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error("Expected enabled Discord config");
    expect([...result.config.allowedChannelIds]).toEqual(["200", "201"]);
    expect([...result.config.enabledNotifications]).toEqual([
      "ci_failed",
      "github_mention",
    ]);
  });
});

describe("Discord routing and authorization", () => {
  it("accepts DMs while preserving owner authorization", () => {
    expect(routeDiscordMessage(config(), {
      authorId: "100",
      isBot: false,
      isDirectMessage: true,
      channelId: "dm-owner",
      mentionedBot: false,
    })).toEqual({ accepted: true, owner: true });
    expect(routeDiscordMessage(config(), {
      authorId: "101",
      isBot: false,
      isDirectMessage: true,
      channelId: "dm-other",
      mentionedBot: false,
    })).toEqual({ accepted: true, owner: false });
  });

  it("requires both an explicit mention and an allowlisted guild channel", () => {
    expect(routeDiscordMessage(config(), {
      authorId: "101",
      isBot: false,
      isDirectMessage: false,
      channelId: "200",
      mentionedBot: true,
    })).toEqual({ accepted: true, owner: false });
    expect(routeDiscordMessage(config(), {
      authorId: "101",
      isBot: false,
      isDirectMessage: false,
      channelId: "200",
      mentionedBot: false,
    })).toEqual({ accepted: false });
    expect(routeDiscordMessage(config(), {
      authorId: "100",
      isBot: false,
      isDirectMessage: false,
      channelId: "999",
      mentionedBot: true,
    })).toEqual({ accepted: false });
  });

  it("enforces tool capability in code for owner versus other users", () => {
    expect(discordToolNamesForCaller(false)).toEqual([]);
    expect(discordToolNamesForCaller(true)).toEqual(
      expect.arrayContaining(["github_read", "github_write", "system_read"]),
    );
  });
});

describe("Discord memory and delivery", () => {
  it("isolates memory by user and channel or DM", () => {
    expect(discordMemoryScopeKey({
      userId: "100",
      channelId: "200",
      guildId: "300",
    })).toBe("discord:guild:300:channel:200:user:100");
    expect(discordMemoryScopeKey({
      userId: "101",
      channelId: "200",
      guildId: "300",
    })).not.toBe(discordMemoryScopeKey({
      userId: "100",
      channelId: "200",
      guildId: "300",
    }));
    expect(discordMemoryScopeKey({
      userId: "100",
      channelId: "dm-1",
    })).toBe("discord:dm:dm-1:user:100");
  });

  it("splits safely and chooses threads only for long guild work", () => {
    const chunks = splitDiscordMessage(`${"a".repeat(1_850)} ${"b".repeat(200)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 1_900)).toBe(true);
    expect(shouldUseDiscordThread({
      isDirectMessage: false,
      contentLength: 2_100,
      progressUpdateCount: 0,
      messageCount: 2,
    })).toBe(true);
    expect(shouldUseDiscordThread({
      isDirectMessage: true,
      contentLength: 2_100,
      progressUpdateCount: 2,
      messageCount: 2,
    })).toBe(false);
  });
});

describe("Discord confirmations", () => {
  it("binds to owner, supports cancel, and rejects replay", async () => {
    const manager = new DiscordConfirmationManager("100", 5_000);
    let confirmId = "";
    let cancelId = "";
    const pending = manager.request(confirmationRequest(), async (_content, rows) => {
      confirmId = buttonCustomId(rows[0].components[0]);
      cancelId = buttonCustomId(rows[0].components[1]);
      return {
        messageId: "confirmation-message",
        channelId: "confirmation-channel",
      };
    });
    const replies: string[] = [];
    const updates: string[] = [];
    await Promise.resolve();
    expect(confirmId).toMatch(/^spectre:confirm:[A-Za-z0-9_-]+$/);
    expect(confirmId).not.toContain("example");

    await manager.handle(interaction(confirmId, "101", replies, updates));
    expect(replies[0]).toContain("Only Spectre's configured owner");

    await manager.handle(interaction(cancelId, "100", replies, updates));
    await expect(pending).resolves.toBe(false);
    expect(updates).toEqual(["Action cancelled."]);

    await manager.handle(interaction(cancelId, "100", replies, updates));
    expect(replies.at(-1)).toContain("expired or was already used");
  });

  it("expires a nonce before accepting it", async () => {
    let now = 1_000;
    const manager = new DiscordConfirmationManager(
      "100",
      1_000,
      () => new Date(now),
    );
    let confirmId = "";
    const pending = manager.request(confirmationRequest(), async (_content, rows) => {
      confirmId = buttonCustomId(rows[0].components[0]);
      return {
        messageId: "confirmation-message",
        channelId: "confirmation-channel",
      };
    });
    now = 2_001;
    const updates: string[] = [];
    await Promise.resolve();
    await manager.handle(interaction(confirmId, "100", [], updates));
    await expect(pending).resolves.toBe(false);
    expect(updates).toEqual([
      "Action rejected because its security context changed or expired.",
    ]);
  });

  it("rejects cross-channel use and click-time policy changes", async () => {
    const manager = new DiscordConfirmationManager("100", 5_000);
    let confirmId = "";
    const revalidate = vi.fn(async () => false);
    const pending = manager.request(
      confirmationRequest(revalidate),
      async (_content, rows) => {
        confirmId = buttonCustomId(rows[0].components[0]);
        return {
          messageId: "confirmation-message",
          channelId: "confirmation-channel",
        };
      },
    );
    const replies: string[] = [];
    const updates: string[] = [];
    await Promise.resolve();

    await manager.handle(interaction(
      confirmId,
      "100",
      replies,
      updates,
      "confirmation-message",
      "other-channel",
    ));
    expect(replies.at(-1)).toContain("not valid in this context");
    expect(revalidate).not.toHaveBeenCalled();

    await manager.handle(interaction(confirmId, "100", replies, updates));
    await expect(pending).resolves.toBe(false);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toContain("security context changed");
  });

  it("rejects model-forged or restart-stale confirmation nonces", async () => {
    const manager = new DiscordConfirmationManager("100", 5_000);
    const replies: string[] = [];
    await manager.handle(interaction(
      "spectre:confirm:model-invented-nonce",
      "100",
      replies,
      [],
    ));
    expect(replies).toEqual([
      "This confirmation is expired or was already used.",
    ]);
  });
});

describe("Discord notifications", () => {
  it("filters configured events and keeps actionable routing enabled", () => {
    const value = config();
    value.enabledNotifications = new Set(["ci_failed", "workflow_completed"]);
    expect(shouldDeliverDiscordNotification(value, {
      kind: "ci_failed",
      title: "CI failed",
      body: "spectre/main",
    })).toBe(true);
    expect(shouldDeliverDiscordNotification(value, {
      kind: "github_mention",
      title: "Mention",
      body: "Issue #1",
    })).toBe(false);
  });
});
