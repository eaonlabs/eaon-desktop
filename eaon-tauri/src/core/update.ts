// Real self-updater, backed by Tauri's official updater plugin. On the Rust
// side it fetches `latest.json` from the GitHub Release (auto-published by
// the release workflow), verifies the Ed25519 signature against the pubkey
// pinned in tauri.conf.json, and only then hands back an `Update` — a
// tampered or unsigned release is silently rejected before any bytes reach
// disk. This replaces the old "check a hand-rolled manifest, open a browser
// tab" notifier: this one actually downloads, installs, and relaunches.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { RELEASES_PAGE_URL } from "./catalog";
import { useUi } from "../state/ui";

// The plugin only lets you download+install once per `Update` handle it
// hands back, so the handle from checkForUpdate() is stashed here for
// installUpdateNow() to consume — the UI never touches it directly.
let pendingUpdate: Update | null = null;

/** Silent unless a newer, signature-verified release exists. Safe to call
 *  on every launch and periodically — an unreachable or failing check is
 *  just a no-op, never a surfaced error. */
export async function checkForUpdate(): Promise<void> {
  let update: Update | null;
  try {
    update = await check();
  } catch {
    return;
  }
  if (!update) return;

  pendingUpdate = update;
  useUi.getState().setUpdate({
    latestVersion: update.version,
    releaseNotes: update.body ?? null,
    url: `${RELEASES_PAGE_URL}/tag/v${update.version}`,
  });
}

export type InstallProgress =
  | { phase: "downloading"; fraction: number | null }
  | { phase: "installing" }
  | { phase: "relaunching" }
  | { phase: "failed"; message: string };

/** Downloads the pending update (from the last checkForUpdate() call),
 *  installs it, and relaunches the app — no manual quit-and-reinstall. */
export async function installUpdateNow(onProgress: (progress: InstallProgress) => void): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;

  let contentLength = 0;
  let downloaded = 0;
  try {
    onProgress({ phase: "downloading", fraction: null });
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress({
            phase: "downloading",
            fraction: contentLength > 0 ? downloaded / contentLength : null,
          });
          break;
        case "Finished":
          onProgress({ phase: "installing" });
          break;
      }
    });
    pendingUpdate = null;
    useUi.getState().setUpdate(null);
    onProgress({ phase: "relaunching" });
    // Let the UI show "Restarting…" for a beat before the app vanishes.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await relaunch();
  } catch (error) {
    onProgress({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}
