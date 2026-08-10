// Renders the whole App and drives it by keystroke, which is the only way to
// prove the wiring: the components pass in isolation, but ctrl+p opening the
// palette, the composer going inert behind an overlay, and esc unwinding are all
// properties of App, not of any one component.
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { App } from "../src/ui/App.js";

class FakeOut extends EventEmitter {
  columns = 110;
  rows = 46;
  isTTY = true;
  frames: string[] = [];
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
}

/** A stdin Ink will attach to, and that tests can push keys into. */
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

const stdout = new FakeOut();
const stdin = new FakeIn();

const app = render(
  <App
    version="0.3.0"
    initialMode="agent"
    initialModelKey={null}
    projectRoot="/tmp/eaon-tui-test"
    startInAuto={false}
    startPermissionMode="sandboxed"
    resumeSessionId={undefined}
    continueLatest={false}
    forceWelcome={false}
  />,
  { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
);

const settle = (ms = 260) => new Promise((r) => setTimeout(r, ms));
/** Only the frames written since the marker, so assertions aren't polluted by
 *  everything painted earlier in the session. */
let mark = 0;
function since(): string {
  const out = stdout.frames.slice(mark).join("").replace(ANSI, "");
  return out;
}
function remark(): void {
  mark = stdout.frames.length;
}

let pass = 0;
let fail = 0;
function has(label: string, needle: string): void {
  const ok = since().includes(needle);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (missing ${JSON.stringify(needle)})`}`);
}
function lastFrame(): string {
  return (stdout.frames[stdout.frames.length - 1] ?? "").replace(ANSI, "");
}
function lacks(label: string, needle: string): void {
  // The final frame, not every frame since the mark — the frames written while
  // an overlay was mounting still contain what it replaced.
  const ok = !lastFrame().includes(needle);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
}

await settle(900); // catalog load + first paint

console.log("\n1. Idle screen");
has("wordmark drawn", "█");
has("composer placeholder", "Ask anything");
has("hint row: agents", "agents");
has("hint row: commands", "ctrl+p");
has("footer version", "v0.3.0");
has("footer path", "eaon-tui-test");
has("mode label inside the bar", "Ask");

console.log("\n2. ctrl+p opens the command palette");
remark();
stdin.press(String.fromCharCode(16)); // ctrl+p
await settle();
has("palette title", "Commands");
has("Account group", "Account");
has("Agent group", "Agent");
has("Usage row", "Usage");
has("API keys row", "API keys");

console.log("\n3. Typing filters the palette");
remark();
stdin.press("theme");
await settle();
has("filtered to the theme row", "Switch theme");
lacks("unrelated rows dropped", "New session");

console.log("\n4. esc closes and the composer comes back");
remark();
stdin.press(ESC);
await settle();
has("back to the composer", "Ask anything");
lacks("palette gone", "Commands");

console.log("\n5. /themes opens the picker and lists schemes");
remark();
stdin.press("/themes");
await settle(200);
stdin.press("\r");
await settle(400);
has("themes title", "Themes");
has("lists a scheme", "matrix");
has("marks the current one", "●");

console.log("\n6. Moving the highlight recolours live, esc restores");
remark();
stdin.press(String.fromCharCode(27) + "[B"); // down arrow
await settle();
const { activeThemeName } = await import("../src/ui/theme.js");
console.log(`     scheme while previewing: ${activeThemeName()}`);
stdin.press(ESC);
await settle(300);
console.log(`     scheme after esc: ${activeThemeName()}`);
const restored = activeThemeName() === "opencode";
restored ? pass++ : fail++;
console.log(`  ${restored ? "ok  " : "FAIL"} cancelling restores the saved scheme`);

console.log("\n7. /usage opens the account panel on the right tab");
remark();
stdin.press("/usage");
await settle(200);
stdin.press("\r");
await settle(600);
has("account panel", "Account");
has("usage tab active", "Usage");

// The composer stays on screen behind a modal — the reference does the same.
// What must be true is that it no longer takes input, so type into it and check
// nothing lands.
remark();
stdin.press("zzz");
await settle();
lacks("composer ignores input while an overlay is up", "zzz");

console.log("\n8. esc closes the account panel");
remark();
stdin.press(ESC);
await settle(300);
has("composer restored", "Ask anything");

app.unmount();
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
