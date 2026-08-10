// The browser half of /login: sign in to a real Eaon account and come back
// holding an API key.
//
// Distinct from /link, which is a settings page for typing keys in by hand and
// importing them from Eaon Desktop. This authenticates: the browser goes to the
// actual eaon.dev sign-in, so GitHub and Discord work.
//
// ## Shape of the handoff
//
// 1. Bind a one-shot HTTP server to 127.0.0.1 on an OS-assigned port.
// 2. Open `eaon.dev/login.html?cli=1&port=<port>&state=<nonce>`.
// 3. The user authenticates and authorises on the consent screen.
// 4. The gateway mints a key server-side and gives the page a single-use
//    *ticket* — never the key.
// 5. The page NAVIGATES the browser to `http://127.0.0.1:<port>/callback?state&ticket`.
// 6. This server checks the nonce, then redeems the ticket against
//    api.eaon.dev over HTTPS to get the key.
//
// ## Why a navigation, and why a ticket
//
// The first version had the page POST the key straight here. That cannot work:
// the page is HTTPS and this listener is HTTP, and Chrome blocks every `http://`
// subresource from an HTTPS page as mixed content — confirmed with fetch,
// no-cors fetch and an `<img>`, all blocked identically. No response header
// fixes it, because it is not a CORS decision.
//
// A top-level navigation is exempt, which is why every CLI OAuth flow redirects
// to a loopback instead of fetching one. But a navigation puts its payload in
// the URL, and a long-lived API key in browser history is a real exposure. Hence
// the ticket: it is what lands in history, and by the time it does it is spent.
//
// ## Why the nonce still matters
//
// Any page in the browser can navigate to a loopback port. Without a secret that
// only this process and the page it opened share, a hostile site could drive a
// ticket of its own choosing into this listener. A mismatch is refused, and
// refusing does not consume the flow — otherwise a forgery could deny the user
// their login.

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EAON_GATEWAY_BASE_URL } from "../providers/eaon-hosted.js";

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

type Redeemed =
  | { ok: true; key: string; email: string | null }
  | { ok: false; error: string };

/**
 * Exchange a single-use ticket for the key, over HTTPS against the gateway.
 *
 * Errors are returned rather than thrown so the browser still gets a page
 * explaining what went wrong — a bare connection reset on a localhost tab tells
 * the user nothing.
 */
async function redeemTicket(ticket: string): Promise<Redeemed> {
  const base = EAON_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${base}/v1/cli/handoff/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "eaon-cli (+https://eaon.dev)" },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: { key?: unknown; email?: unknown };
      error?: { message?: string };
    };

    if (!res.ok) {
      return { ok: false, error: body.error?.message || `Could not redeem the handoff (HTTP ${res.status}).` };
    }

    const key = typeof body.data?.key === "string" ? body.data.key.trim() : "";
    if (!key.toLowerCase().startsWith("sk-eaon-")) {
      return { ok: false, error: "The gateway returned something that isn't an Eaon account key." };
    }

    return {
      ok: true,
      key,
      email: typeof body.data?.email === "string" && body.data.email ? body.data.email : null,
    };
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === "TimeoutError" || /abort/i.test(e.message);
    return {
      ok: false,
      error: timedOut ? "Timed out reaching api.eaon.dev to finish signing in." : `Could not finish signing in: ${e.message}`,
    };
  }
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
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;

    // The browser arrives by NAVIGATION, not fetch, so the response is a page
    // rather than JSON — and there is no CORS to configure, because a navigation
    // is not a cross-origin request from the page's point of view.
    if (req.method === "GET" && path === "/callback") {
      void (async () => {
        const given = requestUrl.searchParams.get("state");
        const ticket = requestUrl.searchParams.get("ticket");
        const reported = requestUrl.searchParams.get("error");

        if (!statesMatch(state, given)) {
          // Terse, and deliberately non-consuming: a hostile page that guesses
          // the port must not be able to end the user's real login attempt.
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end(donePage(false, "That request did not come from the sign-in page this terminal opened."));
          return;
        }

        if (reported) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(donePage(false, "Nothing was saved. Run /login in the terminal to try again."));
          settle({ kind: "error", message: reported });
          return;
        }

        if (!ticket) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(donePage(false, "The sign-in page did not return a handoff ticket."));
          settle({ kind: "error", message: "The browser returned no handoff ticket." });
          return;
        }

        // Redeem over HTTPS from here. This is the step that keeps the key out of
        // the browser entirely — it travels gateway → CLI, never through a URL.
        const redeemed = await redeemTicket(ticket);
        if (!redeemed.ok) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(donePage(false, redeemed.error));
          settle({ kind: "error", message: redeemed.error });
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(donePage(true, "Your API key is saved in this machine's Eaon CLI. You can close this tab."));
        settle({ kind: "success", apiKey: redeemed.key, email: redeemed.email });
      })();
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
