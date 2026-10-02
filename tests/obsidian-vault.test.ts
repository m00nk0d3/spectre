import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendObsidianNote,
  discoverObsidianVault,
  readObsidianNote,
  searchObsidianVault,
} from "../src/main/obsidian-vault";

let vaultPath = "";
let outsidePath = "";
const originalVaultOverride = process.env.SPECTRE_OBSIDIAN_VAULT;

beforeEach(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), "spectre-vault-"));
  outsidePath = await mkdtemp(path.join(os.tmpdir(), "spectre-outside-"));
  await mkdir(path.join(vaultPath, ".obsidian"));
  await mkdir(path.join(vaultPath, "00 Inbox"));
  await mkdir(path.join(vaultPath, "30 Knowledge"));
  process.env.SPECTRE_OBSIDIAN_VAULT = vaultPath;
});

afterEach(async () => {
  if (originalVaultOverride === undefined) {
    delete process.env.SPECTRE_OBSIDIAN_VAULT;
  } else {
    process.env.SPECTRE_OBSIDIAN_VAULT = originalVaultOverride;
  }
  await rm(vaultPath, { recursive: true, force: true });
  await rm(outsidePath, { recursive: true, force: true });
});

describe("Obsidian vault access", () => {
  it("discovers the explicitly configured local vault", async () => {
    await expect(discoverObsidianVault()).resolves.toBe(vaultPath);
  });

  it("searches Markdown notes while excluding hidden vault metadata", async () => {
    await writeFile(
      path.join(vaultPath, "30 Knowledge", "Bonsai.md"),
      "# Bonsai\n\nUse a 65,536-token context window for local inference.",
    );
    await writeFile(
      path.join(vaultPath, ".obsidian", "private.md"),
      "bonsai secret metadata",
    );

    const result = await searchObsidianVault("bonsai context", { vaultPath });

    expect(result.vault).toBe(path.basename(vaultPath));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      path: "30 Knowledge/Bonsai.md",
      title: "Bonsai",
    });
    expect(result.results[0].snippet).toContain("65,536-token");
  });

  it("reads contained notes and rejects traversal and external symlinks", async () => {
    await writeFile(
      path.join(vaultPath, "30 Knowledge", "Contained.md"),
      "Local knowledge",
    );
    await writeFile(path.join(outsidePath, "Outside.md"), "External data");
    await symlink(
      path.join(outsidePath, "Outside.md"),
      path.join(vaultPath, "30 Knowledge", "Linked.md"),
    );

    await expect(
      readObsidianNote("30 Knowledge/Contained.md", vaultPath),
    ).resolves.toEqual({
      path: "30 Knowledge/Contained.md",
      content: "Local knowledge",
    });
    await expect(
      readObsidianNote("../Outside.md", vaultPath),
    ).rejects.toThrow(/escapes|outside/);
    await expect(
      readObsidianNote("30 Knowledge/Linked.md", vaultPath),
    ).rejects.toThrow("outside");
  });

  it("creates and appends notes without replacing existing content", async () => {
    const first = await appendObsidianNote(
      "00 Inbox/Captured.md",
      "First observation.",
      vaultPath,
    );
    const second = await appendObsidianNote(
      "00 Inbox/Captured.md",
      "Second observation.",
      vaultPath,
    );

    expect(first).toMatchObject({
      path: "00 Inbox/Captured.md",
      created: true,
      verification: "First observation.",
    });
    expect(second.created).toBe(false);
    await expect(
      readFile(path.join(vaultPath, "00 Inbox", "Captured.md"), "utf8"),
    ).resolves.toBe("First observation.\n\nSecond observation.\n");
  });

  it("restricts write locations and refuses likely secrets", async () => {
    await expect(
      appendObsidianNote(
        "90 Templates/Unsafe.md",
        "Ordinary content",
        vaultPath,
      ),
    ).rejects.toThrow("Vault writes are limited");
    await expect(
      appendObsidianNote(
        "00 Inbox/Unsafe.md",
        "password = swordfish",
        vaultPath,
      ),
    ).rejects.toThrow("appears to contain a secret");
  });
});
