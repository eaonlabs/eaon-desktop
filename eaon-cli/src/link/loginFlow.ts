// The browser half of /login: sign in to a real Eaon account and come back
// holding an API key.
//
// Distinct from /link, which is a settings page for typing keys in by hand and
// importing them from Eaon Desktop. This authenticates: the browser goes to the
// actual eaon.dev sign-in, so GitHub and Discord work, and the page hands a
// freshly-minted account key back to this process.
//
// ## Shape of the handoff
//
// 1. Bind a one-shot HTTP server to 127.0.0.1 on an OS-assigned port.
// 2. Open `eaon.dev/login.html?cli=1&port=<port>&state=<nonce>`.
// 3. The user authenticates however they like.
// 4. The page mints a key against the session it just established and POSTs
//    `{state, key}` to `http://127.0.0.1:<port>/callback`.
// 5. State is compared, the key is kept, the server closes.
//
// ## Why it is built this way
//
// **The nonce is not decoration.** Any page in the browser can POST to a
// loopback port. Without a secret that only this process and the page it opened
// know, any site the user happened to have open could push an attacker's key
// into their CLI — every subsequent request would then bill to, and be readable
// by, someone else's account. A mismatched state is dropped.
//
// **The key travels in a POST body, never a URL.** A redirect to
// `127.0.0.1/callback?key=sk-eaon-…` would work, and would also write a live
// credential into the browser's history and into this process's request log.
//
// **Only the port is taken from the caller, never a host.** The page builds its
// callback from a fixed `http://127.0.0.1` plus a port number it validates,
// so a crafted `?redirect=` cannot turn the login page into an exfiltration hop.

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Where the sign-in page lives. Same origin the OAuth callback is registered
 *  against, so this is not a value worth making configurable. */
const LOGIN_ORIGIN = "https://eaon.dev";

/** Long enough to find a password manager, short enough that a forgotten tab
 *  does not leave a listener open all day. */
const TIMEOUT_MS = 5 * 60_000;

export type LoginOutcome =
  | { kind: "success"; apiKey: string; email: string | null }
  | { kind: "cancelled" }
  | { kind: "timed_out" }
  | { kind: "error"; message: string };

export interface LoginFlow {
  /** The URL to open. Resolves once the server is actually listening. */
  url: Promise<string>;
  /** Resolves when the browser reports back, the user cancels, or time runs out. */
  result: Promise<LoginOutcome>;
  /** Stop early — used when the user hits Esc in the TUI. */
  cancel: () => void;
}

/** Constant-time compare that cannot throw on a length mismatch. */
function statesMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, limitBytes = 8 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A loopback endpoint still should not accept an unbounded upload.
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The page the browser is left on once the terminal has the key. */
function donePage(ok: boolean, detail: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Eaon CLI</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#08080a; color:#f4f4f5;
         font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif }
  .card { text-align:center; padding:2rem 2.5rem; border:1px solid rgba(255,255,255,.08);
          border-radius:14px; background:#0e0e11; max-width:26rem }
  h1 { margin:0 0 .5rem; font-size:1.15rem; letter-spacing:-.01em }
  p { margin:0; color:#a5a5ae; font-size:13.5px }
  .mark { font-size:1.6rem; margin-bottom:.75rem; color:${ok ? "#3ddc97" : "#f87171"} }
</style></head>
<body><div class="card">
  <div class="mark">${ok ? "&#10003;" : "&#33;"}</div>
  <h1>${ok ? "Signed in to Eaon" : "Sign-in did not complete"}</h1>
  <p>${detail}</p>
</div></body></html>`;
}

/**
 * Start the flow. Nothing is written to disk here — the caller decides what to
 * do with the key, so a cancelled login cannot leave half-applied state.
 */
export function runLoginServer(): LoginFlow {
  const state = randomBytes(32).toString("base64url");

  let resolveUrl!: (value: string) => void;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });

  let settle!: (outcome: LoginOutcome) => void;
  let done = false;
  const result = new Promise<LoginOutcome>((resolve) => {
    settle = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Let the final response flush before tearing the listener down.
      setImmediate(() => server.close());
      resolve(outcome);
    };
  });

  const server = http.createServer((req, res) => {
    // The page runs on eaon.dev and this server is on localhost, so the POST is
    // cross-origin. Allow exactly that one origin — a wildcard would let any
    // site read the responses here.
    res.setHeader("Access-Control-Allow-Origin", LOGIN_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204).end();
      return;
    }

    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "POST" && path === "/callback") {
      void (async () => {
        try {
          const parsed = JSON.parse(await readBody(req)) as {
            state?: unknown;
            key?: unknown;
            email?: unknown;
            error?: unknown;
          };

          if (!statesMatch(state, parsed.state)) {
            // Deliberately terse: an unauthenticated caller learns nothing about
            // whether the state was close, and the CLI keeps waiting for the
            // real callback rather than giving up on someone else's noise.
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "state mismatch" }));
            return;
          }

          if (typeof parsed.error === "string" && parsed.error) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            settle({ kind: "error", message: parsed.error });
            return;
          }

          const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
          if (!key.toLowerCase().startsWith("sk-eaon-")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not an Eaon account key" }));
            settle({ kind: "error", message: "The browser returned something that isn't an Eaon account key." });
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          settle({
            kind: "success",
            apiKey: key,
            email: typeof parsed.email === "string" && parsed.email ? parsed.email : null,
          });
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
          settle({ kind: "error", message: err instanceof Error ? err.message : "Malformed callback." });
        }
      })();
      return;
    }

    // The page navigates here itself after a successful POST, so the tab ends on
    // something that explains what happened instead of a dead localhost error.
    if (req.method === "GET" && path === "/done") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(donePage(true, "Your API key is now saved in this machine's Eaon CLI. You can close this tab."));
      return;
    }

    if (req.method === "GET" && path === "/failed") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(donePage(false, "Nothing was saved. Run /login in the terminal to try again."));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  });

  const timer = setTimeout(() => settle({ kind: "timed_out" }), TIMEOUT_MS);
  // Do not hold the process open on this listener alone.
  timer.unref?.();

  server.on("error", (err) => {
    settle({ kind: "error", message: `Could not start the local sign-in listener: ${err.message}` });
    resolveUrl("");
  });

  // Port 0 = let the OS pick a free one, and bind loopback only so nothing on
  // the network can reach it.
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const params = new URLSearchParams({ cli: "1", port: String(port), state });
    resolveUrl(`${LOGIN_ORIGIN}/login.html?${params.toString()}`);
  });

  return {
    url,
    result,
    cancel: () => settle({ kind: "cancelled" }),
  };
}
