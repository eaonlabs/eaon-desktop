#!/usr/bin/env node
// Stages a production build of eaon-cli into resources/eaon-cli/, where
// tauri.conf.json's "bundle.resources" picks it up and Tauri copies it into
// every platform's installer (see src-tauri/src/eaon_cli.rs's
// bundled_payload_dir, which is what the app's "Install Eaon CLI" button
// reads from at runtime).
//
// Node, not shell, because this has to run identically on the release
// workflow's windows-latest AND ubuntu-22.04 runners (see
// .github/workflows/release.yml) without a bash-vs-cmd fork.
//
// Built in an isolated temp copy — mirrors the Mac app's build-installer.sh
// (CLI_STAGE) — so this never touches eaon-cli/node_modules, which is the
// developer's own dev environment (tsx/typescript included) and would break
// if pruned to production-only deps here.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const eaonTauriRoot = path.resolve(here, "..");
const repoRoot = path.resolve(eaonTauriRoot, "..");
const cliSource = path.join(repoRoot, "eaon-cli");
const destination = path.join(eaonTauriRoot, "resources", "eaon-cli");

function run(cmd, args, cwd) {
  console.log(`+ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

/** A recursive copy that actually dereferences every symlink, walking each
 *  directory by hand rather than trusting `fs.cpSync`'s own `dereference`
 *  option — confirmed live (not assumed) that option silently leaves a
 *  symlink alone when its target lives inside the SAME source tree being
 *  copied, which is exactly npm's node_modules/.bin/* shape: those entries
 *  are symlinks pointing at an ABSOLUTE path inside whatever directory ran
 *  `npm ci` (this function's own `stage` temp dir), and left as symlinks
 *  they'd still point there after that directory is deleted at the end of
 *  this script — dangling forever, and Tauri's bundler hard-fails on a
 *  broken symlink at build time rather than silently skipping it. */
function copyRecursive(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.copyFileSync(fs.realpathSync(src), dst);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  fs.copyFileSync(src, dst);
}

if (!fs.existsSync(cliSource)) {
  console.error(`No eaon-cli/ found at ${cliSource} — nothing to stage.`);
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "eaon-cli-stage-"));
try {
  console.log(`== Staging eaon-cli build in ${stage}`);
  for (const name of ["src", "package.json", "package-lock.json", "tsconfig.json"]) {
    copyRecursive(path.join(cliSource, name), path.join(stage, name));
  }

  run("npm", ["ci"], stage);
  run("npm", ["run", "build"], stage);
  run("npm", ["prune", "--omit=dev"], stage);

  console.log(`== Copying built payload into ${destination}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["dist", "node_modules", "package.json"]) {
    copyRecursive(path.join(stage, name), path.join(destination, name));
  }
  console.log("== Done. resources/eaon-cli/ is ready for `tauri build`.");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
