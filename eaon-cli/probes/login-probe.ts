// Exercises the /login loopback listener as a real HTTP server.
//
// The browser reaches it by NAVIGATION (a GET with query parameters), not a
// fetch — Chrome blocks every http:// subresource from an HTTPS page as mixed
// content, so a POST from eaon.dev can never arrive. These tests drive it the way
// the browser actually does.
//
// The security properties are the point of this file: a loopback port is
// reachable by any page in the browser, so "a wrong-nonce request is ignored" and
// "only 127.0.0.1 is bound" matter more than the happy path. A test that only
// covered the happy path would pass on a listener that accepts anyone's ticket.

import { runLoginServer } from "../src/link/loginFlow.js";

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = ""): void {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : `  ${detail}`}`);
}

/** Pull the port and nonce back out of the URL the flow published. */
function parse(url: string): { port: string; state: string } {
  const q = new URL(url);
  return { port: q.searchParams.get("port")!, state: q.searchParams.get("state")! };
}

/** A navigation to the callback, exactly as the browser performs it. */
async function visit(port: string, params: Record<string, string>) {
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { redirect: "manual" });
}

console.log("\n1. The published URL");
{
  const flow = runLoginServer();
  const url = await flow.url;
  console.log(`     ${url.replace(/state=[^&]+/, "state=<32-byte-nonce>")}`);
  check("points at the real sign-in page", url.startsWith("https://eaon.dev/login.html?"));
  check("declares CLI mode", url.includes("cli=1"));
  const { port, state } = parse(url);
  check("carries an OS-assigned port", Number(port) >= 1024);
  check("carries a high-entropy nonce", state.length >= 40, `(got ${state.length} chars)`);
  flow.cancel();
  check("cancel resolves as cancelled", (await flow.result).kind === "cancelled");
}

console.log("\n2. A wrong nonce is refused, and does NOT consume the flow");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);

  const bad = await visit(port, { state: "not-the-nonce", ticket: "attacker-ticket" });
  check("refused with 403", bad.status === 403, `(got ${bad.status})`);
  check("answers with a page, not JSON", (bad.headers.get("content-type") ?? "").includes("text/html"));

  // A forgery must not be able to end the user's real login attempt.
  let settled = false;
  void flow.result.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 120));
  check("flow still waiting", !settled);

  // A real navigation with a bogus ticket gets past the nonce and fails at the
  // redeem step instead — which is the gateway's call, not the listener's.
  const real = await visit(port, { state, ticket: "definitely-not-a-real-ticket" });
  check("nonce-valid request is accepted by the listener", real.status === 200, `(got ${real.status})`);
  const outcome = await flow.result;
  check("but reports the redeem failure", outcome.kind === "error");
  if (outcome.kind === "error") {
    console.log(`     reason: ${outcome.message}`);
    check("names the ticket as the problem", /ticket/i.test(outcome.message));
  }
}

console.log("\n3. A missing ticket is reported rather than hanging");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);
  const res = await visit(port, { state });
  check("refused with 400", res.status === 400, `(got ${res.status})`);
  const outcome = await flow.result;
  check("reported as an error", outcome.kind === "error");
}

console.log("\n4. The page can report why it failed (Cancel takes this path)");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);
  await visit(port, { state, error: "You cancelled the sign-in in your browser." });
  const outcome = await flow.result;
  check(
    "message surfaces verbatim",
    outcome.kind === "error" && outcome.message === "You cancelled the sign-in in your browser.",
  );
}

console.log("\n5. Bound to loopback only");
{
  const flow = runLoginServer();
  const { port } = parse(await flow.url);

  // If this were bound to 0.0.0.0 the machine's LAN address would answer too.
  const { networkInterfaces } = await import("node:os");
  const external = Object.values(networkInterfaces())
    .flat()
    .find((n) => n && n.family === "IPv4" && !n.internal)?.address;

  if (!external) {
    console.log("     (no external IPv4 on this machine — nothing to probe)");
    pass++;
  } else {
    let reachable = false;
    try {
      await fetch(`http://${external}:${port}/failed`, { signal: AbortSignal.timeout(1200) });
      reachable = true;
    } catch {
      reachable = false;
    }
    check(`not reachable on ${external}`, !reachable);
  }
  flow.cancel();
  await flow.result;
}

console.log("\n6. Unknown paths are not a way in");
{
  const flow = runLoginServer();
  const { port } = parse(await flow.url);
  const res = await fetch(`http://127.0.0.1:${port}/../etc/passwd`, { redirect: "manual" });
  check("404 rather than anything else", res.status === 404, `(got ${res.status})`);
  flow.cancel();
  await flow.result;
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
