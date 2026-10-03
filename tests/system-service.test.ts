import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SystemService,
  type SystemWritePlan,
} from "../src/main/system-service";

const temporaryDirectories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spectre-system-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("SystemService", () => {
  it("lists readable directories while hiding sensitive entries", async () => {
    const home = await temporaryHome();
    await mkdir(path.join(home, "dev"));
    await mkdir(path.join(home, ".ssh"));
    await writeFile(path.join(home, "notes.txt"), "hello");
    await writeFile(path.join(home, ".env"), "SECRET=value");
    const service = new SystemService({ homeDirectory: home });

    await expect(service.read("list_directory", {
      path: "~",
      includeHidden: true,
    })).resolves.toEqual([
      {
        name: "dev",
        path: path.join(home, "dev"),
        type: "directory",
      },
      {
        name: "notes.txt",
        path: path.join(home, "notes.txt"),
        type: "file",
      },
    ]);
  });

  it("reads bounded text outside home but blocks sensitive paths", async () => {
    const home = await temporaryHome();
    const readableRoot = await temporaryHome();
    const readableFile = path.join(readableRoot, "public.txt");
    await writeFile(readableFile, "public information");
    await mkdir(path.join(home, ".ssh"));
    await writeFile(path.join(home, ".ssh", "id_ed25519"), "private");
    const service = new SystemService({ homeDirectory: home });

    await expect(service.read("read_text_file", {
      path: readableFile,
    })).resolves.toEqual({
      path: readableFile,
      content: "public information",
    });
    await expect(service.read("read_text_file", {
      path: "~/.ssh/id_ed25519",
    })).rejects.toThrow("sensitive path is blocked");
  });

  it("finds filenames without traversing sensitive directories", async () => {
    const home = await temporaryHome();
    await mkdir(path.join(home, "dev", "spectre"), { recursive: true });
    await mkdir(path.join(home, ".config", "gh"), { recursive: true });
    await writeFile(path.join(home, "dev", "spectre", "README.md"), "readme");
    await writeFile(path.join(home, ".config", "gh", "hosts.yml"), "token");
    const service = new SystemService({ homeDirectory: home });

    await expect(service.read("find_files", {
      path: "~",
      query: "readme",
    })).resolves.toEqual([{
      name: "README.md",
      path: path.join(home, "dev", "spectre", "README.md"),
      type: "file",
    }]);
  });

  it("confirms every home-directory mutation before writing", async () => {
    const home = await temporaryHome();
    const plans: SystemWritePlan[] = [];
    const service = new SystemService({
      homeDirectory: home,
      confirm: async (plan) => {
        plans.push(plan);
        return true;
      },
    });
    const target = path.join(home, "notes.txt");

    await expect(service.write("write_text_file", {
      path: target,
      content: "remember this",
    })).resolves.toMatchObject({
      success: true,
      operation: "write_text_file",
      path: target,
    });
    expect(plans).toHaveLength(1);
    await expect(readFile(target, "utf8")).resolves.toBe("remember this");
  });

  it("rejects writes outside home and cancelled mutations", async () => {
    const home = await temporaryHome();
    const outside = await temporaryHome();
    const confirm = vi.fn(async () => false);
    const service = new SystemService({
      homeDirectory: home,
      confirm,
    });

    await expect(service.write("create_directory", {
      path: path.join(outside, "blocked"),
    })).rejects.toThrow("restricted to non-sensitive paths");
    await expect(service.write("create_directory", {
      path: path.join(home, "cancelled"),
    })).resolves.toEqual({
      cancelled: true,
      operation: "create_directory",
    });
    expect(confirm).toHaveBeenCalledOnce();
  });
});
