// Self-update.
//
// The channel is npm: `eaon-cli` is published there, and `npm i -g eaon-cli` is
// how a standalone install arrives. So the version check reads the registry, not
// GitHub releases — the release feed on api.eaon.dev carries `mac-v*` tags for
// the desktop app and has never carried a CLI tag, so watching it would report
// "up to date" forever.
//
// Installing is deliberately not one hardcoded command. The same binary reaches
// people three ways, and running the wrong one is worse than doing nothing:
//
//   - global npm install  -> `npm i -g eaon-cli@<version>` works
//   - bundled in Eaon.app -> npm would install a SECOND copy that the app's own
//                            launcher then shadows, so the honest answer is to
//                            point at the app's updater
//   - git checkout / npx  -> there is nothing to install over; say so
//
// So `detectInstall()` decides, and anything it cannot place is reported rather
// than guessed at.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMac } from "../platform.js";

const run = promisify(execFile);

const PACKAGE_NAME = "eaon-cli";

// The *packument*, not `/eaon-cli/latest`. The abbreviated metadata format is
// only offered on the package document — asking for it on `/latest` answers
// **406 Not Acceptable**, which is how this silently returned "no update
// available" forever. The abbreviated doc is a fraction of the full one and
// carries dist-tags, which is all that is needed here.
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const ABBREVIATED = "application/vnd.npm.install-v1+json";

/** Plain dot-separated integer compare — same algorithm as the Mac app's
 * EaonCLILauncher.isNewerVersion, so the CLI and the app never disagree about
 * what "newer" means. Non-numeric suffixes (`-beta.1`) compare as 0, which
 * treats a prerelease as equal to its base version rather than newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(".").map((p) => parseInt(p, 10) || 0);
  const b = current.split(".").map((p) => parseInt(p, 10) || 0);
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export type InstallKind = "npm-global" | "bundled-app" | "source" | "unknown";

export interface InstallInfo {
  kind: InstallKind;
  /** Directory the running code lives in — the evidence for `kind`. */
  root: string;
  /** What updating will actually do, shown in the dialog footnote. */
  action: string;
  /** False when this install cannot update itself. */
  canSelfUpdate: boolean;
}

/** Where the running module lives. */
function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Nearest ancestor directory containing a package.json.
 *
 * Walked rather than assumed, because the module sits at a different depth
 * depending on how it is running: `src/update/` under tsx, `dist/update/` once
 * built. Hardcoding `..` classified a source checkout as "unknown" and offered
 * no update path at all.
 */
function findPackageRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Classify this install from its path on disk.
 *
 * Order matters: a copy bundled inside Eaon.app also sits inside something that
 * looks like a node package, so the app check has to come first.
 */
export function detectInstall(): InstallInfo {
  const dir = moduleDir();

  if (isMac && dir.includes("/Eaon.app/Contents/Resources/")) {
    return {
      kind: "bundled-app",
      root: dir,
      action: "Update from Eaon Desktop → Settings → Eaon CLI.",
      canSelfUpdate: false,
    };
  }

  // A published install always has .../node_modules/eaon-cli/ above it.
  if (dir.includes(`${path.sep}node_modules${path.sep}${PACKAGE_NAME}`)) {
    return {
      kind: "npm-global",
      root: findPackageRoot(dir) ?? dir,
      action: `Runs: npm install -g ${PACKAGE_NAME}@latest`,
      canSelfUpdate: true,
    };
  }

  // A checkout has the sources next to the build output.
  const root = findPackageRoot(dir);
  if (root && existsSync(path.join(root, "src"))) {
    return {
      kind: "source",
      root,
      action: "Source checkout — update with git pull && npm run build.",
      canSelfUpdate: false,
    };
  }

  return {
    kind: "unknown",
    root: dir,
    action: `Update manually: npm install -g ${PACKAGE_NAME}@latest`,
    canSelfUpdate: false,
  };
}

/**
 * The newest published version, or null if the registry cannot be reached.
 *
 * Best-effort and short-timeout on purpose: a version check must never be the
 * reason a terminal session is slow to start or fails to start at all.
 */
export async function fetchLatestVersion(timeoutMs = 4000): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: ABBREVIATED, "User-Agent": "eaon-cli (+https://eaon.dev)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = body["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}

export interface UpdateAvailability {
  latest: string;
  current: string;
  install: InstallInfo;
}

/** Null when already current, offline, or the version is unreadable. */
export async function checkForUpdate(currentVersion: string): Promise<UpdateAvailability | null> {
  const latest = await fetchLatestVersion();
  if (!latest || !isNewerVersion(latest, currentVersion)) return null;
  return { latest, current: currentVersion, install: detectInstall() };
}

export interface UpdateResult {
  ok: boolean;
  /** Shown to the user verbatim. */
  message: string;
}

/**
 * Perform the update.
 *
 * Runs npm directly rather than through a shell, so a version string can never
 * be interpreted as shell syntax. npm's own output is captured and only
 * surfaced on failure, where it is the only useful thing to show — a bare
 * "update failed" for an EACCES on a root-owned prefix would send someone
 * hunting for the wrong problem.
 */
export async function performUpdate(target: UpdateAvailability): Promise<UpdateResult> {
  const { install, latest } = target;

  if (!install.canSelfUpdate) {
    return { ok: false, message: install.action };
  }

  try {
    await run("npm", ["install", "-g", `${PACKAGE_NAME}@${latest}`], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: true,
      message: `Updated to v${latest}. Restart eaon to use it.`,
    };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").trim().split("\n").slice(-4).join("\n");
    const permissionish = /EACCES|EPERM|permission denied/i.test(detail);
    return {
      ok: false,
      message: permissionish
        ? `Update failed — npm could not write to the global prefix.\nTry: sudo npm install -g ${PACKAGE_NAME}@${latest}\n\n${detail}`
        : `Update failed.\n${detail || "npm exited non-zero with no output."}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Bundled-copy check (kept from the original updateCheck)                     */
/* -------------------------------------------------------------------------- */

/** The one place Eaon Desktop bundles a copy of this CLI, mirroring
 * EaonCLILauncher.bundledPayloadDirectory. Windows/Linux have no bundled
 * distribution, so this is macOS-only rather than a guess at one. */
function bundledAppPackageJSON(): string | null {
  if (!isMac) return null;
  const p = "/Applications/Eaon.app/Contents/Resources/eaon-cli/package.json";
  return existsSync(p) ? p : null;
}

/** The bundled version when it is newer than `currentVersion`, else null. */
export function checkForBundledUpdate(currentVersion: string): string | null {
  try {
    const packagePath = bundledAppPackageJSON();
    if (!packagePath) return null;
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    const bundled = typeof pkg.version === "string" ? pkg.version : null;
    if (!bundled || !isNewerVersion(bundled, currentVersion)) return null;
    return bundled;
  } catch {
    return null;
  }
}

export function updateNoticeLine(bundledVersion: string): string {
  return `A newer Eaon CLI (v${bundledVersion}) is bundled with Eaon Desktop — update via Settings → Eaon CLI.`;
}
