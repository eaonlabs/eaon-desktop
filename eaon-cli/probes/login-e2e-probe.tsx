// The whole /login round trip through the real App, with only the human's
// browsing stubbed out.
//
// What is real: the App's /login command, the loopback listener, the state
// nonce, the config write. What is faked: `open()` (so no browser launches) and
// the page's POST, which is issued here exactly as src/shared/cliLogin.js issues
// it. That boundary is deliberate — completing a genuine sign-in needs the
// user's own credentials, so this proves everything up to and after the
// authentication, not the authentication itself.

import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Point the CLI's config at a scratch dir BEFORE anything imports config.js,
// so this can never touch the developer's real key.
const scratch = mkdtempSync(path.join(os.tmpdir(), "eaon-login-e2e-"));
process.env.EAON_CONFIG_DIR = scratch;

const { configDir } = await import("../src/platform.js");
const usingScratch = configDir() === scratch;

// A config file must exist or App shows the one-time first-run screen instead of
// the app, and swallows every keystroke aimed at the composer.
const { writeFileSync } = await import("node:fs");
writeFileSync(
  path.join(scratch, "config.json"),
  JSON.stringify(
    {
      aquaApiKey: "aqua-hosted-key-preexisting",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      customProviders: [],
      selectedModelKey: null,
      permissionMode: "sandboxed",
      defaultMode: "agent",
      customInstructions: "",
      theme: "opencode",
    },
    null,
    2,
  ),
  "utf8",
);

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
class FakeIn extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
  setEncoding(): this { return this; }
  unref(): this { return this; }
  ref(): this { return this; }
  read(): string | null { return this.queue.shift() ?? null; }
  press(seq: string): void {
    this.queue.push(seq);
    this.emit("readable");
  }
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = ""): void {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `  ${detail}`}`);
}

console.log("\n0. Isolation");
check("config redirected to a scratch dir", usingScratch, `(configDir()=${configDir()})`);
if (!usingScratch) {
  console.log("\n  Refusing to continue — this would write to the real config.\n");
  process.exit(1);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

const { App } = await import("../src/ui/App.js");
const stdout = new FakeOut();
const stdin = new FakeIn();

const app = render(
  <App
    version="0.4.0"
    initialMode="agent"
    initialModelKey={null}
    projectRoot={scratch}
    startInAuto={false}
    startPermissionMode="sandboxed"
    resumeSessionId={undefined}
    continueLatest={false}
    forceWelcome={false}
  />,
  { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
);

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const frames = () => stdout.frames.join("").replace(ANSI, "");
function shows(label: string, needle: string): void {
  check(label, frames().includes(needle), `(missing ${JSON.stringify(needle)})`);
}

await settle(900);

console.log("\n1. /login publishes a sign-in URL");
stdin.press("/login");
await settle(200);
stdin.press("\r");
await settle(700);

shows("announces it is opening a browser", "sign in to Eaon");
shows("prints the URL", "https://eaon.dev/login.html?cli=1");
shows("says it is waiting", "Waiting for the browser");

// Recover the port and nonce from what the CLI told the user.
const printed = /https:\/\/eaon\.dev\/login\.html\?\S+/.exec(frames());
check("URL captured from the transcript", printed !== null);
const url = new URL(printed![0]);
const port = url.searchParams.get("port")!;
const state = url.searchParams.get("state")!;
check("port is loopback-range", Number(port) >= 1024);
check("nonce is long", state.length >= 40);

console.log("\n2. A forged callback (wrong nonce) is ignored");
const forged = await fetch(`http://127.0.0.1:${port}/callback`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://eaon.dev" },
  body: JSON.stringify({ state: "wrong", key: "sk-eaon-attacker000000000000000000" }),
});
check("rejected with 403", forged.status === 403, `(got ${forged.status})`);
await settle(250);
check(
  "no key written to config",
  !existsSync(path.join(scratch, "config.json")) ||
    !JSON.parse(readFileSync(path.join(scratch, "config.json"), "utf8")).eaonAccountKey,
);

console.log("\n3. The genuine callback completes the login");
const REAL_KEY = "sk-eaon-11112222333344445555666677778888";
const good = await fetch(`http://127.0.0.1:${port}/callback`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://eaon.dev" },
  body: JSON.stringify({ state, key: REAL_KEY, email: "dev@example.com" }),
});
check("accepted", good.ok, `(got ${good.status})`);
await settle(1200);

shows("reports who signed in", "Signed in as dev@example.com");

const saved = JSON.parse(readFileSync(path.join(scratch, "config.json"), "utf8"));
check("account key persisted to its own field", saved.eaonAccountKey === REAL_KEY, `(got ${JSON.stringify(saved.eaonAccountKey)})`);
// The bug this guards: /login used to write over aquaApiKey, throwing away the
// hosted key that was serving this user's models.
check(
  "pre-existing hosted key left untouched",
  saved.aquaApiKey === "aqua-hosted-key-preexisting",
  `(got ${JSON.stringify(saved.aquaApiKey)})`,
);

console.log("\n4. /logout removes it again");
stdin.press("/logout");
await settle(200);
stdin.press("\r");
await settle(700);
shows("confirms sign-out", "Signed out");
const after = JSON.parse(readFileSync(path.join(scratch, "config.json"), "utf8"));
check("account key cleared", !after.eaonAccountKey, `(got ${JSON.stringify(after.eaonAccountKey)})`);
check(
  "hosted key survives /logout too",
  after.aquaApiKey === "aqua-hosted-key-preexisting",
  `(got ${JSON.stringify(after.aquaApiKey)})`,
);

app.unmount();
rmSync(scratch, { recursive: true, force: true });

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
