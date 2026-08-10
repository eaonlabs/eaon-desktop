#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { appendRequestLog } from "./session/requestLog.js";
import { configDir } from "./platform.js";
import { buildCatalog, describeEntry, findModel } from "./providers/registry.js";
import { runAgentTurn, type AgentLoopState, type PermissionAnswer } from "./agent/loop.js";
import { systemPromptFor } from "./agent/prompts.js";
import { readProjectNotes } from "./project/init.js";
import type { EaonMode, Turn } from "./types.js";
import type { PathGuardContext } from "./tools/pathGuard.js";
import { App } from "./ui/App.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Last-resort safety net. Node's default behavior for BOTH of these is to
 * kill the whole process — fine for a one-shot script, fatal for an
 * interactive TUI that might be holding an unsaved conversation. Every
 * specific throw site worth handling locally is handled locally (see
 * App.tsx); this is only for whatever isn't — which, with zero coverage
 * before this, was apparently a lot ("it keeps crashing"). Logged to disk
 * (best-effort) instead of silently swallowed, so a recurring one is still
 * debuggable after the fact. */
function logCrash(kind: string, err: unknown): void {
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(path.join(dir, "crash.log"), `[${new Date().toISOString()}] ${kind}\n${detail}\n\n`, "utf8");
  } catch {
    // logging the crash can't itself be allowed to crash anything
  }
}
process.on("uncaughtException", (err) => {
  logCrash("uncaughtException", err);
  process.stderr.write(`\n[eaon] recovered from an unexpected error — see ${path.join(configDir(), "crash.log")} for detail\n`);
});
process.on("unhandledRejection", (reason) => {
  logCrash("unhandledRejection", reason);
  process.stderr.write(`\n[eaon] recovered from an unexpected error — see ${path.join(configDir(), "crash.log")} for detail\n`);
});

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();
program
  .name("eaon")
  .description("Eaon in your terminal — one agent for coding, for any model.")
  .version(readVersion(), "-v, --version")
  .option("-p, --print <prompt>", "run one prompt non-interactively and print the result, then exit")
  .option("-m, --mode <mode>", "legacy: always agent (chat is folded in)", "agent")
  .option("--model <key>", "model key to start with, e.g. ollama:qwen3.6 (default: last used)")
  .option("--auto", "start in Auto permission mode (skips confirmation prompts) — use with care", false)
  .option("--cwd <path>", "project root (default: current directory)", process.cwd())
  .option("--max-steps <n>", "cap on agent tool-call steps per turn", (v) => parseInt(v, 10), 40)
  .option("-c, --continue", "resume the most recent session in this project", false)
  .option("-r, --resume <id>", "resume a specific session by id (see /resume for the list)")
  .option("--permission-mode <mode>", "start in plan, sandboxed, or auto")
  .option("--welcome", "force-show the first-run welcome/log-in screen even if already configured (for previewing it)", false);

program.parse(process.argv);
const opts = program.opts<{
  print?: string; mode: string; model?: string; auto: boolean; cwd: string; maxSteps: number;
  welcome: boolean; continue: boolean; resume?: string; permissionMode?: string;
}>();

function resolveStartPermission(): "plan" | "sandboxed" | "auto" {
  const raw = (opts.permissionMode ?? "").trim().toLowerCase();
  if (raw.startsWith("plan")) return "plan";
  if (raw.startsWith("auto")) return "auto";
  if (raw.startsWith("sand")) return "sandboxed";
  // --auto is the older spelling of the same intent; keep it working.
  return opts.auto ? "auto" : "sandboxed";
}

const projectRoot = path.resolve(opts.cwd);
// One Agent — chat/claw are legacy aliases that all become agent.
const mode = "agent" as EaonMode;
void opts.mode;

if (opts.print) {
  runOneShot(opts.print, mode, opts.model ?? null, projectRoot, opts.auto, opts.maxSteps)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
} else if (!process.stdin.isTTY) {
  // Ink's useInput unconditionally calls setRawMode(true); when stdin isn't
  // a real TTY (piped input, or a pty that doesn't expose raw mode — e.g. a
  // gap in how an embedding terminal spawns this process), that throws with
  // no error boundary anywhere in this tree, killing the process instantly
  // with a cryptic stack instead of a message anyone could act on. Fail
  // clearly instead.
  process.stderr.write("Eaon needs an interactive terminal (stdin isn't a TTY here).\nFor non-interactive/scripted use, run with -p \"<prompt>\" instead.\n");
  process.exitCode = 1;
} else {
  render(
    <App
      version={readVersion()}
      initialMode={mode}
      initialModelKey={opts.model ?? null}
      projectRoot={projectRoot}
      startInAuto={opts.auto}
      startPermissionMode={resolveStartPermission()}
      resumeSessionId={opts.resume}
      continueLatest={opts.continue}
      forceWelcome={opts.welcome}
    />,
    { exitOnCtrlC: false }
  );
}

/** Non-interactive path: no TUI, no terminal to ask for permission — so
 * --print requires --auto up front rather than silently hanging on a
 * confirmation that can never arrive. Also doubles as a scriptable way to
 * drive Eaon from CI or a shell pipeline. */
async function runOneShot(promptText: string, mode: EaonMode, modelKey: string | null, projectRoot: string, auto: boolean, maxSteps: number): Promise<number> {
  if (!auto) {
    process.stderr.write("--print needs --auto too — there's no terminal here to confirm actions interactively.\n");
    return 1;
  }

  const config = loadConfig();
  const { models, aquaError } = await buildCatalog(config);
  let model = modelKey ? findModel(models, modelKey) : undefined;
  if (!model && !modelKey) model = config.selectedModelKey ? findModel(models, config.selectedModelKey) : models[0];
  if (!model) {
    process.stderr.write(`No matching model available.${aquaError ? ` (Aqua: ${aquaError})` : ""} Configure a provider or run Ollama locally.\n`);
    return 1;
  }

  const notes = readProjectNotes(projectRoot);
  const extra = [config.customInstructions, notes].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n---\n\n");
  const permissionMode = auto ? "auto" : "sandboxed";
  const systemContent = systemPromptFor(mode, projectRoot, permissionMode, extra);
  const turns: Turn[] = [
    { role: "system", content: systemContent },
    { role: "user", content: promptText },
  ];

  process.stderr.write(`[${describeEntry(model)} · agent · ${permissionMode}]\n`);
  void mode;

  const loopState: AgentLoopState = {
    mode, permissionMode, model, config,
    pathCtx: { projectRoot } as PathGuardContext,
    turns, alwaysAllow: new Set(),
  };

  const gen = runAgentTurn(loopState, { maxSteps });
  let sendValue: PermissionAnswer | undefined;
  let sawError = false;
  const startedAt = Date.now();

  while (true) {
    const { value: event, done } = await gen.next(sendValue);
    sendValue = undefined;
    if (done) break;

    if (event.type === "content_delta") {
      process.stdout.write(event.text);
    } else if (event.type === "tool_call_requested") {
      process.stderr.write(`\n▸ ${event.summary}\n`);
    } else if (event.type === "permission_request") {
      // Only reachable if a future caller runs sandboxed non-interactively —
      // approve is the least-surprising default since --print requires --auto.
      sendValue = "approve";
    } else if (event.type === "tool_result") {
      process.stderr.write(event.isError ? `  ✗ ${event.text.split("\n")[0]}\n` : `  ✓ done\n`);
    } else if (event.type === "step_error") {
      process.stderr.write(`  ! ${event.message}\n`);
    } else if (event.type === "loop_stopped") {
      process.stderr.write(`\n[stopped: ${event.reason}]\n`);
      sawError = true;
    }
  }
  process.stdout.write("\n");

  // --print runs outside the Ink app, so it has to record its own row or these
  // requests would be missing from /logs — which claims to list every request
  // made from this machine.
  appendRequestLog({
    model: model.key,
    ok: !sawError,
    latencyMs: Date.now() - startedAt,
    tokens: null,
  });

  return sawError ? 1 : 0;
}
