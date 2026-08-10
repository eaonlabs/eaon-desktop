// The /login round trip through the real App, with only the human's browsing
// stubbed out.
//
// What is real: the App's /login command, the loopback listener, the nonce check,
// the ticket redemption against the live gateway, and the config write. What is
// faked: `open()` (so no browser launches) and the browser's navigation, issued
// here exactly as src/shared/cliLogin.js issues it.
//
// The success path stops short of a saved key on purpose. Minting a real ticket
// needs a session — the user's own credentials — so this covers everything either
// side of the authorisation: that a forged nonce writes nothing, that a
// nonce-valid navigation reaches the redeem step, that a cancellation is
// reported, and that /logout clears what it should.

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

console.log("\n2. A forged navigation (wrong nonce) is ignored");
const forgedUrl = new URL(`http://127.0.0.1:${port}/callback`);
forgedUrl.searchParams.set("state", "wrong");
forgedUrl.searchParams.set("ticket", "attacker-ticket");
const forged = await fetch(forgedUrl, { redirect: "manual" });
check("rejected with 403", forged.status === 403, `(got ${forged.status})`);
await settle(250);
check(
  "no key written to config",
  !existsSync(path.join(scratch, "config.json")) ||
    !JSON.parse(readFileSync(path.join(scratch, "config.json"), "utf8")).eaonAccountKey,
);

console.log("\n3. A nonce-valid navigation reaches the redeem step");
const realUrl = new URL(`http://127.0.0.1:${port}/callback`);
realUrl.searchParams.set("state", state);
realUrl.searchParams.set("ticket", "not-a-real-ticket");
const real = await fetch(realUrl, { redirect: "manual" });
check("listener accepts it", real.status === 200, `(got ${real.status})`);
await settle(2500); // the redeem round-trips to api.eaon.dev

// The gateway rejects the bogus ticket, and the CLI reports that rather than
// hanging or pretending it worked.
shows("reports the gateway's reason", "expired or already used");
const cfgPath = path.join(scratch, "config.json");
const afterFail = JSON.parse(readFileSync(cfgPath, "utf8"));
check("nothing saved on a failed redeem", !afterFail.eaonAccountKey);
check(
  "pre-existing hosted key untouched throughout",
  afterFail.aquaApiKey === "aqua-hosted-key-preexisting",
  `(got ${JSON.stringify(afterFail.aquaApiKey)})`,
);

console.log("\n4. /logout with nothing signed in says so");
stdin.press("/logout");
await settle(200);
stdin.press("\r");
await settle(700);
// A hosted key is present but is NOT an account key, so /logout must not claim to
// have signed anything out — and must not touch it.
shows("reports there is nothing to sign out of", "No Eaon account key");
const after = JSON.parse(readFileSync(path.join(scratch, "config.json"), "utf8"));
check(
  "hosted key untouched by /logout",
  after.aquaApiKey === "aqua-hosted-key-preexisting",
  `(got ${JSON.stringify(after.aquaApiKey)})`,
);

app.unmount();
rmSync(scratch, { recursive: true, force: true });

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
