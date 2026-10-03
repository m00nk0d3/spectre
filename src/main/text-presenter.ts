import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PRESENTATION_CHARACTERS = 250_000;

export interface TextPresentation {
  paneId: string;
  path: string;
}

export interface TextPresenterOptions {
  directory: string;
  runner?: (command: string, args: string[]) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

function defaultRunner(command: string, args: string[]): Promise<string> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  }).then((result) => result.stdout);
}

function parsePaneId(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Herdr returned invalid JSON: ${output}`);
  }
  const paneId = (
    parsed as { result?: { pane?: { pane_id?: unknown } } }
  ).result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Herdr did not return a pane ID: ${output}`);
  }
  return paneId;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function safeTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim().slice(0, 100);
  return title || "Spectre report";
}

export function shouldPresentInEditor(prompt: string): boolean {
  return /\b(?:neovim|nvim)\b|(?:\b(?:open|show|display|put|render)\b[\s\S]{0,100}\b(?:code editor|editor|herdr pane)\b)/i
    .test(prompt);
}

export class TextPresenter {
  private readonly directory: string;
  private readonly runner: (command: string, args: string[]) => Promise<string>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: TextPresenterOptions) {
    this.directory = options.directory;
    this.runner = options.runner ?? defaultRunner;
    this.env = options.env ?? process.env;
  }

  async present(title: string, content: string): Promise<TextPresentation> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new Error("Cannot present empty text");
    }
    if (normalizedContent.length > MAX_PRESENTATION_CHARACTERS) {
      throw new Error("Editor presentation cannot exceed 250,000 characters");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(
      this.directory,
      `spectre-${Date.now()}-${randomUUID()}.md`,
    );
    await writeFile(
      filePath,
      `# ${safeTitle(title)}\n\n${normalizedContent}\n`,
      { mode: 0o600 },
    );

    const splitArgs = [
      "pane",
      "split",
      ...(this.env.HERDR_ENV === "1" && this.env.HERDR_PANE_ID
        ? ["--current"]
        : []),
      "--direction",
      "right",
      "--cwd",
      this.directory,
      "--no-focus",
    ];
    const paneId = parsePaneId(await this.runner("herdr", splitArgs));
    const command = `exec nvim -R -M -- ${shellQuote(filePath)}`;
    try {
      await this.runner("herdr", ["pane", "run", paneId, command]);
    } catch (error) {
      throw new Error(
        `Herdr created pane ${paneId} but could not open Neovim: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { paneId, path: filePath };
  }
}
