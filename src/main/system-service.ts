import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DEPTH = 8;

export type SystemReadOperation =
  | "list_directory"
  | "stat_path"
  | "read_text_file"
  | "find_files";

export type SystemWriteOperation =
  | "create_directory"
  | "write_text_file"
  | "copy_path"
  | "move_path"
  | "delete_path";

export interface SystemWritePlan {
  operation: SystemWriteOperation;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

export interface SystemServiceOptions {
  homeDirectory?: string;
  confirm?: (plan: SystemWritePlan) => Promise<boolean>;
}

const BLOCKED_ABSOLUTE_PREFIXES = [
  "/dev",
  "/proc",
  "/root",
  "/run",
  "/sys",
];

const BLOCKED_HOME_PREFIXES = [
  ".aws",
  ".azure",
  ".config/BraveSoftware",
  ".config/Signal",
  ".config/chromium",
  ".config/discord",
  ".config/gh",
  ".config/google-chrome",
  ".config/keyring",
  ".config/op",
  ".config/slack",
  ".gnupg",
  ".local/share/keyrings",
  ".mozilla",
  ".pki",
  ".ssh",
  ".thunderbird",
];

const BLOCKED_FILE_NAMES = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "shadow",
  "gshadow",
]);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("System payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringValue(
  payload: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const value = payload[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function booleanValue(
  payload: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function integerValue(
  payload: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = payload[key] ?? fallback;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw new Error(`${key} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function assertAllowedKeys(
  payload: Record<string, unknown>,
  allowed: string[],
): void {
  const unexpected = Object.keys(payload).find(
    (key) => !allowed.includes(key),
  );
  if (unexpected) throw new Error(`Unsupported payload field: ${unexpected}`);
}

export class SystemService {
  private readonly homeDirectory: string;
  private confirm: ((plan: SystemWritePlan) => Promise<boolean>) | null;

  constructor(options: SystemServiceOptions = {}) {
    this.homeDirectory = path.resolve(
      options.homeDirectory ?? os.homedir(),
    );
    this.confirm = options.confirm ?? null;
  }

  setConfirmationHandler(
    confirm: ((plan: SystemWritePlan) => Promise<boolean>) | null,
  ): void {
    this.confirm = confirm;
  }

  async read(
    operation: SystemReadOperation,
    payloadValue: unknown,
  ): Promise<unknown> {
    const payload = objectPayload(payloadValue);
    switch (operation) {
      case "list_directory": {
        assertAllowedKeys(payload, ["path", "includeHidden"]);
        const requestedPath = stringValue(payload, "path")!;
        const includeHidden = booleanValue(payload, "includeHidden") ?? false;
        const directory = await this.resolveReadablePath(requestedPath);
        const directoryStat = await stat(directory);
        if (!directoryStat.isDirectory()) {
          throw new Error("path must reference a directory");
        }
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
          .filter((entry) => includeHidden || !entry.name.startsWith("."))
          .filter((entry) =>
            !this.isSensitivePath(path.join(directory, entry.name)))
          .sort((left, right) => {
            if (left.isDirectory() !== right.isDirectory()) {
              return left.isDirectory() ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
          })
          .slice(0, MAX_DIRECTORY_ENTRIES)
          .map((entry) => ({
            name: entry.name,
            path: path.join(directory, entry.name),
            type: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : entry.isSymbolicLink()
                  ? "symlink"
                  : "other",
          }));
      }
      case "stat_path": {
        assertAllowedKeys(payload, ["path"]);
        const resolvedPath = await this.resolveReadablePath(
          stringValue(payload, "path")!,
        );
        const info = await lstat(resolvedPath);
        return {
          path: resolvedPath,
          type: info.isDirectory()
            ? "directory"
            : info.isFile()
              ? "file"
              : info.isSymbolicLink()
                ? "symlink"
                : "other",
          size: info.size,
          mode: (info.mode & 0o777).toString(8).padStart(3, "0"),
          modifiedAt: info.mtime.toISOString(),
          createdAt: info.birthtime.toISOString(),
        };
      }
      case "read_text_file": {
        assertAllowedKeys(payload, ["path"]);
        const resolvedPath = await this.resolveReadablePath(
          stringValue(payload, "path")!,
        );
        const info = await stat(resolvedPath);
        if (!info.isFile()) throw new Error("path must reference a file");
        if (info.size > MAX_READ_BYTES) {
          throw new Error(
            `Text file exceeds the ${MAX_READ_BYTES}-byte read limit`,
          );
        }
        const content = await readFile(resolvedPath);
        if (content.includes(0)) throw new Error("Binary files are not readable");
        return {
          path: resolvedPath,
          content: content.toString("utf8"),
        };
      }
      case "find_files": {
        assertAllowedKeys(payload, ["path", "query", "maxDepth", "limit"]);
        const root = await this.resolveReadablePath(
          stringValue(payload, "path")!,
        );
        const query = stringValue(payload, "query")!.toLowerCase();
        const maxDepth = integerValue(
          payload,
          "maxDepth",
          5,
          MAX_SEARCH_DEPTH,
        );
        const limit = integerValue(
          payload,
          "limit",
          50,
          MAX_SEARCH_RESULTS,
        );
        const results: Array<{
          name: string;
          path: string;
          type: "file" | "directory";
        }> = [];
        const pending = [{ directory: root, depth: 0 }];
        while (pending.length > 0 && results.length < limit) {
          const current = pending.shift()!;
          const entries = await readdir(current.directory, {
            withFileTypes: true,
          }).catch(() => []);
          for (const entry of entries) {
            const candidate = path.join(current.directory, entry.name);
            if (this.isSensitivePath(candidate) || entry.isSymbolicLink()) {
              continue;
            }
            const type = entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : null;
            if (!type) continue;
            if (entry.name.toLowerCase().includes(query)) {
              results.push({ name: entry.name, path: candidate, type });
              if (results.length >= limit) break;
            }
            if (entry.isDirectory() && current.depth < maxDepth) {
              pending.push({
                directory: candidate,
                depth: current.depth + 1,
              });
            }
          }
        }
        return results;
      }
      default:
        throw new Error(`Unsupported system read operation: ${operation}`);
    }
  }

  async write(
    operation: SystemWriteOperation,
    payloadValue: unknown,
    confirmOverride?: (plan: SystemWritePlan) => Promise<boolean>,
  ): Promise<unknown> {
    const payload = objectPayload(payloadValue);
    const validated = await this.validateWrite(operation, payload);
    const confirm = confirmOverride ?? this.confirm;
    if (!confirm) {
      throw new Error("System write confirmation is not available");
    }
    const plan: SystemWritePlan = {
      operation,
      title: this.operationTitle(operation),
      detail: Object.entries(validated)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join("\n"),
      payload: validated,
    };
    if (!await confirm(plan)) {
      return { cancelled: true, operation };
    }
    const revalidated = await this.validateWrite(operation, payload);
    if (JSON.stringify(revalidated) !== JSON.stringify(validated)) {
      throw new Error("System write changed before confirmation");
    }

    switch (operation) {
      case "create_directory":
        await mkdir(validated.path as string, { recursive: true });
        break;
      case "write_text_file":
        await writeFile(
          validated.path as string,
          validated.content as string,
          {
            encoding: "utf8",
            flag: validated.overwrite === true ? "w" : "wx",
          },
        );
        break;
      case "copy_path": {
        const sourceInfo = await stat(validated.source as string);
        if (sourceInfo.isDirectory()) {
          await cp(
            validated.source as string,
            validated.destination as string,
            { recursive: true, errorOnExist: true, force: false },
          );
        } else {
          await copyFile(
            validated.source as string,
            validated.destination as string,
          );
        }
        break;
      }
      case "move_path":
        await rename(
          validated.source as string,
          validated.destination as string,
        );
        break;
      case "delete_path":
        await rm(validated.path as string, {
          recursive: validated.recursive === true,
          force: false,
        });
        break;
      default:
        throw new Error(`Unsupported system write operation: ${operation}`);
    }
    return { success: true, operation, ...validated };
  }

  private expandPath(requestedPath: string): string {
    if (requestedPath === "~") return this.homeDirectory;
    if (requestedPath.startsWith("~/")) {
      return path.resolve(this.homeDirectory, requestedPath.slice(2));
    }
    return path.resolve(requestedPath);
  }

  private isSensitivePath(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    if (
      BLOCKED_ABSOLUTE_PREFIXES.some((blocked) =>
        isWithin(blocked, resolved))
    ) {
      return true;
    }
    if (
      BLOCKED_HOME_PREFIXES.some((blocked) =>
        isWithin(path.join(this.homeDirectory, blocked), resolved))
    ) {
      return true;
    }
    const baseName = path.basename(resolved).toLowerCase();
    return BLOCKED_FILE_NAMES.has(baseName)
      || baseName.startsWith(".env.")
      || baseName.includes("secret")
      || baseName.includes("token");
  }

  private async resolveReadablePath(requestedPath: string): Promise<string> {
    const expanded = this.expandPath(requestedPath);
    if (this.isSensitivePath(expanded)) {
      throw new Error("Access to this sensitive path is blocked");
    }
    const resolved = await realpath(expanded);
    if (this.isSensitivePath(resolved)) {
      throw new Error("Access to this sensitive path is blocked");
    }
    return resolved;
  }

  private async resolveWritablePath(requestedPath: string): Promise<string> {
    const expanded = this.expandPath(requestedPath);
    if (
      !isWithin(this.homeDirectory, expanded)
      || this.isSensitivePath(expanded)
    ) {
      throw new Error(
        "System writes are restricted to non-sensitive paths in the home directory",
      );
    }
    const parent = await realpath(path.dirname(expanded));
    if (
      !isWithin(this.homeDirectory, parent)
      || this.isSensitivePath(parent)
    ) {
      throw new Error("Write path escapes the permitted home directory");
    }
    try {
      const existing = await realpath(expanded);
      if (
        !isWithin(this.homeDirectory, existing)
        || this.isSensitivePath(existing)
      ) {
        throw new Error("Write path escapes the permitted home directory");
      }
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    return expanded;
  }

  private async validateWrite(
    operation: SystemWriteOperation,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (operation) {
      case "create_directory": {
        assertAllowedKeys(payload, ["path"]);
        return {
          path: await this.resolveWritablePath(stringValue(payload, "path")!),
        };
      }
      case "write_text_file": {
        assertAllowedKeys(payload, ["path", "content", "overwrite"]);
        const content = stringValue(payload, "content")!;
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
          throw new Error(
            `content exceeds the ${MAX_WRITE_BYTES}-byte write limit`,
          );
        }
        return {
          path: await this.resolveWritablePath(stringValue(payload, "path")!),
          content,
          overwrite: booleanValue(payload, "overwrite") ?? false,
        };
      }
      case "copy_path":
      case "move_path": {
        assertAllowedKeys(payload, ["source", "destination"]);
        return {
          source: await this.resolveReadablePath(
            stringValue(payload, "source")!,
          ),
          destination: await this.resolveWritablePath(
            stringValue(payload, "destination")!,
          ),
        };
      }
      case "delete_path": {
        assertAllowedKeys(payload, ["path", "recursive"]);
        return {
          path: await this.resolveWritablePath(stringValue(payload, "path")!),
          recursive: booleanValue(payload, "recursive") ?? false,
        };
      }
      default:
        throw new Error(`Unsupported system write operation: ${operation}`);
    }
  }

  private operationTitle(operation: SystemWriteOperation): string {
    return operation
      .split("_")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ");
  }
}

export const systemService = new SystemService();
