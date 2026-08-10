// Does a fake stdin actually reach Ink's useInput? Isolates the harness from
// the app, so a failure in app-probe can be attributed to one or the other.
import React, { useState } from "react";
import { render, Text, useInput } from "ink";
import { EventEmitter } from "node:events";

class FakeOut extends EventEmitter {
  columns = 80;
  rows = 20;
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

function Probe(): React.ReactElement {
  const [seen, setSeen] = useState<string[]>([]);
  useInput((input, key) => {
    setSeen((s) => [...s, key.ctrl ? `ctrl+${input}` : key.escape ? "esc" : input]);
  });
  return <Text>SEEN[{seen.join(",")}]</Text>;
}

const stdout = new FakeOut();
const stdin = new FakeIn();
const app = render(<Probe />, {
  stdout: stdout as never,
  stdin: stdin as never,
  exitOnCtrlC: false,
  patchConsole: false,
});

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
await settle();

console.log(`  listeners on 'data': ${stdin.listenerCount("data")}`);
console.log(`  listeners on 'readable': ${stdin.listenerCount("readable")}`);
console.log(`  all event names: ${JSON.stringify(stdin.eventNames())}`);

stdin.press(String.fromCharCode(16)); // ctrl+p
await settle();
stdin.press("x");
await settle();

const ESC = String.fromCharCode(27);
const frame = stdout.frames.join("").replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");
console.log(`  last frame: ${JSON.stringify(frame.slice(-60))}`);
app.unmount();

const worked = frame.includes("ctrl+p") || frame.includes("x");
console.log(`\n  ${worked ? "PASS — fake stdin reaches useInput" : "FAIL — fake stdin never reaches useInput"}\n`);
process.exit(worked ? 0 : 1);
