// The key-separation rules.
//
// This is the bug the account panel actually hit: `aquaApiKey` was one field
// serving two unrelated services, so a perfectly good *hosted* key made the
// account views report "the configured key isn't one", and /login would have
// overwritten that hosted key on its way past.
//
// The rules being pinned here are the ones that were wrong before:
//   - a hosted key never satisfies the account routes
//   - a hosted key still serves chat after signing in
//   - an account key alone serves both
//   - an account key pasted into the legacy field still counts

import { resolveAccountKey, resolveAquaApiKey } from "../src/config.js";
import type { EaonConfig } from "../src/types.js";

const BASE: EaonConfig = {
  aquaApiKey: "",
  eaonAccountKey: "",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  customProviders: [],
  selectedModelKey: null,
  permissionMode: "sandboxed",
  defaultMode: "agent",
  customInstructions: "",
};

const HOSTED = "aqua-hosted-key-0000000000";
const ACCOUNT = "sk-eaon-1111222233334444555566667777";

// These functions read process.env first, and this machine may well have one set.
for (const name of ["EAON_AQUA_API_KEY", "EAON_ACCOUNT_KEY"]) delete process.env[name];

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label} -> ${JSON.stringify(actual)}${ok ? "" : ` (want ${JSON.stringify(expected)})`}`);
}

const cfg = (over: Partial<EaonConfig>): EaonConfig => ({ ...BASE, ...over });

console.log("\n1. Nothing configured");
check("no chat key", resolveAquaApiKey(cfg({})), "");
check("no account key", resolveAccountKey(cfg({})), "");

console.log("\n2. Hosted key only — the state that produced the bug");
check("serves chat", resolveAquaApiKey(cfg({ aquaApiKey: HOSTED })), HOSTED);
check("does NOT satisfy the account routes", resolveAccountKey(cfg({ aquaApiKey: HOSTED })), "");

console.log("\n3. Account key only (a fresh /login)");
check("serves the account routes", resolveAccountKey(cfg({ eaonAccountKey: ACCOUNT })), ACCOUNT);
check("also serves chat, so a fresh install works", resolveAquaApiKey(cfg({ eaonAccountKey: ACCOUNT })), ACCOUNT);

console.log("\n4. Both — signing in must not re-route existing models");
const both = cfg({ aquaApiKey: HOSTED, eaonAccountKey: ACCOUNT });
check("chat still uses the hosted key", resolveAquaApiKey(both), HOSTED);
check("account routes use the account key", resolveAccountKey(both), ACCOUNT);

console.log("\n5. An account key in the legacy field (pasted before the split)");
check("still counts for the account routes", resolveAccountKey(cfg({ aquaApiKey: ACCOUNT })), ACCOUNT);
check("and for chat", resolveAquaApiKey(cfg({ aquaApiKey: ACCOUNT })), ACCOUNT);

console.log("\n6. Env overrides");
process.env.EAON_ACCOUNT_KEY = "sk-eaon-fromenv0000000000000000000000";
check("EAON_ACCOUNT_KEY wins", resolveAccountKey(cfg({ eaonAccountKey: ACCOUNT })), "sk-eaon-fromenv0000000000000000000000");
delete process.env.EAON_ACCOUNT_KEY;
process.env.EAON_AQUA_API_KEY = "env-hosted";
check("EAON_AQUA_API_KEY wins for chat", resolveAquaApiKey(cfg({ aquaApiKey: HOSTED })), "env-hosted");
delete process.env.EAON_AQUA_API_KEY;

console.log("\n7. Case and whitespace are not a way past the prefix check");
check("uppercase prefix accepted", resolveAccountKey(cfg({ aquaApiKey: "SK-EAON-AAAABBBBCCCCDDDD" })), "SK-EAON-AAAABBBBCCCCDDDD");
check("leading space tolerated", resolveAccountKey(cfg({ aquaApiKey: `  ${ACCOUNT}` })), `  ${ACCOUNT}`);
check("a lookalike is refused", resolveAccountKey(cfg({ aquaApiKey: "sk-eaonx-nope" })), "");

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
