import { createHash } from "node:crypto";
import type { SpectreMutationPlan } from "./spectre-tools";

const ENVELOPE_VERSION = 1;
const MAX_ENVELOPE_CHARACTERS = 64_000;

export interface DiscordRequestOrigin {
  ownerUserId: string;
  callerUserId: string;
  guildId: string | null;
  channelId: string;
  sessionId: string;
  requestMessageId: string | null;
  requestContentHash: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

export function securityHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createUntrustedDataEnvelope(
  source: string,
  content: string,
): string {
  if (!/^[a-z0-9_.:-]{1,80}$/i.test(source)) {
    throw new Error("Untrusted data source label is invalid");
  }
  const bounded = content.length <= MAX_ENVELOPE_CHARACTERS
    ? content
    : `${content.slice(0, MAX_ENVELOPE_CHARACTERS - 1)}…`;
  return [
    "-----BEGIN SPECTRE UNTRUSTED DATA-----",
    JSON.stringify({
      version: ENVELOPE_VERSION,
      source,
      instructionAuthority: "none",
      content: bounded,
    }),
    "-----END SPECTRE UNTRUSTED DATA-----",
  ].join("\n");
}

export function formatDiscordMutationSummary(
  plan: SpectreMutationPlan,
): string {
  const lines = [
    plan.title,
    `Tool: ${plan.toolName}`,
    `Operation: ${plan.operation}`,
  ];
  if (plan.repository) lines.push(`Repository: ${plan.repository}`);
  lines.push("Validated payload:");
  for (const key of Object.keys(plan.payload).sort()) {
    lines.push(`${key}: ${canonicalJson(plan.payload[key])}`);
  }
  return lines.join("\n");
}

interface RateLimitEntry {
  windowStartedAt: number;
  count: number;
}

export class DiscordRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Rate limit maximum must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new Error("Rate limit window must be a positive integer");
    }
  }

  allow(key: string): boolean {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || now - current.windowStartedAt >= this.windowMs) {
      this.entries.set(key, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.maximum) return false;
    current.count += 1;
    return true;
  }
}
