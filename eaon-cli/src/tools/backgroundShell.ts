// Long-running commands. run_shell is capped at 2 minutes and returns only
// when the process exits, which makes a whole class of real work impossible:
// starting a dev server, tailing a build, running a long test suite. Those
// go here instead — spawned detached from the turn, output buffered, and
// polled with check_shell / stopped with stop_shell.
//
// Every job is killed on process exit (see killAllBackgroundJobs, wired into
// the CLI's shutdown path) so a session can never leave orphaned servers
// running on the user's machine.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "../types.js";
import { extraPathEntries, shellInvocation } from "../platform.js";
import { mentionsSudo } from "./shellTool.js";
import { normalizePath, type PathGuardContext } from "./pathGuard.js";

/** Per-job output cap. Generous (a dev server logs a lot) but bounded so a
 * chatty process can't grow the buffer without limit for a whole session. */
const MAX_BUFFER_CHARS = 200_000;
/** How much of the buffer a single check_shell returns. */
const MAX_READ_CHARS = 8_000;

interface BackgroundJob {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  /** Offset already returned by check_shell — lets each poll show only
   * what's new, which is what makes tailing a log actually usable. */
  readOffset: number;
  exitCode: number | null;
  finished: boolean;
  startedAt: number;
  truncated: boolean;
}

const jobs = new Map<string, BackgroundJob>();
let counter = 0;

function nextId(): string {
  counter += 1;
  return `bg_${counter}`;
}

function append(job: BackgroundJob, chunk: string): void {
  job.output += chunk;
  if (job.output.length > MAX_BUFFER_CHARS) {
    const overflow = job.output.length - MAX_BUFFER_CHARS;
    job.output = job.output.slice(overflow);
    job.readOffset = Math.max(0, job.readOffset - overflow);
    job.truncated = true;
  }
}

export function startBackgroundShell(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  const commandRaw = args.command;
  if (typeof commandRaw !== "string" || commandRaw.trim().length === 0) {
    return { isError: true, text: 'ERROR: missing a non-empty "command".' };
  }
  const command = commandRaw.trim();
  if (mentionsSudo(command)) {
    return {
      isError: true,
      text: "Refused: this runs commands as you, never as root. Drop the sudo — if the task genuinely needs admin rights, ask the user to do it themselves.",
    };
  }

  let workingDirectory = ctx.projectRoot;
  const wdRaw = args.working_directory;
  if (typeof wdRaw === "string" && wdRaw.trim().length > 0) {
    const wd = normalizePath(wdRaw, ctx);
    if (!fs.existsSync(wd) || !fs.statSync(wd).isDirectory()) {
      return { isError: true, text: `ERROR: working_directory isn't a directory: ${wd}` };
    }
    workingDirectory = wd;
  }

  const { cmd, args: shellArgs } = shellInvocation(command);
  const env = { ...process.env };
  const extra = extraPathEntries();
  if (extra.length > 0) env.PATH = `${env.PATH ?? ""}${path.delimiter}${extra.join(path.delimiter)}`;

  let child: ChildProcess;
  try {
    child = spawn(cmd, shellArgs, { cwd: workingDirectory, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { isError: true, text: `ERROR: couldn't start the command: ${(e as Error).message}` };
  }

  const job: BackgroundJob = {
    id: nextId(),
    command,
    child,
    output: "",
    readOffset: 0,
    exitCode: null,
    finished: false,
    startedAt: Date.now(),
    truncated: false,
  };
  jobs.set(job.id, job);

  child.stdout?.on("data", (c) => append(job, c.toString("utf8")));
  child.stderr?.on("data", (c) => append(job, c.toString("utf8")));
  child.on("error", (e) => {
    append(job, `\n[process error: ${e.message}]\n`);
    job.finished = true;
    job.exitCode = -1;
  });
  child.on("close", (code) => {
    job.finished = true;
    job.exitCode = code ?? -1;
  });

  return {
    isError: false,
    text: `Started in the background as ${job.id}: ${command}\nIt keeps running while you work. Poll it with check_shell({"id": "${job.id}"}) and stop it with stop_shell({"id": "${job.id}"}).`,
  };
}

export function checkBackgroundShell(args: Record<string, unknown>): ToolResult {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id.length === 0) {
    const running = [...jobs.values()].filter((j) => !j.finished);
    if (running.length === 0) return { isError: false, text: "No background commands are running." };
    return {
      isError: false,
      text: ["Running background commands:", ...running.map((j) => `- ${j.id}: ${j.command}`)].join("\n"),
    };
  }
  const job = jobs.get(id);
  if (!job) return { isError: true, text: `ERROR: no background command with id "${id}".` };

  const fresh = job.output.slice(job.readOffset);
  job.readOffset = job.output.length;
  const shown = fresh.length > MAX_READ_CHARS ? fresh.slice(fresh.length - MAX_READ_CHARS) : fresh;

  const seconds = Math.floor((Date.now() - job.startedAt) / 1000);
  const status = job.finished ? `exited with code ${job.exitCode}` : `still running (${seconds}s)`;
  const header = `${job.id} — ${status}: ${job.command}`;
  const truncNote = job.truncated ? "\n(earlier output dropped — the buffer is capped)" : "";
  if (shown.length === 0) {
    return { isError: false, text: `${header}${truncNote}\n(no new output since the last check)` };
  }
  return { isError: false, text: `${header}${truncNote}\n\n${shown}` };
}

export function stopBackgroundShell(args: Record<string, unknown>): ToolResult {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id.length === 0) return { isError: true, text: 'ERROR: "id" is required.' };
  const job = jobs.get(id);
  if (!job) return { isError: true, text: `ERROR: no background command with id "${id}".` };
  if (job.finished) return { isError: false, text: `${job.id} had already exited with code ${job.exitCode}.` };
  try {
    job.child.kill("SIGTERM");
    // SIGTERM first (lets a dev server clean up), SIGKILL if it ignores it.
    setTimeout(() => {
      if (!job.finished) {
        try {
          job.child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 2000);
  } catch (e) {
    return { isError: true, text: `ERROR: couldn't stop ${job.id}: ${(e as Error).message}` };
  }
  return { isError: false, text: `Stopped ${job.id}: ${job.command}` };
}

/** Names of jobs still running — used by the UI's status line. */
export function runningJobCount(): number {
  return [...jobs.values()].filter((j) => !j.finished).length;
}

/** Kills everything still running. Wired into the CLI's exit path so a
 * session never leaves a dev server orphaned on the user's machine. */
export function killAllBackgroundJobs(): void {
  for (const job of jobs.values()) {
    if (job.finished) continue;
    try {
      job.child.kill("SIGKILL");
    } catch {
      // best effort — we're shutting down
    }
  }
  jobs.clear();
}

/** Test seam — clears state between runs without touching real processes. */
export function resetBackgroundJobsForTest(): void {
  jobs.clear();
  counter = 0;
}
