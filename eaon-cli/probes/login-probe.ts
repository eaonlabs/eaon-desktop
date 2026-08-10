// Exercises the /login loopback listener as a real HTTP server.
//
// The security properties are the point of this file: a loopback port is
// reachable by any page in the browser, so "a wrong-state POST is ignored" and
// "only 127.0.0.1 is bound" are the assertions that actually matter. A
// functional test that only covers the happy path would pass on a listener that
// accepts anyone's key.

import { runLoginServer } from "../src/link/loginFlow.js";

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = ""): void {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : `  ${detail}`}`);
}

const KEY = "sk-eaon-cafebabecafebabecafebabecafe";

/** Pull the port and state back out of the URL the flow published. */
function parse(url: string): { port: string; state: string } {
  const q = new URL(url);
  return { port: q.searchParams.get("port")!, state: q.searchParams.get("state")! };
}

async function post(port: string, body: unknown, origin = "https://eaon.dev") {
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
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

console.log("\n2. Happy path");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);
  const res = await post(port, { state, key: KEY, email: "dev@example.com" });
  check("callback accepted", res.ok);
  const outcome = await flow.result;
  check("key handed to the CLI", outcome.kind === "success" && outcome.apiKey === KEY);
  check("email carried through", outcome.kind === "success" && outcome.email === "dev@example.com");
}

console.log("\n3. A wrong nonce is refused, and the CLI keeps waiting");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);

  const bad = await post(port, { state: "not-the-nonce", key: "sk-eaon-attackerkeyattackerkeyattack" });
  check("rejected with 403", bad.status === 403, `(got ${bad.status})`);

  // The listener must still be live — a rejected forgery cannot be allowed to
  // consume the one-shot flow, or an attacker could deny the user their login.
  let settled = false;
  void flow.result.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 120));
  check("flow not settled by the forgery", !settled);

  const good = await post(port, { state, key: KEY });
  check("the real callback still works", good.ok);
  const outcome = await flow.result;
  check("and yields the genuine key", outcome.kind === "success" && outcome.apiKey === KEY);
}

console.log("\n4. Only Eaon-account keys are accepted");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);
  const res = await post(port, { state, key: "sk-openai-1234567890" });
  check("refused with 400", res.status === 400, `(got ${res.status})`);
  const outcome = await flow.result;
  check("reported as an error, not a success", outcome.kind === "error");
}

console.log("\n5. The page can report why it failed");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);
  await post(port, { state, error: "This account needs an invite code." });
  const outcome = await flow.result;
  check(
    "message surfaces verbatim",
    outcome.kind === "error" && outcome.message === "This account needs an invite code.",
  );
}

console.log("\n6. CORS is scoped to eaon.dev, not a wildcard");
{
  const flow = runLoginServer();
  const { port } = parse(await flow.url);
  const pre = await fetch(`http://127.0.0.1:${port}/callback`, {
    method: "OPTIONS",
    headers: { Origin: "https://eaon.dev", "Access-Control-Request-Method": "POST" },
  });
  const allow = pre.headers.get("access-control-allow-origin");
  check("preflight answered", pre.status === 204, `(got ${pre.status})`);
  check("allows exactly eaon.dev", allow === "https://eaon.dev", `(got ${allow})`);
  check("is not a wildcard", allow !== "*");
  flow.cancel();
  await flow.result;
}

console.log("\n7. Bound to loopback only");
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
      await fetch(`http://${external}:${port}/done`, { signal: AbortSignal.timeout(1200) });
      reachable = true;
    } catch {
      reachable = false;
    }
    check(`not reachable on ${external}`, !reachable);
  }
  flow.cancel();
  await flow.result;
}

console.log("\n8. Oversized bodies are dropped");
{
  const flow = runLoginServer();
  const { port, state } = parse(await flow.url);
  let status = 0;
  try {
    const res = await post(port, { state, key: KEY, pad: "x".repeat(64 * 1024) });
    status = res.status;
  } catch {
    status = -1; // connection destroyed, which is also a refusal
  }
  check("not accepted as a success", status !== 200, `(got ${status})`);
  flow.cancel();
  await flow.result;
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
