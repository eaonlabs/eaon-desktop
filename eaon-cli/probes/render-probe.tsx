// Render components into a fake terminal so the frame can be asserted on.
// A pty hangs waiting on stdin, and ink-testing-library isn't a dependency, so
// this passes Ink a collecting stdout and a stdin that claims to be a TTY.
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { Palette } from "../src/ui/Palette.js";
import { ConfirmDialog } from "../src/ui/ConfirmDialog.js";
import { Splash } from "../src/ui/Splash.js";
import { Footer, Hints, readBranch, tildePath } from "../src/ui/Footer.js";
import { applyTheme } from "../src/ui/theme.js";
import { THEME_NAMES } from "../src/ui/themes.js";

class FakeOut extends EventEmitter {
  columns = 100;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
}

/** Ink 5 consumes stdin via the `readable` event + `stream.read()`, not `data`
 *  events — a FakeIn that only emitted `data` was silently ignored, and every
 *  keystroke assertion failed while the app itself was fine. So this queues
 *  chunks and hands them out through read(). */
class FakeIn extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
  setEncoding(): this { return this; }
  unref(): this { return this; }
  ref(): this { return this; }
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  press(seq: string): void {
    this.queue.push(seq);
    this.emit("readable");
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

async function frameOf(node: React.ReactElement): Promise<string> {
  const stdout = new FakeOut();
  const app = render(node, {
    stdout: stdout as never,
    stdin: new FakeIn() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 80));
  app.unmount();
  return strip(stdout.frames.join(""));
}

let pass = 0;
let fail = 0;

function has(label: string, frame: string, needle: string): void {
  const ok = frame.includes(needle);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (missing ${JSON.stringify(needle)})`}`);
}

function check(label: string, condition: boolean): void {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}`);
}

console.log("\n1. Command palette");
const cmdFrame = await frameOf(
  <Palette
    title="Commands"
    rows={[
      { id: "model", label: "Switch model", accel: "ctrl+x m", group: "Suggested" },
      { id: "new", label: "New session", accel: "ctrl+x n", group: "Session" },
      { id: "usage", label: "Usage", group: "Account" },
    ]}
    onSelect={() => {}}
    onCancel={() => {}}
  />,
);
has("title", cmdFrame, "Commands");
has("esc hint", cmdFrame, "esc");
has("search placeholder", cmdFrame, "earch");
has("group: Suggested", cmdFrame, "Suggested");
has("group: Session", cmdFrame, "Session");
has("group: Account", cmdFrame, "Account");
has("row label", cmdFrame, "Switch model");
has("accelerator column", cmdFrame, "ctrl+x m");

console.log("\n2. Theme picker");
applyTheme("matrix");
const themeFrame = await frameOf(
  <Palette
    title="Themes"
    rows={THEME_NAMES.map((n) => ({ id: n, label: n, current: n === "tokyonight" }))}
    initialId="tokyonight"
    visible={18}
    onSelect={() => {}}
    onCancel={() => {}}
  />,
);
has("title", themeFrame, "Themes");
has("lists matrix", themeFrame, "matrix");
has("opens scrolled to the active scheme", themeFrame, "tokyonight");
has("marks the active scheme", themeFrame, "●");

console.log("\n3. Update dialog");
const upd = await frameOf(
  <ConfirmDialog
    title="Update Available"
    message="A new release v1.18.16 is available. Would you like to update now?"
    footnote="Runs: npm install -g eaon-cli@latest"
    onConfirm={() => {}}
    onCancel={() => {}}
  />,
);
has("title", upd, "Update Available");
has("body copy", upd, "A new release v1.18.16 is available");
has("Skip button", upd, "Skip");
has("Confirm button", upd, "Confirm");
has("footnote names the command", upd, "npm install -g eaon-cli");

console.log("\n4. Splash");
applyTheme("opencode");
const splash = await frameOf(<Splash width={100} />);
has("draws block glyphs", splash, "█");
const narrow = await frameOf(<Splash width={20} />);
has("narrow: plain title", narrow, "EAON");
check("narrow: drops the block art rather than wrapping it", !narrow.includes("█"));

console.log("\n5. Footer and hints");
const foot = await frameOf(<Footer projectRoot="/tmp/eaon-tui-test" version="v0.3.0" width={100} />);
has("version", foot, "v0.3.0");
has("project path", foot, "eaon-tui-test");
const hints = await frameOf(<Hints />);
has("agents hint", hints, "agents");
has("commands hint", hints, "ctrl+p");

console.log("\n6. Footer helpers against a real repo");
const branch = readBranch("/tmp/eaon-tui-test");
console.log(`     .git/HEAD -> ${JSON.stringify(branch)}`);
check("branch resolved to main", branch === "main");
check("home collapses to ~", tildePath(process.env.HOME ?? "") === "~");
check("non-home path left alone", tildePath("/usr/local") === "/usr/local");

console.log("\n7. Theme switching actually changes the palette");
const { theme } = await import("../src/ui/theme.js");
applyTheme("matrix");
const matrixAccent = theme.accent;
applyTheme("tokyonight");
const tokyoAccent = theme.accent;
check("accent differs between schemes", matrixAccent !== tokyoAccent);
applyTheme("does-not-exist");
check("unknown scheme falls back rather than throwing", theme.accent === "#E8B48B");

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
