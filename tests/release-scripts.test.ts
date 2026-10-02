import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const VERSION = "1.0.0";
let temporaryRoot = "";
let releaseDirectory = "";
let assetsDirectory = "";

function run(
  script: string,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync("bash", [script, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "spectre-release-"));
  releaseDirectory = path.join(temporaryRoot, "release");
  assetsDirectory = path.join(releaseDirectory, "assets");
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(
    path.join(releaseDirectory, `spectre-${VERSION}.AppImage`),
    "fake appimage",
  );
  await writeFile(
    path.join(releaseDirectory, `spectre_${VERSION}_amd64.deb`),
    "fake deb",
  );
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("release scripts", () => {
  it("leaves GitHub publishing to the release workflow", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["build:electron"]).toContain("--publish never");
  });

  it("stages the complete checksummed release asset set", async () => {
    const result = run(
      path.join(PROJECT_ROOT, "scripts", "prepare-release-assets.sh"),
      [VERSION],
      {
        SPECTRE_RELEASE_DIR: releaseDirectory,
        SPECTRE_ASSETS_DIR: assetsDirectory,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const expectedAssets = [
      "SHA256SUMS",
      "install-spectre.sh",
      `spectre-${VERSION}-amd64.deb`,
      `spectre-${VERSION}-x86_64.AppImage`,
      `spectre-python-requirements-${VERSION}.txt`,
      "uninstall-spectre.sh",
    ];
    const checksums = await readFile(
      path.join(assetsDirectory, "SHA256SUMS"),
      "utf8",
    );
    for (const asset of expectedAssets.slice(1)) {
      await expect(stat(path.join(assetsDirectory, asset))).resolves.toBeDefined();
      expect(checksums).toContain(`  ${asset}`);
    }

    const checksumResult = spawnSync(
      "sha256sum",
      ["--check", "SHA256SUMS"],
      { cwd: assetsDirectory, encoding: "utf8" },
    );
    expect(checksumResult.status, checksumResult.stderr).toBe(0);
  });

  it("installs and uninstalls a checksummed AppImage without sudo", async () => {
    const stageResult = run(
      path.join(PROJECT_ROOT, "scripts", "prepare-release-assets.sh"),
      [VERSION],
      {
        SPECTRE_RELEASE_DIR: releaseDirectory,
        SPECTRE_ASSETS_DIR: assetsDirectory,
      },
    );
    expect(stageResult.status, stageResult.stderr).toBe(0);

    const home = path.join(temporaryRoot, "home");
    const dataHome = path.join(home, "data");
    const binHome = path.join(home, "bin");
    await mkdir(home, { recursive: true });
    const environment = {
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_BIN_HOME: binHome,
      SPECTRE_RELEASE_BASE_URL: `file://${assetsDirectory}`,
    };
    const installResult = run(
      path.join(PROJECT_ROOT, "scripts", "install.sh"),
      ["--version", VERSION, "--no-runtime"],
      environment,
    );

    expect(installResult.status, installResult.stderr).toBe(0);
    await expect(
      readFile(
        path.join(dataHome, "spectre", "app", `spectre-${VERSION}.AppImage`),
        "utf8",
      ),
    ).resolves.toBe("fake appimage");
    expect(
      await stat(path.join(binHome, "spectre")),
    ).toBeDefined();
    expect(
      await stat(path.join(binHome, "spectre-uninstall")),
    ).toBeDefined();
    expect(
      await readFile(
        path.join(dataHome, "applications", "spectre.desktop"),
        "utf8",
      ),
    ).toContain("StartupWMClass=spectre");

    const installedUninstaller = path.join(binHome, "spectre-uninstall");
    await chmod(installedUninstaller, 0o755);
    const uninstallResult = run(installedUninstaller, [], environment);
    expect(uninstallResult.status, uninstallResult.stderr).toBe(0);
    await expect(stat(path.join(binHome, "spectre"))).rejects.toThrow();
    await expect(
      stat(path.join(dataHome, "applications", "spectre.desktop")),
    ).rejects.toThrow();
  });

  it("provisions the managed runtime through uv", async () => {
    const stageResult = run(
      path.join(PROJECT_ROOT, "scripts", "prepare-release-assets.sh"),
      [VERSION],
      {
        SPECTRE_RELEASE_DIR: releaseDirectory,
        SPECTRE_ASSETS_DIR: assetsDirectory,
      },
    );
    expect(stageResult.status, stageResult.stderr).toBe(0);

    const home = path.join(temporaryRoot, "runtime-home");
    const dataHome = path.join(home, "data");
    const binHome = path.join(home, "bin");
    const mockBin = path.join(temporaryRoot, "mock-bin");
    const uvLog = path.join(temporaryRoot, "uv.log");
    await mkdir(mockBin, { recursive: true });
    const uvScript = path.join(mockBin, "uv");
    await writeFile(
      uvScript,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(uvLog)}
if [[ "$1" == "venv" ]]; then
  runtime="\${@: -1}"
  mkdir -p "$runtime/bin"
  cat > "$runtime/bin/python" <<'PYTHON'
#!/usr/bin/env bash
cat >/dev/null
exit 0
PYTHON
  chmod +x "$runtime/bin/python"
fi
`,
    );
    await chmod(uvScript, 0o755);

    const installResult = run(
      path.join(PROJECT_ROOT, "scripts", "install.sh"),
      ["--version", VERSION],
      {
        HOME: home,
        XDG_DATA_HOME: dataHome,
        XDG_BIN_HOME: binHome,
        SPECTRE_RELEASE_BASE_URL: `file://${assetsDirectory}`,
        PATH: `${mockBin}:${process.env.PATH}`,
      },
    );

    expect(installResult.status, installResult.stderr).toBe(0);
    const calls = await readFile(uvLog, "utf8");
    expect(calls).toContain(
      `venv --python 3.12 ${path.join(dataHome, "spectre", "python")}`,
    );
    expect(calls).toContain("pip install --python");
    expect(calls).toContain(
      `spectre-python-requirements-${VERSION}.txt`,
    );
  });

  it("rejects malformed options without making changes", () => {
    const result = run(
      path.join(PROJECT_ROOT, "scripts", "install.sh"),
      ["--unknown"],
      { HOME: temporaryRoot },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option");
  });
});
