import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_NOTE_BYTES = 512 * 1024;
const MAX_VAULT_FILES = 5_000;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 8;
const MAX_SNIPPET_LENGTH = 1_200;
const DEFAULT_CAPTURE_PATH = "00 Inbox/Spectre Captures.md";
const WRITABLE_ROOTS = new Set([
  "00 Inbox",
  "10 Projects",
  "20 Decisions",
  "30 Knowledge",
  "40 Sessions",
]);
const QUERY_STOP_WORDS = new Set([
  "a",
  "about",
  "and",
  "brain",
  "do",
  "does",
  "find",
  "for",
  "from",
  "in",
  "me",
  "my",
  "note",
  "notes",
  "obsidian",
  "of",
  "please",
  "say",
  "search",
  "second",
  "tell",
  "the",
  "to",
  "vault",
  "what",
]);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|secret)\s*[:=]\s*\S+/i,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

interface ObsidianConfig {
  vaults?: Record<string, {
    path?: string;
    open?: boolean;
    ts?: number;
  }>;
}

export interface VaultSearchOptions {
  vaultPath?: string;
  limit?: number;
}

export interface VaultSearchResult {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

async function isVault(candidate: string): Promise<boolean> {
  try {
    const marker = await stat(path.join(candidate, ".obsidian"));
    return marker.isDirectory();
  } catch {
    return false;
  }
}

export async function discoverObsidianVault(): Promise<string> {
  const configured = process.env.SPECTRE_OBSIDIAN_VAULT;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!(await isVault(resolved))) {
      throw new Error(
        `SPECTRE_OBSIDIAN_VAULT is not an Obsidian vault: ${resolved}`,
      );
    }
    return realpath(resolved);
  }

  const configPath = path.join(
    os.homedir(),
    ".config",
    "obsidian",
    "obsidian.json",
  );
  let config: ObsidianConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as ObsidianConfig;
  } catch (error) {
    throw new Error(
      `Could not read Obsidian configuration at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const candidates = Object.values(config.vaults ?? {})
    .filter((vault): vault is Required<Pick<
      NonNullable<ObsidianConfig["vaults"]>[string],
      "path"
    >> & { open?: boolean; ts?: number } => typeof vault.path === "string")
    .sort((left, right) => {
      if (Boolean(left.open) !== Boolean(right.open)) {
        return left.open ? -1 : 1;
      }
      return (right.ts ?? 0) - (left.ts ?? 0);
    });

  for (const candidate of candidates) {
    if (await isVault(candidate.path)) return realpath(candidate.path);
  }
  throw new Error("No usable Obsidian vault was found");
}

function assertRelativeMarkdownPath(relativePath: string): string {
  if (!relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error("Vault note path must be relative");
  }
  const normalized = path.normalize(relativePath.trim());
  const segments = normalized.split(path.sep);
  if (
    normalized === ".."
    || normalized.startsWith(`..${path.sep}`)
    || segments.some((segment) => segment.startsWith("."))
  ) {
    throw new Error("Vault note path escapes or enters a hidden directory");
  }
  if (path.extname(normalized).toLowerCase() !== ".md") {
    throw new Error("Vault note path must end in .md");
  }
  return normalized;
}

function assertContained(vaultPath: string, targetPath: string): void {
  const relative = path.relative(vaultPath, targetPath);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Vault note path is outside the configured vault");
  }
}

async function resolveExistingNote(
  vaultPath: string,
  relativePath: string,
): Promise<{ vaultPath: string; notePath: string; relativePath: string }> {
  const vault = await realpath(vaultPath);
  const relative = assertRelativeMarkdownPath(relativePath);
  const note = await realpath(path.resolve(vault, relative));
  assertContained(vault, note);
  const noteStat = await stat(note);
  if (!noteStat.isFile()) throw new Error("Vault note is not a file");
  if (noteStat.size > MAX_NOTE_BYTES) {
    throw new Error(`Vault note exceeds ${MAX_NOTE_BYTES} bytes`);
  }
  return { vaultPath: vault, notePath: note, relativePath: relative };
}

async function collectMarkdownFiles(
  directory: string,
  vaultPath: string,
  files: string[],
): Promise<void> {
  if (files.length >= MAX_VAULT_FILES) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_VAULT_FILES) return;
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(entryPath, vaultPath, files);
    } else if (
      entry.isFile()
      && path.extname(entry.name).toLowerCase() === ".md"
    ) {
      files.push(path.relative(vaultPath, entryPath));
    }
  }
}

function queryTokens(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token))
      ?? [],
  )].slice(0, 12);
}

function createSnippet(content: string, tokens: string[]): string {
  const lower = content.toLowerCase();
  const indexes = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0);
  const matchIndex = indexes.length > 0 ? Math.min(...indexes) : 0;
  const start = Math.max(0, matchIndex - 160);
  const end = Math.min(content.length, start + MAX_SNIPPET_LENGTH);
  return `${start > 0 ? "..." : ""}${content.slice(start, end).trim()}${
    end < content.length ? "..." : ""
  }`;
}

export async function searchObsidianVault(
  query: string,
  options: VaultSearchOptions = {},
): Promise<{
  vault: string;
  query: string;
  results: VaultSearchResult[];
}> {
  const trimmedQuery = query.trim().slice(0, 240);
  const tokens = queryTokens(trimmedQuery);
  if (tokens.length === 0) {
    throw new Error("Vault search needs at least one meaningful search term");
  }
  const vaultPath = options.vaultPath
    ? await realpath(options.vaultPath)
    : await discoverObsidianVault();
  if (!(await isVault(vaultPath))) {
    throw new Error(`Not an Obsidian vault: ${vaultPath}`);
  }
  const files: string[] = [];
  await collectMarkdownFiles(vaultPath, vaultPath, files);
  const results: VaultSearchResult[] = [];

  for (const relativePath of files) {
    const notePath = path.join(vaultPath, relativePath);
    const noteStat = await stat(notePath);
    if (noteStat.size > MAX_NOTE_BYTES) continue;
    const content = await readFile(notePath, "utf8");
    const searchablePath = relativePath.toLowerCase();
    const searchableContent = content.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (searchablePath.includes(token)) score += 4;
      if (searchableContent.includes(token)) score += 1;
    }
    if (score === 0) continue;
    results.push({
      path: relativePath,
      title: path.basename(relativePath, ".md"),
      score,
      snippet: createSnippet(content, tokens),
    });
  }

  const limit = Math.min(
    MAX_RESULT_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_RESULT_LIMIT)),
  );
  results.sort((left, right) =>
    right.score - left.score || left.path.localeCompare(right.path)
  );
  return {
    vault: path.basename(vaultPath),
    query: trimmedQuery,
    results: results.slice(0, limit),
  };
}

export async function readObsidianNote(
  relativePath: string,
  vaultPath?: string,
): Promise<{ path: string; content: string }> {
  const selectedVault = vaultPath ?? await discoverObsidianVault();
  const resolved = await resolveExistingNote(selectedVault, relativePath);
  return {
    path: resolved.relativePath,
    content: await readFile(resolved.notePath, "utf8"),
  };
}

function assertSafeContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Vault note content cannot be empty");
  if (trimmed.length > 20_000) {
    throw new Error("Vault note content exceeds 20,000 characters");
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    throw new Error("Refusing to store content that appears to contain a secret");
  }
  return trimmed;
}

export function validateObsidianAppend(
  relativePath: string | undefined,
  content: string,
): { path: string; content: string } {
  const relative = assertRelativeMarkdownPath(
    relativePath?.trim() || DEFAULT_CAPTURE_PATH,
  );
  if (!WRITABLE_ROOTS.has(relative.split(path.sep)[0])) {
    throw new Error(
      `Vault writes are limited to: ${[...WRITABLE_ROOTS].join(", ")}`,
    );
  }
  return {
    path: relative,
    content: assertSafeContent(content),
  };
}

export async function appendObsidianNote(
  relativePath: string | undefined,
  content: string,
  vaultPath?: string,
): Promise<{
  path: string;
  created: boolean;
  appendedCharacters: number;
  verification: string;
}> {
  const vault = await realpath(vaultPath ?? await discoverObsidianVault());
  const validated = validateObsidianAppend(relativePath, content);
  const relative = validated.path;
  const safeContent = validated.content;
  const target = path.resolve(vault, relative);
  assertContained(vault, target);

  let created = false;
  let existingContent = "";
  try {
    const existing = await realpath(target);
    assertContained(vault, existing);
    const existingStat = await stat(existing);
    if (!existingStat.isFile()) throw new Error("Vault note is not a file");
    if (existingStat.size > MAX_NOTE_BYTES) {
      throw new Error(`Vault note exceeds ${MAX_NOTE_BYTES} bytes`);
    }
    existingContent = await readFile(existing, "utf8");
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") throw error;
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    assertContained(vault, realParent);
    created = true;
  }

  const separator = created || existingContent.endsWith("\n\n")
    ? ""
    : existingContent.endsWith("\n") ? "\n" : "\n\n";
  const addition = `${separator}${safeContent}\n`;
  await appendFile(target, addition, { encoding: "utf8", flag: "a" });
  const verified = await readObsidianNote(relative, vault);
  if (!verified.content.endsWith(`${safeContent}\n`)) {
    throw new Error("Vault write verification failed");
  }
  return {
    path: relative,
    created,
    appendedCharacters: safeContent.length,
    verification: safeContent,
  };
}
