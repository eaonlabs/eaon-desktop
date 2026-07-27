// The agent loop — orchestrates one user turn through to a clean end:
// stream a reply, resolve tool calls (native tool_calls first, the text
// fence as fallback), gate non-read-only calls behind confirmation, execute,
// feed results back, repeat. An async generator so the TUI can render every
// token live AND pause mid-loop for a permission decision: yielding a
// "permission_request" event suspends the generator until the caller
// resumes it with `.next(answer)`, no callback plumbing needed.
//
// Ported behaviors from ChatViewModel.swift's executeAgentTools /
// streamOneAgentStep: a thinking-only reply (all reasoning, nothing after)
// is bounced back with a corrective nudge instead of silently ending the
// turn; three identical failures in a row (not three failures total —
// three of the SAME failure) stop the loop instead of grinding forever; a
// tool result that's itself an error (e.g. "no such file") is normal
// operation, not a failure-signature case — only protocol-level failures
// (malformed JSON, an unknown tool name, thinking-only) count.

import type { ChatStreamEvent, EaonConfig, EaonMode, ModelEntry, PermissionMode, ToolCallRequest, Turn } from "../types.js";
import { streamChat } from "../providers/chat.js";
import { endpointFor } from "../providers/registry.js";
import {
  confirmationDetail, confirmationSummary, executeTool, isReadOnlyTool, resolveToolName,
  toolAliasNames, toolDefinitions, toolsForMode, type ToolName,
} from "../tools/index.js";
import type { PathGuardContext } from "../tools/pathGuard.js";
import { slimHistoryForRequest } from "./context.js";
import { subagentSystemPrompt } from "./prompts.js";
import { isThinkingOnlyReply, parseFenceToolCalls, stripCompletedThinkSpans } from "./fenceParser.js";

export type PermissionAnswer = "approve" | "deny" | "always_this_tool";

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "content_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "turn_end" }
  | { type: "tool_call_requested"; callId: string; name: ToolName; args: Record<string, unknown>; summary: string; detail?: string; readOnly: boolean }
  | { type: "permission_request"; name: ToolName; summary: string; detail?: string }
  | { type: "tool_result"; callId: string; name: ToolName; isError: boolean; text: string }
  /** Plan mode: the model finished researching and wants approval to act.
   * The caller resumes with "approve" (leave plan mode and carry it out)
   * or "deny" (stay in plan mode and keep refining). */
  | { type: "plan_proposed"; plan: string }
  /** A `task` sub-agent started / finished — lets the UI show nested work
   * rather than the parent turn appearing to hang. */
  | { type: "subagent_start"; description: string }
  | { type: "subagent_end"; description: string; steps: number }
  | { type: "step_error"; message: string }
  | { type: "loop_stopped"; reason: string }
  | { type: "done" };

export interface AgentLoopState {
  mode: EaonMode;
  permissionMode: PermissionMode;
  model: ModelEntry;
  config: EaonConfig;
  pathCtx: PathGuardContext;
  turns: Turn[];
  alwaysAllow: Set<string>;
}

export interface AgentLoopOptions {
  maxSteps?: number;
  signal?: AbortSignal;
  /** Snapshot hook for /rewind — called with (absolutePathish, label)
   * immediately before a tool changes a file. */
  onBeforeFileChange?: (filePath: string, label: string) => void;
  /** Set when this loop IS a sub-agent: no nesting, no permission prompts
   * (the parent turn was already approved), tighter step budget. */
  isSubagent?: boolean;
}

const DEFAULT_MAX_STEPS = 40;
/** Sub-agents get a smaller budget than the top-level turn: enough to do a
 * real scoped job, not enough for a runaway to burn the whole session. */
const SUBAGENT_MAX_STEPS = 20;

/** How many times a transient provider failure (429 / 5xx / can't-reach)
 * is retried before the turn gives up. Only fires when NOTHING has
 * streamed yet — a mid-reply failure never retries, since that would
 * duplicate the partial content. */
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = [1000, 3000];

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function isTransientError(message: string, status: number | undefined): boolean {
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  return /^Couldn't reach/.test(message);
}

function accumulateArguments(map: Map<number, { id: string; name: string; args: string }>, event: ChatStreamEvent): void {
  if (event.type === "tool_call_start") {
    map.set(event.index, { id: event.id, name: event.name, args: "" });
  } else if (event.type === "tool_call_delta") {
    const entry = map.get(event.index);
    if (entry) entry.args += event.argumentsFragment;
  }
}

export async function* runAgentTurn(state: AgentLoopState, opts: AgentLoopOptions = {}): AsyncGenerator<AgentEvent, void, PermissionAnswer | undefined> {
  const maxSteps = opts.maxSteps ?? (opts.isSubagent ? SUBAGENT_MAX_STEPS : DEFAULT_MAX_STEPS);
  const toolNames = toolsForMode(state.mode, { isSubagent: opts.isSubagent, permissionMode: state.permissionMode });
  const toolDefs = toolNames.length > 0 ? toolDefinitions(toolNames) : undefined;
  // Chat mode now carries read-only tools too (see chatTools), so this is
  // driven by whether the mode actually HAS tools rather than by its name.
  const wantsTools = !!toolDefs && toolDefs.length > 0;

  let lastFailureSignature: string | null = null;
  let failureStreak = 0;

  const registerFailure = (signature: string): boolean => {
    if (signature === lastFailureSignature) failureStreak++;
    else {
      lastFailureSignature = signature;
      failureStreak = 1;
    }
    return failureStreak >= 3;
  };
  const clearFailure = () => {
    lastFailureSignature = null;
    failureStreak = 0;
  };

  for (let step = 0; step < maxSteps; step++) {
    yield { type: "turn_start" };

    const { baseUrl, apiKey, format } = endpointFor(state.model, state.config);
    let content = "";
    let reasoning = "";
    const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();
    let errorMessage: string | null = null;
    let errorStatus: number | undefined;

    // One model reply, with two independent retry mechanisms:
    // - a 400 with tools attached (endpoint doesn't support the tools
    //   array) retries once immediately without tools — the text-fence
    //   fallback covers tool use from there;
    // - a transient failure (429 / 5xx / can't-reach) retries with backoff
    //   up to MAX_TRANSIENT_RETRIES, so one network blip doesn't kill a
    //   whole multi-step run.
    // Both only ever fire when nothing has streamed yet.
    let sendTools = wantsTools && format === "openAICompatible";
    let toollessRetryUsed = false;
    let transientRetriesUsed = 0;

    while (true) {
      content = "";
      reasoning = "";
      toolCallAcc.clear();
      errorMessage = null;
      errorStatus = undefined;

      const stream = streamChat({
        baseUrl, apiKey, model: state.model.requestId,
        turns: slimHistoryForRequest(state.turns),
        tools: sendTools ? toolDefs : undefined,
        signal: opts.signal,
        format,
      });

      for await (const ev of stream) {
        if (ev.type === "token") {
          content += ev.text;
          yield { type: "content_delta", text: ev.text };
        } else if (ev.type === "reasoning") {
          reasoning += ev.text;
          yield { type: "reasoning_delta", text: ev.text };
        } else if (ev.type === "tool_call_start" || ev.type === "tool_call_delta") {
          accumulateArguments(toolCallAcc, ev);
        } else if (ev.type === "error") {
          errorMessage = ev.message;
          errorStatus = ev.status;
        }
      }

      const nothingStreamedYet = content.length === 0 && reasoning.length === 0 && toolCallAcc.size === 0;
      if (!errorMessage || !nothingStreamedYet || opts.signal?.aborted) break;

      if (errorStatus === 400 && sendTools && !toollessRetryUsed) {
        toollessRetryUsed = true;
        sendTools = false;
        continue;
      }
      if (isTransientError(errorMessage, errorStatus) && transientRetriesUsed < MAX_TRANSIENT_RETRIES) {
        const delay = TRANSIENT_BACKOFF_MS[transientRetriesUsed] ?? 3000;
        transientRetriesUsed++;
        // Keep retry notices short — repeating the full HTTP body on every
        // attempt flooded the transcript (and stressed Ink's Static redraw).
        yield {
          type: "step_error",
          message: `Retrying in ${delay / 1000}s (${transientRetriesUsed}/${MAX_TRANSIENT_RETRIES})…`,
        };
        await abortableSleep(delay, opts.signal);
        if (opts.signal?.aborted) break;
        continue;
      }
      break;
    }

    if (errorMessage) {
      yield { type: "step_error", message: errorMessage };
      // loop_stopped still fires for callers that key off it, but App skips
      // pushing the same string twice (see step_error / loop_stopped handlers).
      yield { type: "loop_stopped", reason: errorMessage };
      return;
    }

    yield { type: "turn_end" };

    let toolCalls: ToolCallRequest[] = [...toolCallAcc.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args }));
    let historyContent = content;

    // Fence fallback applies wherever tools exist — chat mode included, so
    // a local model without native tool-calling can still read a file to
    // answer a question about it.
    if (toolCalls.length === 0 && toolNames.length > 0) {
      const strippedForScan = stripCompletedThinkSpans(content);
      const fenceResult = parseFenceToolCalls(strippedForScan, toolNames, toolAliasNames());
      if (fenceResult.calls.length > 0) {
        toolCalls = fenceResult.calls.map((c, i) => ({ id: `fence_${step}_${i}`, name: c.name, arguments: c.argumentsRaw }));
        historyContent = fenceResult.cleanedContent;
      }
    }
    historyContent = stripCompletedThinkSpans(historyContent).trim();

    if (toolCalls.length === 0) {
      if (isThinkingOnlyReply(content)) {
        const stop = registerFailure("thinking-only-turn");
        state.turns.push({ role: "assistant", content: historyContent });
        state.turns.push({
          role: "user",
          content: "ERROR: your reply was only internal thinking, with nothing after it. After reasoning, you must ALWAYS either call a tool or answer in plain language — act now.",
        });
        yield { type: "step_error", message: "reply was thinking-only — nudged to act" };
        if (stop) {
          yield { type: "loop_stopped", reason: "The model produced only internal thinking three times in a row." };
          return;
        }
        continue;
      }
      clearFailure();
      state.turns.push({ role: "assistant", content: historyContent });
      yield { type: "done" };
      return;
    }

    state.turns.push({ role: "assistant", content: historyContent, toolCalls });

    for (const call of toolCalls) {
      let args: Record<string, unknown>;
      try {
        const trimmed = call.arguments.trim();
        args = trimmed.length > 0 ? JSON.parse(trimmed) : {};
      } catch {
        const stop = registerFailure(`bad-json:${call.name}`);
        state.turns.push({
          role: "tool", toolCallId: call.id, name: call.name, isError: true,
          content: `ERROR: the arguments for ${call.name} weren't valid JSON. Re-emit the call with a single valid JSON object and nothing else in it.`,
        });
        yield { type: "step_error", message: `couldn't parse arguments for ${call.name}` };
        if (stop) {
          yield { type: "loop_stopped", reason: `Repeated malformed "${call.name}" calls.` };
          return;
        }
        continue;
      }

      // Canonicalize the name — exact match or a known alias ("write" →
      // write_file, "bash" → run_shell…). Rescuing a slip here saves a
      // whole corrective model round-trip, which on a local model is
      // seconds per slip. The canonical name must also actually be in this
      // mode/platform's tool set (run_applescript off macOS isn't).
      const canonical = resolveToolName(call.name);
      if (!canonical || !toolNames.includes(canonical)) {
        const stop = registerFailure(`unknown-tool:${call.name}`);
        state.turns.push({
          role: "tool", toolCallId: call.id, name: call.name, isError: true,
          content: `ERROR: "${call.name}" isn't one of your tools. Your tools are exactly: ${toolNames.join(", ")}.`,
        });
        yield { type: "step_error", message: `unknown tool "${call.name}"` };
        if (stop) {
          yield { type: "loop_stopped", reason: `Repeated calls to the unknown tool "${call.name}".` };
          return;
        }
        continue;
      }

      // ---- Plan mode ----------------------------------------------------
      // exit_plan_mode is the one way out: suspend, show the plan, and let
      // the caller approve. Approving flips this loop's own permissionMode
      // so the SAME turn continues straight into doing the work — the user
      // approves once and the agent carries on, rather than having to
      // re-ask for the thing they just approved.
      if (canonical === "exit_plan_mode") {
        const plan = typeof args.plan === "string" ? args.plan.trim() : "";
        if (state.permissionMode !== "plan") {
          state.turns.push({
            role: "tool", toolCallId: call.id, name: canonical, isError: true,
            content: "You're not in plan mode, so there's no plan to approve — just do the work.",
          });
          yield { type: "tool_result", callId: call.id, name: canonical, isError: true, text: "Not in plan mode." };
          continue;
        }
        if (plan.length === 0) {
          state.turns.push({
            role: "tool", toolCallId: call.id, name: canonical, isError: true,
            content: 'ERROR: "plan" was empty. Call exit_plan_mode again with the actual plan.',
          });
          yield { type: "tool_result", callId: call.id, name: canonical, isError: true, text: "Empty plan." };
          continue;
        }
        const decision = yield { type: "plan_proposed", plan };
        if (decision === "approve") {
          state.permissionMode = "auto";
          state.turns.push({
            role: "tool", toolCallId: call.id, name: canonical, isError: false,
            content: "The user APPROVED your plan and you have left plan mode. Your tools now work. Carry the plan out now, in this same turn — start with the first step. Do not re-state the plan or ask whether to begin.",
          });
          yield { type: "tool_result", callId: call.id, name: canonical, isError: false, text: "Plan approved — continuing." };
        } else {
          state.turns.push({
            role: "tool", toolCallId: call.id, name: canonical, isError: true,
            content: "The user did NOT approve that plan. You are still in plan mode and your mutating tools are still refused. Ask what they'd like changed, or investigate further and propose a revised plan.",
          });
          yield { type: "tool_result", callId: call.id, name: canonical, isError: true, text: "Plan rejected — still in plan mode." };
        }
        clearFailure();
        continue;
      }

      const summary = confirmationSummary(canonical, args);
      const detail = confirmationDetail(canonical, args);
      const readOnly = isReadOnlyTool(canonical);

      // In plan mode every mutating tool is refused outright — no prompt,
      // because the whole point is that nothing changes until there's an
      // approved plan. `task` is the one exception: it's gated in sandboxed
      // mode (a sub-agent can write), but here the sub-agent inherits plan
      // mode too, so delegating research is both safe and genuinely useful
      // for building a well-grounded plan.
      if (state.permissionMode === "plan" && !readOnly && canonical !== "task") {
        state.turns.push({
          role: "tool", toolCallId: call.id, name: canonical, isError: true,
          content: `REFUSED: ${canonical} changes things, and you're in plan mode where nothing may change yet. Keep researching with your read-only tools (grep, glob, read_file, web_search, web_fetch, task), then call exit_plan_mode with a concrete plan to get approval.`,
        });
        yield { type: "tool_call_requested", callId: call.id, name: canonical, args, summary, detail, readOnly };
        yield { type: "tool_result", callId: call.id, name: canonical, isError: true, text: "Refused — plan mode is read-only until your plan is approved." };
        clearFailure();
        continue;
      }

      yield { type: "tool_call_requested", callId: call.id, name: canonical, args, summary, detail, readOnly };

      const needsConfirmation = !readOnly && state.permissionMode === "sandboxed" && !opts.isSubagent && !state.alwaysAllow.has(canonical);
      if (needsConfirmation) {
        const answer = yield { type: "permission_request", name: canonical, summary, detail };
        if (answer === "deny") {
          state.turns.push({
            role: "tool", toolCallId: call.id, name: canonical, isError: true,
            content: "Denied by the user. Do not retry this exact action — ask what they'd like instead if it's relevant.",
          });
          clearFailure();
          yield { type: "tool_result", callId: call.id, name: canonical, isError: true, text: "Denied by the user." };
          continue;
        }
        if (answer === "always_this_tool") state.alwaysAllow.add(canonical);
      }

      // A `task` call runs a whole nested agent loop. It's surfaced as
      // start/end events so the UI can show the sub-agent working instead
      // of the parent turn appearing to hang on one long tool call.
      if (canonical === "task") {
        const description = typeof args.description === "string" ? args.description.trim() : "subtask";
        yield { type: "subagent_start", description };
      }

      const result = await executeTool(canonical, args, {
        ...state.pathCtx,
        onBeforeFileChange: opts.onBeforeFileChange,
        // No nesting: a sub-agent can't spawn sub-agents. One level keeps
        // the cost and the failure modes comprehensible.
        runSubagent: opts.isSubagent ? undefined : (prompt, description) => runSubagentTask(state, prompt, description, opts),
      });

      if (canonical === "task") {
        const description = typeof args.description === "string" ? args.description.trim() : "subtask";
        yield { type: "subagent_end", description, steps: 0 };
      }
      clearFailure();
      yield { type: "tool_result", callId: call.id, name: canonical, isError: result.isError, text: result.text };
      state.turns.push({ role: "tool", toolCallId: call.id, name: canonical, content: result.text, isError: result.isError });
    }
  }

  yield { type: "loop_stopped", reason: `Reached the ${maxSteps}-step limit for this turn.` };
}

/** Runs one `task` delegation to completion and returns its written report.
 *
 * The sub-agent gets a FRESH conversation — it deliberately cannot see the
 * parent's history, which is the entire point: the parent spends a few
 * hundred tokens describing the job instead of dragging its whole context
 * along, and gets back a summary instead of a transcript. It inherits the
 * same model, tools and project root, runs unattended (the parent turn was
 * already approved), and its file changes still flow through the parent's
 * checkpoint hook so /rewind covers them too. */
async function runSubagentTask(
  parent: AgentLoopState,
  prompt: string,
  description: string,
  parentOpts: AgentLoopOptions
): Promise<string> {
  const subState: AgentLoopState = {
    mode: parent.mode,
    // Sub-agents never prompt (there's no sensible way to attribute a
    // confirmation to a nested turn), so they only run at all in a mode
    // where the parent has already accepted unattended execution. In
    // sandboxed mode they still run read-only-ish work fine; anything
    // mutating is the parent's job to confirm.
    permissionMode: parent.permissionMode === "plan" ? "plan" : parent.permissionMode,
    model: parent.model,
    config: parent.config,
    pathCtx: parent.pathCtx,
    turns: [
      { role: "system", content: subagentSystemPrompt(parent.pathCtx.projectRoot, description) },
      { role: "user", content: prompt },
    ],
    alwaysAllow: parent.alwaysAllow,
  };

  const gen = runAgentTurn(subState, {
    signal: parentOpts.signal,
    onBeforeFileChange: parentOpts.onBeforeFileChange,
    isSubagent: true,
  });

  let steps = 0;
  let stoppedReason: string | null = null;
  // Drive it to completion, discarding the streaming events — only the
  // final written report matters to the parent. Auto-approve is implicit:
  // permission_request never fires for a sub-agent (see needsConfirmation).
  for (;;) {
    const { value, done } = await gen.next(undefined);
    if (done) break;
    if (value.type === "tool_call_requested") steps++;
    if (value.type === "loop_stopped") stoppedReason = value.reason;
  }

  const finalText = [...subState.turns]
    .reverse()
    .find((t) => t.role === "assistant" && t.content.trim().length > 0)?.content.trim();

  if (!finalText) {
    return `The "${description}" sub-agent finished without producing a report${stoppedReason ? ` (${stoppedReason})` : ""}. Do this part yourself, or retry with a more specific instruction.`;
  }
  const note = stoppedReason ? `\n\n[sub-agent stopped early: ${stoppedReason}]` : "";
  return `Report from the "${description}" sub-agent (${steps} tool call${steps === 1 ? "" : "s"}):\n\n${finalText}${note}`;
}
