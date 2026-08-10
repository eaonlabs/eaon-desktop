import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import { randomUUID } from "node:crypto";
import open from "open";
import fs from "node:fs";
import path from "node:path";
import type { EaonMode, ModelEntry, PermissionMode, ToolCallRequest, Turn } from "../types.js";
import { configFile, loadConfig, resolveAquaApiKey, resolveOllamaBaseUrl, saveConfig } from "../config.js";
import { buildCatalog, describeEntry, findModel, providerLabelFor } from "../providers/registry.js";
import { endpointFor } from "../providers/registry.js";
import { streamChat } from "../providers/chat.js";
import { pullOllamaModel } from "../providers/ollama.js";
import { runAgentTurn, type AgentEvent, type AgentLoopState, type PermissionAnswer } from "../agent/loop.js";
import { systemPromptFor } from "../agent/prompts.js";
import { COMMANDS, parseSlashCommand } from "../commands/index.js";
import { confirmationDetail, confirmationSummary, isKnownTool } from "../tools/index.js";
import { currentTodos, resetTodos } from "../tools/todoTool.js";
import { resetKnownFiles } from "../tools/readTracker.js";
import { killAllBackgroundJobs, runningJobCount } from "../tools/backgroundShell.js";
import { clearCheckpoints, listCheckpoints, recordCheckpoint, restoreToCheckpoint } from "../session/checkpoints.js";
import { listProjectFiles } from "../tools/searchTools.js";
import { runShell } from "../tools/shellTool.js";
import type { PathGuardContext } from "../tools/pathGuard.js";
import { deriveTitle, listSessions, loadSession, newSession, saveSession, type Session } from "../session/store.js";
import { PROJECT_NOTES_FILE, readProjectNotes, runInit } from "../project/init.js";
import { applyConfigureToConfig, applyDiscoveryToConfig, discoverDesktopCredentials, domainLabel, isLocalDiscoveryAvailable } from "../link/localAuth.js";
import { runLinkServer } from "../link/server.js";
import { isMac, isWindows, platformLabel } from "../platform.js";
import { spawn } from "node:child_process";
import { checkForBundledUpdate, updateNoticeLine } from "../updateCheck.js";
import { Composer } from "./Composer.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { MessageView } from "./MessageView.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ModelPicker } from "./ModelPicker.js";
import { PlanReview } from "./PlanReview.js";
import { Palette, type PaletteRow } from "./Palette.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { AccountView, type AccountTab } from "./AccountView.js";
import { Splash } from "./Splash.js";
import { Footer, Hints } from "./Footer.js";
import { THEME_NAMES } from "./themes.js";
import { activeThemeName, applyTheme, subscribeTheme } from "./theme.js";
import { checkForUpdate, performUpdate, type UpdateAvailability } from "../update/updater.js";
import { appendRequestLog, loadRequestLog, type RequestLogEntry } from "../session/requestLog.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import { theme, MODE_LABEL, PERMISSION_COLORS } from "./theme.js";
import os from "node:os";
import { isUnsafeProjectRoot, unsafeRootReason } from "../project/rootGuard.js";
import { pickRandomQuote } from "./quotes.js";
import type { DisplayMessage, LinkOutcome } from "./types.js";

export interface AppProps {
  version: string;
  initialMode: EaonMode;
  initialModelKey: string | null;
  projectRoot: string;
  startInAuto: boolean;
  /** --permission-mode: which tier to open in (plan/sandboxed/auto). */
  startPermissionMode?: PermissionMode;
  /** -r/--resume: open this saved session instead of a fresh one. */
  resumeSessionId?: string;
  /** -c/--continue: open the most recent session for this project. */
  continueLatest?: boolean;
  /** --welcome: force the first-run screen even if already configured. */
  forceWelcome?: boolean;
}

function turnsToDisplayMessages(turns: Turn[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const t of turns) {
    if (t.role === "system") continue;
    if (t.role === "user") {
      out.push({ id: randomUUID(), role: "user", text: t.content });
      continue;
    }
    if (t.role === "assistant") {
      if (t.content.trim().length > 0) {
        out.push({ id: randomUUID(), role: "assistant", text: t.content, reasoning: "", streaming: false });
      }
      for (const call of t.toolCalls ?? []) {
        out.push(...displayForToolCall(call, turns));
      }
    }
  }
  return out;
}

function displayForToolCall(call: ToolCallRequest, turns: Turn[]): DisplayMessage[] {
  let args: Record<string, unknown> = {};
  try {
    args = call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {};
  } catch {
    // fall through with empty args — resumed display degrades gracefully
  }
  const toolName = call.name;
  const summary = isKnownTool(toolName) ? confirmationSummary(toolName, args) : toolName;
  const detail = isKnownTool(toolName) ? confirmationDetail(toolName, args) : undefined;
  const resultTurn = turns.find((rt) => rt.role === "tool" && rt.toolCallId === call.id);
  return [
    {
      id: randomUUID(),
      role: "tool",
      name: call.name,
      summary,
      detail,
      args,
      pending: !resultTurn,
      callId: call.id,
      result: resultTurn ? { isError: resultTurn.isError === true, text: resultTurn.content } : undefined,
    },
  ];
}

function resolveModelQuery(catalog: ModelEntry[], query: string): ModelEntry[] {
  const lower = query.toLowerCase();
  const exact = catalog.filter((m) => m.key.toLowerCase() === lower || m.requestId.toLowerCase() === lower);
  if (exact.length > 0) return exact;
  return catalog.filter(
    (m) => m.key.toLowerCase().includes(lower) || m.display.toLowerCase().includes(lower) || m.requestId.toLowerCase().includes(lower)
  );
}

function formatCatalog(catalog: ModelEntry[], current: ModelEntry | null): string {
  if (catalog.length === 0) {
    return "No models available yet.\n\n- Cloud: run /link to import from Eaon Desktop or set API keys in the browser\n- Local: install Ollama (ollama.com) and pull a model, e.g. /pull qwen3.6\n- Eaon: or set EAON_AQUA_API_KEY directly\n- BYOK: /link → Set / edit keys (pick OpenAI, Anthropic, Groq, …)";
  }
  const lines = catalog.map((m) => `${m.key === current?.key ? "› " : "  "}${m.key}  —  ${describeEntry(m)}`);
  return ["Available models:", ...lines, "", "Switch with /model <name>."].join("\n");
}

function buildHelpMarkdown(): string {
  const rows = COMMANDS.map((c) => `- **/${c.name}**${c.usage ? ` ${c.usage.replace(`/${c.name}`, "").trim()}` : ""} — ${c.description}`);
  return [
    "## Eaon CLI — Help",
    "",
    "One agent. Permission modes (plan / sandboxed / auto) control how much it can do alone.",
    "",
    "### Commands",
    ...rows,
    "",
    "### Input",
    "- **!**`command` — run a shell command directly and add its output to the conversation",
    "- **@**`path` — reference a file (autocompletes); its contents are sent to the model with your message",
    "- **#**`note` — save a note to this project's EAON.md memory",
    "- **/**`name` — a slash command (autocompletes)",
    "",
    "### How much it can do on its own",
    "Press **Shift+Tab** to cycle:",
    "- **Plan** — researches and proposes a plan; changes nothing until you approve it. Best way to start something big.",
    "- **Sandboxed** — asks before every change.",
    "- **Auto** — runs unattended.",
    "",
    "### Keyboard",
    "- **Shift+Tab** — cycle plan / sandboxed / auto",
    "- **Esc** — interrupt the current turn",
    "- **Enter while it's working** — queue a message for when it finishes (doesn't interrupt)",
    "- **Tab** — accept the highlighted autocomplete suggestion",
    "- **Up / Down** — command history (or move within a picker/suggestions)",
    "- **Ctrl+A / Ctrl+E** — start / end of line · **Alt+B / Alt+F** — move by word",
    "- **Ctrl+U / Ctrl+K / Ctrl+W** — delete to start / to end / previous word",
    "- **Ctrl+C** twice — exit",
    "- **\\\\** then Enter — insert a newline in the composer",
  ].join("\n");
}

function buildStatusMarkdown(opts: {
  mode: EaonMode;
  permissionMode: PermissionMode;
  model: ModelEntry | null;
  config: import("../types.js").EaonConfig;
  catalog: ModelEntry[];
  projectRoot: string;
  turns: Turn[];
}): string {
  const { mode, permissionMode, model, config, catalog, projectRoot, turns } = opts;
  const aquaCount = catalog.filter((m) => m.provider.kind === "aqua").length;
  const ollamaCount = catalog.filter((m) => m.provider.kind === "ollama").length;
  const customCount = catalog.filter((m) => m.provider.kind === "custom").length;
  const userTurns = turns.filter((t) => t.role === "user").length;
  const toolCalls = turns.filter((t) => t.role === "tool").length;
  const chars = turns.filter((t) => t.role === "assistant").reduce((sum, t) => sum + t.content.length, 0);

  return [
    "## Status",
    "",
    `**Agent** · **Permission:** ${permissionMode === "plan" ? "Plan" : permissionMode === "auto" ? "Auto" : "Sandboxed"}`,
    `**Model:** ${model ? describeEntry(model) : "none selected"}`,
    `**Project:** ${projectRoot}${isUnsafeProjectRoot(projectRoot) ? ` ⚠ (${unsafeRootReason(projectRoot)})` : ""}`,
    `**Platform:** ${platformLabel()}`,
    "",
    "### Providers",
    `- Eaon: ${resolveAquaApiKey(config) ? `configured, ${aquaCount} model(s)` : "not configured — try /link"}`,
    `- Ollama: ${ollamaCount > 0 ? `${ollamaCount} model(s) found` : "not reachable / no models"}`,
    `- BYOK: ${config.customProviders.length} provider(s) configured, ${customCount} model(s)`,
    "",
    "### This session",
    `- ${userTurns} message${userTurns === 1 ? "" : "s"} sent`,
    `- ${toolCalls} tool call${toolCalls === 1 ? "" : "s"} executed`,
    `- ~${chars.toLocaleString()} character${chars === 1 ? "" : "s"} generated`,
  ].join("\n");
  void mode;
}

/** ~4 chars/token — the same rough heuristic the desktop app's context
 * badge uses. Honest about being approximate everywhere it's shown. */
function estimateTokens(turns: Turn[]): number {
  let chars = 0;
  for (const t of turns) chars += t.content.length + (t.reasoning?.length ?? 0) + (t.toolCalls ? JSON.stringify(t.toolCalls).length : 0);
  return Math.round(chars / 4);
}

function buildContextMarkdown(turns: Turn[]): string {
  const byRole = (role: string) => turns.filter((t) => t.role === role);
  const tokensOf = (ts: Turn[]) => estimateTokens(ts).toLocaleString();
  return [
    "## Context usage (approximate)",
    "",
    `**Total:** ~${estimateTokens(turns).toLocaleString()} tokens across ${turns.length} turns`,
    "",
    `- System prompt: ~${tokensOf(byRole("system"))} tokens`,
    `- Your messages: ~${tokensOf(byRole("user"))} tokens (${byRole("user").length})`,
    `- Assistant replies: ~${tokensOf(byRole("assistant"))} tokens (${byRole("assistant").length})`,
    `- Tool results: ~${tokensOf(byRole("tool"))} tokens (${byRole("tool").length})`,
    "",
    "Estimated at ~4 characters per token. When this gets large, /compact summarizes the conversation and keeps going with a much smaller context.",
  ].join("\n");
}

function redactKey(key: string): string {
  if (!key) return "(not set)";
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)} (redacted)`;
}

function transcriptMarkdown(turns: Turn[], modelLabel: string): string {
  const lines: string[] = [`# Eaon session`, "", `_Model: ${modelLabel} · Exported ${new Date().toLocaleString()}_`, ""];
  for (const t of turns) {
    if (t.role === "system") continue;
    if (t.role === "user") lines.push(`## You`, "", t.content, "");
    else if (t.role === "assistant") {
      if (t.content.trim()) lines.push(`## Eaon`, "", t.content, "");
      for (const call of t.toolCalls ?? []) lines.push(`> tool call: \`${call.name}\``, "");
    } else if (t.role === "tool") {
      const body = t.content.length > 2000 ? t.content.slice(0, 2000) + "\n…(truncated)" : t.content;
      lines.push(`<details><summary>tool result: ${t.name ?? "?"}${t.isError ? " (error)" : ""}</summary>`, "", "```", body, "```", "", "</details>", "");
    }
  }
  return lines.join("\n");
}

/** Writes text to the system clipboard by piping it into the platform's
 * clipboard tool on stdin — which is why this can't go through runShell
 * (that has no stdin channel, and putting arbitrary reply text on a shell
 * command line would be both fragile and unsafe). Returns false rather
 * than throwing when no clipboard tool exists (headless Linux, etc). */
async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<{ cmd: string; args: string[] }> = isMac
    ? [{ cmd: "pbcopy", args: [] }]
    : isWindows
      ? [{ cmd: "clip", args: [] }]
      : [
          { cmd: "wl-copy", args: [] },
          { cmd: "xclip", args: ["-selection", "clipboard"] },
          { cmd: "xsel", args: ["--clipboard", "--input"] },
        ];

  for (const { cmd, args } of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        resolve(false);
        return;
      }
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      try {
        child.stdin?.end(text);
      } catch {
        resolve(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

const COMPACT_INSTRUCTION = `Summarize this coding session so a fresh instance of you can seamlessly continue the work. Include: (1) what the user is trying to accomplish overall, (2) what has actually been DONE so far — files created/changed (with paths) and what's in them, commands run and their real outcomes, (3) anything learned about the project/environment that isn't obvious (layout, conventions, gotchas hit), and (4) exactly where things stand now and what the next step was going to be. Be specific and factual — only include things that actually happened in this conversation. Reply with ONLY the summary text.`;

/** Codex busy line above the prompt — steady • + elapsed, esc to interrupt. */
function GenerationStatus(): React.ReactElement {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={theme.muted}>
      • Working ({seconds}s · esc to interrupt)
    </Text>
  );
}

function AutoModeConfirm({ onAnswer }: { onAnswer: (yes: boolean) => void }): React.ReactElement {
  useInput((input, key) => {
    if (input.toLowerCase() === "y" || key.return) onAnswer(true);
    else if (input.toLowerCase() === "n" || key.escape) onAnswer(false);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={PERMISSION_COLORS.auto} paddingX={1} marginTop={1}>
      <Text bold color={PERMISSION_COLORS.auto}>
        Switch to Auto mode?
      </Text>
      <Text color={theme.muted}>Tool calls will run immediately, with no confirmation prompt. Press Y to confirm, N to cancel.</Text>
    </Box>
  );
}

export function App({ version, initialMode, initialModelKey, projectRoot, startInAuto, startPermissionMode, resumeSessionId, continueLatest, forceWelcome }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [config, setConfig] = useState(() => loadConfig());
  // First install = no config file on disk yet — gates the one-time
  // WelcomeScreen (see the render branch below). Persisted the moment that
  // screen finishes, linked or not, so it can never show a second time.
  const [welcomeDone, setWelcomeDone] = useState(() => !forceWelcome && fs.existsSync(configFile()));
  // One Agent — coerce any legacy chat/claw launch into agent.
  const [mode, setMode] = useState<EaonMode>("agent");
  void initialMode;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(startPermissionMode ?? (startInAuto ? "auto" : "sandboxed"));
  const [confirmingAuto, setConfirmingAuto] = useState(false);
  const [catalog, setCatalog] = useState<ModelEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [model, setModel] = useState<ModelEntry | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<{ name: string; summary: string; detail?: string } | null>(null);
  /** Plan mode: set while the model is waiting on the user to approve a
   * plan. Resolved through planResolveRef, same bridge pattern as the
   * permission prompt. */
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  /** Messages typed while a turn was running — sent, in order, once it
   * finishes. See handleSubmit and runLoop's finally. */
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [submitHistory, setSubmitHistory] = useState<string[]>([]);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<AccountTab | null>(null);
  const [updateOffer, setUpdateOffer] = useState<UpdateAvailability | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [requestLogs, setRequestLogs] = useState<RequestLogEntry[]>(() => loadRequestLog());
  // The palette is one mutable object (see theme.ts); this counter is what makes
  // Ink repaint after it is reassigned.
  const [, bumpTheme] = useState(0);
  // Bumped whenever a todo_write result lands so the pinned checklist
  // re-renders — the list itself lives in the tool module (per-process).
  const [todoVersion, setTodoVersion] = useState(0);
  // Bumped on /clear, /resume, /compact — anything that wholesale-replaces
  // `messages` instead of appending to it. Passed as <Static>'s `key` so
  // React remounts it (resetting its internal "already rendered" index)
  // instead of leaving it desynced: Static only ever renders
  // items.slice(previouslySeenCount), so swapping in a same-or-shorter
  // array without a remount silently drops content (a resumed session's
  // transcript, or /compact's own summary message, would never appear).
  const [historyEpoch, setHistoryEpoch] = useState(0);
  // Live approximate size of the conversation for the status bar — updated
  // when a turn finishes rather than per-token (cheap and steady).
  const [contextTokens, setContextTokens] = useState(0);
  /** Mirrors contextTokens so the request log can diff across a turn without
   *  adding it to runLoop's dependency list. */
  const contextTokensRef = useRef(0);
  const turnStartedAtRef = useRef(0);
  const turnFailedRef = useRef(false);

  const turnsRef = useRef<Turn[]>([]);
  const permissionResolveRef = useRef<((a: PermissionAnswer) => void) | null>(null);
  const planResolveRef = useRef<((a: PermissionAnswer) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const alwaysAllowRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string>(randomUUID());
  const lastCtrlCRef = useRef<number>(0);
  /** Set only when the user submits new text WHILE a turn is generating —
   * runLoop's `finally` picks this up once the aborted turn has actually
   * finished unwinding and starts the next one, so an interrupt always
   * fully stops the old turn before the new one begins (never two turns
   * racing on the same `turnsRef`). */
  const interruptResubmitRef = useRef<string | null>(null);
  /** Built once, lazily, on first `@`-mention keystroke and cached for the
   * session — a full re-walk per keystroke would make typing `@` laggy on a
   * big tree. Files created mid-session won't appear until relaunch; a fair
   * trade for instant autocomplete. */
  const fileIndexRef = useRef<string[] | null>(null);
  /** expandMentions is defined below runLoop, but runLoop's queue drain
   * needs it — a ref keeps the reference live without reordering the file
   * or threading it through a dependency array. */
  const expandMentionsRef = useRef<(text: string) => string>((t) => t);

  const pushSystem = useCallback((text: string, tone: "info" | "error" | "success" = "info") => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      // Consecutive identical system lines (e.g. step_error + loop_stopped
      // with the same failure string) just spam the transcript and make Ink
      // redraw thrash under <Static>.
      if (last?.role === "system" && last.text === text && last.tone === tone) return prev;
      return [...prev, { id: randomUUID(), role: "system", text, tone }];
    });
  }, []);

  // Renders as real Markdown (headers, bold, lists) via the same renderer
  // assistant replies use — reused deliberately for /help and /status
  // instead of a new component, since MessageView never prints a "model"
  // attribution on an assistant row, so this can't be mistaken for
  // something the model actually said.
  const pushMarkdown = useCallback((text: string) => {
    setMessages((prev) => [...prev, { id: randomUUID(), role: "assistant", text, reasoning: "", streaming: false }]);
  }, []);

  const refreshCatalog = useCallback(async () => {
    const result = await buildCatalog(config);
    setCatalog(result.models);
    return result;
  }, [config]);

  // Picked once, at mount, not on every render — "a new quote each time you
  // open it" means once per launch, not once per keystroke.
  const [launchQuote] = useState(() => pickRandomQuote());

  // Startup: build the catalog, pick a model, show the welcome banner.
  useEffect(() => {
    (async () => {
      const result = await refreshCatalog();
      setCatalogLoading(false);
      let chosen: ModelEntry | undefined;
      if (initialModelKey) chosen = findModel(result.models, initialModelKey);
      if (!chosen && config.selectedModelKey) chosen = findModel(result.models, config.selectedModelKey);
      if (!chosen) chosen = result.models[0];
      if (chosen) setModel(chosen);

      setMessages((prev) => [
        ...prev,
        {
          id: randomUUID(),
          role: "banner",
          version,
          quote: launchQuote,
          mode,
          modelLabel: chosen ? describeEntry(chosen) : "no model selected — try /models",
          projectRoot,
          recentSessions: listSessions(4),
        },
      ]);

      // -c / -r: reopen a saved session instead of starting cold. Done here
      // (after the banner) so the restored transcript reads as history above
      // the composer, exactly like /resume does mid-session.
      if (resumeSessionId || continueLatest) {
        // listSessions is already newest-first, so [0] is "the last one".
        // -c is scoped to THIS project: continuing an unrelated project's
        // conversation in a new directory would be actively confusing.
        const summaries = listSessions(200);
        const target = resumeSessionId
          ? summaries.find((s) => s.id === resumeSessionId || s.id.startsWith(resumeSessionId))
          : summaries.find((s) => loadSession(s.id)?.projectRoot === projectRoot);
        const loaded = target ? loadSession(target.id) : null;
        if (!loaded) {
          pushSystem(
            resumeSessionId
              ? `No saved session matching "${resumeSessionId}" — starting fresh.`
              : "No previous session to continue — starting fresh.",
            "info"
          );
        } else {
          turnsRef.current = loaded.turns;
          sessionIdRef.current = loaded.id;
          setMode("agent");
          if (loaded.modelKey) {
            const found = findModel(result.models, loaded.modelKey);
            if (found) setModel(found);
          }
          setMessages((prev) => [...prev, ...turnsToDisplayMessages(loaded.turns)]);
          setContextTokens(estimateTokens(loaded.turns));
          pushSystem(`Continuing "${loaded.title}".`, "success");
        }
      }

      const notes = readProjectNotes(projectRoot);
      if (result.aquaError) pushSystem(`Eaon models unavailable: ${result.aquaError}`, "error");
      if (notes) pushSystem("Loaded EAON.md for project context.", "info");
      if (isUnsafeProjectRoot(projectRoot)) {
        pushSystem(
          `Working from ${unsafeRootReason(projectRoot)} — explore tools (list/grep/glob) are disabled. cd into a project or relaunch with --cwd.`,
          "error"
        );
      }
      const bundledUpdate = checkForBundledUpdate(version);
      if (bundledUpdate) pushSystem(updateNoticeLine(bundledUpdate), "info");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildLoopState = useCallback((): AgentLoopState => {
    const notes = readProjectNotes(projectRoot);
    const extra = [config.customInstructions, notes].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n---\n\n");
    const systemContent = systemPromptFor(mode, projectRoot, permissionMode, extra);
    if (turnsRef.current.length === 0) turnsRef.current.push({ role: "system", content: systemContent });
    else turnsRef.current[0] = { role: "system", content: systemContent };
    return {
      mode,
      permissionMode,
      model: model as ModelEntry,
      config,
      pathCtx: { projectRoot } as PathGuardContext,
      turns: turnsRef.current,
      alwaysAllow: alwaysAllowRef.current,
    };
  }, [mode, permissionMode, model, config, projectRoot]);

  const persistCurrentSession = useCallback(() => {
    const session: Session = {
      id: sessionIdRef.current,
      title: deriveTitle(turnsRef.current),
      mode,
      modelKey: model?.key ?? null,
      projectRoot,
      turns: turnsRef.current,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      saveSession(session);
    } catch {
      // best-effort — never let a save failure interrupt the conversation
    }
  }, [mode, model, projectRoot]);

  const runLoop = useCallback(async () => {
    if (!model) {
      pushSystem("No model selected — try /models.", "error");
      return;
    }
    setIsGenerating(true);
    // Reset the per-turn measurements the request log reads in `finally`.
    turnStartedAtRef.current = Date.now();
    turnFailedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = randomUUID();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", text: "", reasoning: "", streaming: true }]);

    // Streaming a local model can produce dozens of tokens a second, and
    // pushing a full setState (and the Markdown re-parse/re-highlight it
    // triggers) on EVERY one is what actually made the terminal feel
    // laggy — not the model, the render loop. Deltas accumulate here and
    // flush to state on a fixed ~40ms cadence (25fps: smooth to watch,
    // cheap to render) instead of once per token.
    let pendingText = "";
    let pendingReasoning = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pendingText.length === 0 && pendingReasoning.length === 0) return;
      const text = pendingText;
      const reasoning = pendingReasoning;
      pendingText = "";
      pendingReasoning = "";
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId && m.role === "assistant" ? { ...m, text: m.text + text, reasoning: m.reasoning + reasoning } : m))
      );
    };
    const scheduleFlush = () => {
      if (flushTimer === null) flushTimer = setTimeout(flush, 40);
    };

    const loopState = buildLoopState();
    const gen = runAgentTurn(loopState, {
      signal: controller.signal,
      // Snapshot every file the agent is about to change, so /rewind can
      // put it back. Resolved against the project root here because the
      // tool layer hands us whatever path the model wrote.
      onBeforeFileChange: (filePath, label) => {
        recordCheckpoint(sessionIdRef.current, path.resolve(projectRoot, filePath), label);
      },
    });
    let sendValue: PermissionAnswer | undefined;

    try {
      while (true) {
        let step: IteratorResult<AgentEvent, void>;
        try {
          step = await gen.next(sendValue);
        } catch (e) {
          turnFailedRef.current = true;
      pushSystem(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, "error");
          break;
        }
        sendValue = undefined;
        if (step.done) break;
        const event = step.value;

        if (event.type === "content_delta") {
          pendingText += event.text;
          scheduleFlush();
        } else if (event.type === "reasoning_delta") {
          pendingReasoning += event.text;
          scheduleFlush();
        } else if (event.type === "turn_end" || event.type === "tool_call_requested" || event.type === "permission_request") {
          // Flush immediately before anything that renders alongside the
          // streamed text (a tool row, a permission prompt) — otherwise
          // the buffered tail of the reply would appear to arrive AFTER
          // the tool call that logically followed it.
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flush();
          }
        }

        if (event.type === "tool_call_requested") {
          setMessages((prev) => [
            ...prev,
            { id: randomUUID(), role: "tool", name: event.name, summary: event.summary, detail: event.detail, args: event.args, pending: true, callId: event.callId },
          ]);
        } else if (event.type === "permission_request") {
          sendValue = await new Promise<PermissionAnswer>((resolve) => {
            permissionResolveRef.current = resolve;
            setPendingPermission({ name: event.name, summary: event.summary, detail: event.detail });
          });
          setPendingPermission(null);
          permissionResolveRef.current = null;
        } else if (event.type === "plan_proposed") {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flush();
          }
          const answer = await new Promise<PermissionAnswer>((resolve) => {
            planResolveRef.current = resolve;
            setPendingPlan(event.plan);
          });
          setPendingPlan(null);
          planResolveRef.current = null;
          sendValue = answer;
          if (answer === "approve") {
            // The loop flipped ITS copy to auto so the same turn continues;
            // mirror that here so the footer and the next turn agree.
            setPermissionMode("auto");
            pushSystem("Plan approved — working on it. (auto-accept is on for the rest of this session)", "success");
          } else {
            pushSystem("Plan not approved — still planning. Tell it what to change.", "info");
          }
        } else if (event.type === "subagent_start") {
          pushSystem(`⌘ delegating: ${event.description}…`, "info");
        } else if (event.type === "subagent_end") {
          pushSystem(`⌘ done: ${event.description}`, "info");
        } else if (event.type === "tool_result") {
          if (event.name === "todo_write") setTodoVersion((v) => v + 1);
          setMessages((prev) => {
            // Match by the loop's call id — exact, so two same-named calls
            // in one turn can never fill each other's rows. The name-based
            // fallback only covers a row created before callId existed.
            let idx = prev.findIndex((m) => m.role === "tool" && m.pending && m.callId === event.callId);
            if (idx === -1) idx = prev.map((m) => m.role === "tool" && m.pending && m.name === event.name).lastIndexOf(true);
            if (idx === -1) return prev;
            const copy = [...prev];
            const row = copy[idx];
            if (row.role === "tool") copy[idx] = { ...row, pending: false, result: { isError: event.isError, text: event.text } };
            return copy;
          });
        } else if (event.type === "step_error") {
          // Retry notices are progress, not hard failures.
          const isRetry = /retrying in \d+s/i.test(event.message);
          pushSystem(event.message, isRetry ? "info" : "error");
        } else if (event.type === "loop_stopped") {
          // Final step_error already pushed the same string — skip the duplicate.
          turnFailedRef.current = true;
          pushSystem(event.reason, "error");
        }
      }
    } catch (e) {
      // Defense in depth: gen.next() above already has its own inner
      // try/catch, but nothing else in this loop did — and runLoop always
      // runs fire-and-forget (`void runLoop()`), so anything that escaped
      // here would otherwise be an unhandled rejection, which crashes the
      // whole process by default. Surface it instead of taking the TUI down.
      pushSystem(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flush();
      setIsGenerating(false);
      // One row per turn in the local request log (see session/requestLog.ts).
      // Token count is the context estimate delta rather than a provider usage
      // figure: the loop does not surface `usage`, and an estimate labelled as
      // such beats an empty column.
      {
        const before = contextTokensRef.current;
        const after = estimateTokens(turnsRef.current);
        noteRequest({
          model: model ? model.key : "unknown",
          ok: !turnFailedRef.current,
          latencyMs: Date.now() - turnStartedAtRef.current,
          tokens: Math.max(0, after - before) || null,
        });
      }
      abortRef.current = null;
      setMessages((prev) => prev.map((m) => (m.id === assistantId && m.role === "assistant" ? { ...m, streaming: false } : m)));
      {
        const tokens = estimateTokens(turnsRef.current);
        contextTokensRef.current = tokens;
        setContextTokens(tokens);
      }
      persistCurrentSession();

      // Anything typed while this turn was running (see handleSubmit) now
      // goes through as the next turn, in the order it was typed. Multiple
      // queued lines are joined into one turn rather than run as separate
      // turns — they were written as one thought while waiting.
      const resubmit = interruptResubmitRef.current;
      interruptResubmitRef.current = null;
      let queuedText: string | null = null;
      setQueuedMessages((q) => {
        if (q.length > 0) queuedText = q.join("\n");
        return [];
      });
      // setQueuedMessages' updater runs synchronously here, so queuedText is
      // populated by this point; the ref covers the older interrupt path.
      const next = [resubmit, queuedText].filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n");
      if (next.length > 0) {
        setMessages((prev) => [...prev, { id: randomUUID(), role: "user", text: next }]);
        turnsRef.current.push({ role: "user", content: expandMentionsRef.current(next) });
        void runLoop().catch((e) => pushSystem(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, "error"));
      }
    }
  }, [model, buildLoopState, pushSystem, persistCurrentSession]);

  const handlePull = useCallback(
    async (name: string) => {
      pushSystem(`Pulling ${name}…`, "info");
      let lastShown = -1;
      for await (const ev of pullOllamaModel(resolveOllamaBaseUrl(config), name)) {
        if (ev.type === "progress") {
          if (ev.total > 0) {
            const pct = Math.floor((ev.completed / ev.total) * 100);
            if (pct !== lastShown) {
              lastShown = pct;
              setStatusText(`${ev.status} — ${pct}%`);
            }
          } else if (ev.status) {
            setStatusText(ev.status);
          }
        } else if (ev.type === "error") {
          setStatusText(null);
          pushSystem(`Pull failed: ${ev.message}`, "error");
          return;
        } else if (ev.type === "done") {
          setStatusText(null);
          pushSystem(`${name} is ready.`, "success");
          await refreshCatalog();
        }
      }
    },
    [config, pushSystem, refreshCatalog]
  );

  const handleLink = useCallback(async (): Promise<LinkOutcome> => {
    // Always open the browser. Desktop import is optional (macOS + saved
    // credentials); Set / edit keys works everywhere so users without
    // Eaon Desktop aren't stuck editing config.json by hand.
    const discovery = isLocalDiscoveryAvailable()
      ? discoverDesktopCredentials()
      : { domain: null, aquaApiKey: null, customProviders: [], skippedUnrecognizedFormat: 0 };

    if (discovery.domain) {
      pushSystem("Opening your browser — import from Eaon Desktop, or set / edit API keys…");
    } else {
      pushSystem("Opening your browser to set or edit API keys…");
    }

    try {
      const { url, result } = runLinkServer(discovery, config);
      const linkUrl = await url;
      pushSystem(`Browser: ${linkUrl}`);
      try {
        await open(linkUrl);
      } catch {
        pushSystem(`Couldn't open a browser automatically — open this URL yourself: ${linkUrl}`, "error");
      }

      const outcome = await result;
      if (outcome.timedOut) {
        pushSystem("Link expired after 5 minutes with no response — run /link again.", "error");
        return "timed_out";
      }
      if (!outcome.approved || outcome.mode === "none") {
        pushSystem("Cancelled — nothing was changed.", "info");
        return "cancelled";
      }

      let nextConfig = config;
      if (outcome.mode === "import") {
        const selection = { includeAquaKey: outcome.includeAquaKey, selectedProviderIds: outcome.selectedProviderIds };
        if (!selection.includeAquaKey && selection.selectedProviderIds.length === 0) {
          pushSystem("Nothing was checked on the page, so nothing was imported.", "info");
          return "nothing_selected";
        }
        nextConfig = applyDiscoveryToConfig(config, discovery, selection);
      } else {
        const hasChanges =
          !!outcome.aquaApiKey ||
          outcome.clearAquaKey ||
          !!outcome.ollamaBaseUrl ||
          outcome.upsertProviders.length > 0 ||
          outcome.deleteProviderIds.length > 0;
        if (!hasChanges) {
          pushSystem("No changes submitted.", "info");
          return "nothing_selected";
        }
        nextConfig = applyConfigureToConfig(config, outcome);
      }

      setConfig(nextConfig);
      saveConfig(nextConfig);
      setCatalogLoading(true);
      const catalogResult = await buildCatalog(nextConfig);
      setCatalog(catalogResult.models);
      setCatalogLoading(false);
      if (catalogResult.aquaError) pushSystem(`Eaon models unavailable: ${catalogResult.aquaError}`, "error");

      if (outcome.mode === "import") {
        const importedProviders = discovery.customProviders.filter((p) => outcome.selectedProviderIds.includes(p.id));
        const aquaModelCount = catalogResult.models.filter((m) => m.provider.kind === "aqua").length;
        const parts: string[] = [];
        if (outcome.includeAquaKey) parts.push(`Eaon API key (${aquaModelCount} model${aquaModelCount === 1 ? "" : "s"})`);
        if (importedProviders.length > 0) {
          const nameCounts = new Map<string, number>();
          for (const p of discovery.customProviders) nameCounts.set(p.displayName, (nameCounts.get(p.displayName) ?? 0) + 1);
          const names = importedProviders.map((p) =>
            (nameCounts.get(p.displayName) ?? 0) > 1 ? `${p.displayName} (${domainLabel(p.sourceDomain)})` : p.displayName
          );
          parts.push(
            `${importedProviders.length} of ${discovery.customProviders.length} custom provider${discovery.customProviders.length === 1 ? "" : "s"} (${names.join(", ")})`
          );
        }
        const skippedNote =
          discovery.skippedUnrecognizedFormat > 0
            ? ` (skipped ${discovery.skippedUnrecognizedFormat} in an unrecognized format)`
            : "";
        pushSystem(`Linked ✓ — imported ${parts.join(" and ")}${skippedNote}. Try /model to pick a cloud model.`, "success");
      } else {
        const parts: string[] = [];
        if (outcome.clearAquaKey) parts.push("cleared Eaon key");
        else if (outcome.aquaApiKey) parts.push("updated Eaon key");
        if (outcome.ollamaBaseUrl) parts.push("updated Ollama URL");
        if (outcome.upsertProviders.length > 0) {
          parts.push(
            `saved ${outcome.upsertProviders.length} provider${outcome.upsertProviders.length === 1 ? "" : "s"} (${outcome.upsertProviders.map((p) => p.displayName).join(", ")})`
          );
        }
        if (outcome.deleteProviderIds.length > 0) {
          parts.push(`removed ${outcome.deleteProviderIds.length}`);
        }
        pushSystem(`Saved ✓ — ${parts.join(", ")}. Try /model to pick a model.`, "success");
      }
      return "linked";
    } catch (e) {
      setCatalogLoading(false);
      pushSystem(`/link failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      return "error";
    }
  }, [config, pushSystem]);

  // Marks first-run as done regardless of how WelcomeScreen ended (linked,
  // skipped, or nothing to link to) — writing SOME config file, even one
  // that's still all defaults, is what keeps the screen from reappearing
  // on the next launch (a successful link already writes one itself via
  // handleLink above; this covers every other path).
  const finishWelcome = useCallback(() => {
    try {
      saveConfig(config);
    } catch {
      // best-effort — a write failure here shouldn't block entering the app
    }
    setWelcomeDone(true);
  }, [config]);

  const handleCompact = useCallback(async () => {
    const nonSystem = turnsRef.current.filter((t) => t.role !== "system");
    if (nonSystem.length < 2) {
      pushSystem("Nothing to compact yet — the conversation is still small.");
      return;
    }
    if (!model) {
      pushSystem("No model selected — /compact needs one to write the summary.", "error");
      return;
    }
    const before = estimateTokens(turnsRef.current);
    setStatusText("Compacting conversation…");
    try {
      const { baseUrl, apiKey, format } = endpointFor(model, config);
      // The summarizer sees the real conversation plus one closing
      // instruction — no tools, no streaming UI, just accumulate the text.
      const summaryTurns: Turn[] = [...turnsRef.current, { role: "user", content: COMPACT_INSTRUCTION }];
      let summary = "";
      let errorMessage: string | null = null;
      for await (const ev of streamChat({ baseUrl, apiKey, model: model.requestId, turns: summaryTurns, format })) {
        if (ev.type === "token") summary += ev.text;
        else if (ev.type === "error") errorMessage = ev.message;
      }
      if (errorMessage || summary.trim().length === 0) {
        pushSystem(`Compact failed: ${errorMessage ?? "the model returned nothing"}. The conversation is unchanged.`, "error");
        return;
      }
      turnsRef.current = [
        { role: "user", content: `[Summary of the conversation so far — compacted to save context]\n\n${summary.trim()}` },
      ];
      const after = estimateTokens(turnsRef.current);
      setContextTokens(after);
      setMessages([]);
      setHistoryEpoch((e) => e + 1);
      pushMarkdown(`## Conversation compacted\n\n~${before.toLocaleString()} → ~${after.toLocaleString()} tokens. The summary below is what the model now remembers:\n\n${summary.trim()}`);
      persistCurrentSession();
    } catch (e) {
      // Belt and suspenders: endpointFor/streamChat don't throw today, but
      // handleCompact runs fire-and-forget (`void handleCommand(...)`), so
      // if that ever changes, an escaping error should end up as a normal
      // message instead of crashing the whole session.
      pushSystem(`Compact failed: ${e instanceof Error ? e.message : String(e)}. The conversation is unchanged.`, "error");
    } finally {
      setStatusText(null);
    }
  }, [model, config, pushSystem, pushMarkdown, persistCurrentSession]);

  const handleCommand = useCallback(
    async (name: string, args: string) => {
      const parsed = parseSlashCommand(`/${name} ${args}`);
      if (!parsed) return;
      const outcome = parsed.command.run(parsed.args);

      switch (outcome.kind) {
        case "message":
          pushSystem(outcome.text, "info");
          return;
        case "error":
          pushSystem(outcome.text, "error");
          return;
        case "set_mode":
          setMode("agent");
          pushSystem("Eaon is one agent — use shift+tab for plan · sandboxed · auto.", "info");
          return;
        case "set_permission":
          setPermissionMode(outcome.mode);
          pushSystem(`Permission mode: ${outcome.mode}.`, "success");
          return;
        case "set_model": {
          const matches = resolveModelQuery(catalog, outcome.query);
          if (matches.length === 0) {
            pushSystem(`No model matches "${outcome.query}". Try /models to see what's available.`, "error");
          } else if (matches.length > 1 && !matches.some((m) => m.key.toLowerCase() === outcome.query.toLowerCase())) {
            pushSystem(`"${outcome.query}" matches more than one model:\n${matches.map((m) => `  ${m.key}`).join("\n")}\nBe more specific.`, "error");
          } else {
            const chosen = matches[0];
            setModel(chosen);
            const nextConfig = { ...config, selectedModelKey: chosen.key };
            setConfig(nextConfig);
            saveConfig(nextConfig);
            pushSystem(`Switched to ${describeEntry(chosen)}.`, "success");
          }
          return;
        }
        case "open_model_picker":
          setModelPickerOpen(true);
          return;
        case "open_themes":
          setThemePickerOpen(true);
          return;
        case "open_account":
          setAccountTab(outcome.tab);
          return;
        case "check_update":
          void checkForUpdate(version).then((found) => {
            if (found) setUpdateOffer(found);
            else pushSystem(`Already on the latest version (v${version}).`);
          });
          return;
        case "list_models":
          pushSystem(formatCatalog(catalog, model));
          return;
        case "pull_model":
          await handlePull(outcome.name);
          return;
        case "link":
          await handleLink();
          return;
        case "help":
          pushMarkdown(buildHelpMarkdown());
          return;
        case "status":
          pushMarkdown(buildStatusMarkdown({ mode, permissionMode, model, config, catalog, projectRoot, turns: turnsRef.current }));
          return;
        case "init_project": {
          try {
            const result = await runInit(projectRoot);
            pushSystem(`Wrote ${result.file}\n${result.summary}`, "success");
          } catch (e) {
            pushSystem(`Couldn't write EAON.md: ${e instanceof Error ? e.message : String(e)}`, "error");
          }
          return;
        }
        case "clear":
          turnsRef.current = [];
          sessionIdRef.current = randomUUID();
          resetTodos();
          resetKnownFiles();
          fileIndexRef.current = null;
          setTodoVersion((v) => v + 1);
          setContextTokens(0);
          setMessages([]);
          setHistoryEpoch((e) => e + 1);
          pushSystem("Started a new session.", "info");
          return;
        case "resume": {
          if (!outcome.sessionId) {
            const sessions = listSessions();
            if (sessions.length === 0) {
              pushSystem("No saved sessions yet.");
            } else {
              const lines = sessions.map((s) => `  ${s.id.slice(0, 8)}  ${MODE_LABEL[s.mode]}  ${new Date(s.updatedAt).toLocaleString()}  ${s.title}`);
              pushSystem(["Recent sessions (/resume <id>):", ...lines].join("\n"));
            }
            return;
          }
          const full = listSessions(200).find((s) => s.id.startsWith(outcome.sessionId!));
          const loaded = full ? loadSession(full.id) : null;
          if (!loaded) {
            pushSystem(`No session matching "${outcome.sessionId}".`, "error");
            return;
          }
          turnsRef.current = loaded.turns;
          sessionIdRef.current = loaded.id;
          resetKnownFiles();
          setMode(loaded.mode);
          if (loaded.modelKey) {
            const found = findModel(catalog, loaded.modelKey);
            if (found) setModel(found);
          }
          setMessages(turnsToDisplayMessages(loaded.turns));
          setHistoryEpoch((e) => e + 1);
          pushSystem(`Resumed "${loaded.title}".`, "success");
          return;
        }
        case "cost": {
          const userTurns = turnsRef.current.filter((t) => t.role === "user").length;
          const assistantChars = turnsRef.current.filter((t) => t.role === "assistant").reduce((sum, t) => sum + t.content.length, 0);
          pushSystem(`This session: ${userTurns} message${userTurns === 1 ? "" : "s"} sent, ~${assistantChars.toLocaleString()} characters generated. (Approximate — Eaon CLI doesn't have per-provider pricing data to convert this to cost.)`);
          return;
        }
        case "compact":
          await handleCompact();
          return;
        case "context":
          pushMarkdown(buildContextMarkdown(turnsRef.current));
          return;
        case "doctor": {
          const checks: string[] = [];
          checks.push(`- Node: ${process.version} ✓`);
          checks.push(`- Platform: ${platformLabel()}`);
          const ollamaUrl = resolveOllamaBaseUrl(config);
          try {
            const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
            const data = (await res.json()) as { models?: unknown[] };
            checks.push(`- Ollama at ${ollamaUrl}: reachable, ${data.models?.length ?? 0} model(s) ✓`);
          } catch {
            checks.push(`- Ollama at ${ollamaUrl}: not reachable — install from ollama.com for local models`);
          }
          checks.push(`- Eaon API key: ${resolveAquaApiKey(config) ? "configured ✓" : "not set — /link to import or enter one"}`);
          checks.push(`- BYOK providers: ${config.customProviders.length}`);
          checks.push(`- Config file: ${configFile()}${fs.existsSync(configFile()) ? " ✓" : " (not written yet — created on first change)"}`);
          checks.push(`- Project memory: ${readProjectNotes(projectRoot) ? `${PROJECT_NOTES_FILE} loaded ✓` : `no ${PROJECT_NOTES_FILE} — run /init to create one`}`);
          checks.push(`- Models in catalog: ${catalog.length}`);
          pushMarkdown(["## Doctor", "", ...checks].join("\n"));
          return;
        }
        case "show_config": {
          const redacted = {
            ...config,
            aquaApiKey: redactKey(resolveAquaApiKey(config)),
            customProviders: config.customProviders.map((p) => ({ ...p, apiKey: redactKey(p.apiKey) })),
          };
          pushMarkdown(["## Config", "", `**File:** ${configFile()}`, "", "```json", JSON.stringify(redacted, null, 2), "```"].join("\n"));
          return;
        }
        case "memory": {
          const notesPath = path.join(projectRoot, PROJECT_NOTES_FILE);
          try {
            if (!fs.existsSync(notesPath)) {
              fs.writeFileSync(notesPath, `# ${path.basename(projectRoot)}\n\nNotes for Eaon about this project — conventions, commands, gotchas. Loaded into every session here.\n`, "utf8");
              pushSystem(`Created ${PROJECT_NOTES_FILE}.`, "success");
            }
          } catch (e) {
            pushSystem(`Couldn't create ${PROJECT_NOTES_FILE}: ${e instanceof Error ? e.message : String(e)}`, "error");
            return;
          }
          try {
            await open(notesPath);
            pushSystem(`Opened ${notesPath} — it's loaded into every session in this project.`);
          } catch {
            pushSystem(`Couldn't open an editor — the file is at ${notesPath}.`, "error");
          }
          return;
        }
        case "export": {
          const target = outcome.path
            ? path.resolve(projectRoot, outcome.path)
            : path.join(projectRoot, `eaon-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
          try {
            fs.writeFileSync(target, transcriptMarkdown(turnsRef.current, model ? describeEntry(model) : "unknown"), "utf8");
            pushSystem(`Exported to ${target}`, "success");
          } catch (e) {
            pushSystem(`Export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
          }
          return;
        }
        case "rewind": {
          const entries = listCheckpoints(sessionIdRef.current);
          if (entries.length === 0) {
            pushSystem("Nothing to rewind — the agent hasn't changed any files this session.\n\nNote: /rewind covers files changed through write_file, edit_file, move_item and trash_item. Changes made by a shell command (or by you, outside Eaon) aren't snapshotted — use git for those.", "info");
            return;
          }
          if (!outcome.checkpointId) {
            const lines = entries
              .slice()
              .reverse()
              .slice(0, 20)
              .map((e) => `  ${e.id}  ${new Date(e.createdAt).toLocaleTimeString()}  ${e.label}  —  ${path.relative(projectRoot, e.filePath) || e.filePath}`);
            pushSystem(
              [
                `${entries.length} restore point${entries.length === 1 ? "" : "s"} (newest first):`,
                ...lines,
                "",
                "Rewind with /rewind <id> — that undoes that change and everything after it.",
              ].join("\n")
            );
            return;
          }
          const match = entries.find((e) => e.id === outcome.checkpointId) ?? entries.find((e) => e.id.startsWith(outcome.checkpointId!));
          if (!match) {
            pushSystem(`No restore point "${outcome.checkpointId}". Run /rewind with no argument to list them.`, "error");
            return;
          }
          const restored = restoreToCheckpoint(sessionIdRef.current, match.id);
          if (!restored) {
            pushSystem(`Couldn't rewind to ${match.id}.`, "error");
            return;
          }
          resetKnownFiles(); // the tree changed underneath the model — make it re-read
          const parts = [`Rewound to before "${match.label}" — restored ${restored.restored.length} file${restored.restored.length === 1 ? "" : "s"}.`];
          if (restored.failed.length > 0) {
            parts.push(`Couldn't restore ${restored.failed.length}: ${restored.failed.map((f) => `${path.basename(f.filePath)} (${f.reason})`).join(", ")}`);
          }
          pushSystem(parts.join("\n"), restored.failed.length > 0 ? "error" : "success");
          return;
        }
        case "diff": {
          const result = await runShell({ command: "git --no-pager diff --stat && git --no-pager diff" }, { projectRoot } as PathGuardContext);
          const body = result.text.replace(/^exit code: \d+\n/, "").trim();
          if (result.isError && /not a git repository/i.test(body)) {
            pushSystem("This project isn't a git repository, so there's nothing to diff.", "info");
            return;
          }
          if (body.length === 0 || body === "(no output)") {
            pushSystem("No uncommitted changes.", "info");
            return;
          }
          pushMarkdown(["## Uncommitted changes", "", "```diff", body.length > 12_000 ? body.slice(0, 12_000) + "\n…(truncated)" : body, "```"].join("\n"));
          return;
        }
        case "copy": {
          const lastAssistant = [...turnsRef.current].reverse().find((t) => t.role === "assistant" && t.content.trim().length > 0);
          if (!lastAssistant) {
            pushSystem("Nothing to copy yet.", "info");
            return;
          }
          const written = await copyToClipboard(lastAssistant.content.trim());
          pushSystem(
            written ? "Copied the last reply to the clipboard." : "Couldn't reach a clipboard tool (tried pbcopy / clip / xclip / wl-copy).",
            written ? "success" : "error"
          );
          return;
        }
        case "bashes": {
          const count = runningJobCount();
          pushSystem(count === 0 ? "No background commands are running." : `${count} background command${count === 1 ? "" : "s"} running. The agent can check them with check_shell.`, "info");
          return;
        }
        case "exit":
          persistCurrentSession();
          killAllBackgroundJobs();
          exit();
          return;
      }
    },
    [catalog, model, config, mode, permissionMode, projectRoot, handlePull, handleLink, handleCompact, pushSystem, pushMarkdown, persistCurrentSession, exit]
  );

  // `@`-mention autocomplete source — the project's file list, lazily built
  // and cached (see fileIndexRef).
  const queryFiles = useCallback(
    (q: string): string[] => {
      if (fileIndexRef.current === null) fileIndexRef.current = listProjectFiles(projectRoot);
      const idx = fileIndexRef.current;
      const query = q.toLowerCase();
      if (!query) return idx.slice(0, 6);
      return idx.filter((f) => f.toLowerCase().includes(query)).slice(0, 20);
    },
    [projectRoot]
  );

  // Expands `@path` references in a message into the actual file contents
  // the model sees — the user's on-screen message stays as they typed it,
  // but the turn sent to the model carries the referenced files inline, so
  // "explain @src/app.ts" just works without a separate read_file round-trip.
  const expandMentions = useCallback(
    (text: string): string => {
      const rels = [...text.matchAll(/(^|\s)@([^\s@]+)/g)].map((m) => m[2]);
      if (rels.length === 0) return text;
      const blocks: string[] = [];
      for (const rel of rels) {
        if (blocks.length >= 5) break;
        try {
          const full = path.resolve(projectRoot, rel);
          if (full !== projectRoot && !full.startsWith(projectRoot + path.sep)) continue; // stay inside the project
          const stat = fs.statSync(full);
          if (!stat.isFile() || stat.size > 200_000) continue;
          const content = fs.readFileSync(full, "utf8");
          const capped = content.length > 8000 ? content.slice(0, 8000) + "\n…(truncated)" : content;
          blocks.push(`@${rel}:\n\`\`\`\n${capped}\n\`\`\``);
        } catch {
          // unreadable / missing / binary — skip, the bare @path stays in the text
        }
      }
      return blocks.length === 0 ? text : `${text}\n\nReferenced files:\n${blocks.join("\n\n")}`;
    },
    [projectRoot]
  );
  expandMentionsRef.current = expandMentions;

  // `!command` — run a shell command directly (Claude-Code's bash mode). The
  // output is shown as a tool row AND folded into the conversation as
  // context, so the model can reason about it on the next turn, but it does
  // NOT trigger a model reply on its own.
  const handleBash = useCallback(
    async (command: string) => {
      if (command.length === 0) {
        pushSystem("Nothing to run — type a command after !, e.g. !ls -la", "info");
        return;
      }
      const id = randomUUID();
      setMessages((prev) => [...prev, { id, role: "tool", name: "run_shell", summary: `Bash`, args: { command }, pending: true }]);
      let result;
      try {
        result = await runShell({ command }, { projectRoot } as PathGuardContext);
      } catch (e) {
        result = { isError: true, text: e instanceof Error ? e.message : String(e) };
      }
      const finished = result;
      setMessages((prev) =>
        prev.map((m) => (m.id === id && m.role === "tool" ? { ...m, pending: false, result: { isError: finished.isError, text: finished.text } } : m))
      );
      turnsRef.current.push({ role: "user", content: `I ran this shell command myself:\n$ ${command}\n\nOutput:\n${finished.text}` });
      setContextTokens(estimateTokens(turnsRef.current));
      persistCurrentSession();
    },
    [projectRoot, pushSystem, persistCurrentSession]
  );

  // `#note` — append a line to this project's EAON.md (Claude-Code's `#`
  // quick-memory). No model round-trip; it just persists the note.
  const handleMemoryNote = useCallback(
    (note: string) => {
      if (note.length === 0) {
        pushSystem("Nothing to save — write the note after #, e.g. # always run tests with pnpm test", "info");
        return;
      }
      const notesPath = path.join(projectRoot, PROJECT_NOTES_FILE);
      try {
        const existing = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : `# ${path.basename(projectRoot)}\n\nNotes for Eaon about this project — loaded into every session here.\n`;
        const updated = existing.replace(/\s*$/, "") + `\n- ${note}\n`;
        fs.writeFileSync(notesPath, updated, "utf8");
        pushSystem(`Saved to ${PROJECT_NOTES_FILE}: “${note}”`, "success");
      } catch (e) {
        pushSystem(`Couldn't write ${PROJECT_NOTES_FILE}: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [projectRoot, pushSystem]
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const slash = parseSlashCommand(text);
      if (slash) {
        // A slash command while a turn is generating (e.g. /clear, /model)
        // runs immediately rather than queuing — those aren't a new
        // message to the model, so there's nothing to redirect.
        setSubmitHistory((h) => [...h, text]);
        void handleCommand(slash.command.name, slash.args).catch((e) =>
          pushSystem(`Command failed: ${e instanceof Error ? e.message : String(e)}`, "error")
        );
        return;
      }
      // `!` bash and `#` memory are local side-actions — they don't go to
      // the model and don't interrupt an in-flight turn's text.
      if (text.startsWith("!")) {
        setSubmitHistory((h) => [...h, text]);
        void handleBash(text.slice(1).trim()).catch((e) => pushSystem(`Shell error: ${e instanceof Error ? e.message : String(e)}`, "error"));
        return;
      }
      if (text.startsWith("#")) {
        setSubmitHistory((h) => [...h, text]);
        handleMemoryNote(text.slice(1).trim());
        return;
      }
      setSubmitHistory((h) => [...h, text]);
      if (isGenerating) {
        // QUEUE rather than interrupt. On a long autonomous run you often
        // want to add "also update the README" without derailing the work
        // in flight — so typing sends the message to the back of the line
        // and the agent picks it up when the current turn finishes. Esc is
        // still there for a real interrupt.
        setQueuedMessages((q) => [...q, text]);
        return;
      }
      setMessages((prev) => [...prev, { id: randomUUID(), role: "user", text }]);
      turnsRef.current.push({ role: "user", content: expandMentions(text) });
      void runLoop().catch((e) => pushSystem(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, "error"));
    },
    [handleCommand, runLoop, isGenerating, pushSystem, handleBash, handleMemoryNote, expandMentions]
  );

  /** Shift+Tab cycles plan → sandboxed → auto → plan, the same rotation
   * Claude Code uses. Stepping INTO auto still asks for confirmation (it's
   * the one tier with no gate left), but stepping into plan or sandboxed —
   * both strictly safer — is immediate. */
  const handleTogglePermission = useCallback(() => {
    if (isGenerating) return;
    if (permissionMode === "plan") {
      setPermissionMode("sandboxed");
      pushSystem("Sandboxed — it can edit, but asks before every change.", "info");
      return;
    }
    if (permissionMode === "sandboxed") {
      setConfirmingAuto(true);
      return;
    }
    setPermissionMode("plan");
    pushSystem("Plan mode — it researches and proposes, and changes nothing until you approve.", "info");
  }, [permissionMode, isGenerating, pushSystem]);

  const handleAutoAnswer = useCallback(
    (yes: boolean) => {
      setConfirmingAuto(false);
      if (yes) {
        setPermissionMode("auto");
        pushSystem("Switched to Auto — actions run immediately.");
      }
    },
    [pushSystem]
  );

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      pushSystem("Cancelled.");
    }
  }, [pushSystem]);

  const handlePermissionAnswer = useCallback((answer: PermissionAnswer) => {
    permissionResolveRef.current?.(answer);
  }, []);

  const handleModelPickerSelect = useCallback(
    (chosen: ModelEntry) => {
      setModel(chosen);
      const nextConfig = { ...config, selectedModelKey: chosen.key };
      setConfig(nextConfig);
      saveConfig(nextConfig);
      setModelPickerOpen(false);
      pushSystem(`Switched to ${describeEntry(chosen)}.`, "success");
    },
    [config, pushSystem]
  );

  const handleModelPickerCancel = useCallback(() => {
    setModelPickerOpen(false);
  }, []);

  /** Records a finished request locally so the Logs tab has something true. */
  const noteRequest = useCallback((entry: Omit<RequestLogEntry, "id" | "at">) => {
    setRequestLogs(appendRequestLog(entry));
  }, []);

  const openAccount = useCallback((tab: AccountTab) => {
    setPaletteOpen(false);
    setAccountTab(tab);
  }, []);

  // Terminal width, tracked so the splash can centre and the footer can elide.
  const [termWidth, setTermWidth] = useState(() => process.stdout.columns || 80);
  useEffect(() => {
    const onResize = () => setTermWidth(process.stdout.columns || 80);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  /** Command palette contents. Grouped the way the reference groups them. */
  const commandRows: PaletteRow[] = useMemo(
    () => [
      { id: "model", label: "Switch model", accel: "ctrl+x m", group: "Suggested" },

      { id: "new", label: "New session", accel: "ctrl+x n", group: "Session" },
      { id: "sessions", label: "Switch session", accel: "ctrl+x l", group: "Session" },
      { id: "compact", label: "Compact context", group: "Session" },
      { id: "diff", label: "Open diff viewer", group: "Session" },
      { id: "export", label: "Export transcript", group: "Session" },

      { id: "model2", label: "Switch model", accel: "ctrl+x m", group: "Agent" },
      { id: "permission", label: "Cycle permissions", accel: "shift+tab", group: "Agent" },
      { id: "init", label: "Guided AGENTS.md setup", group: "Agent" },
      { id: "context", label: "Show context usage", group: "Agent" },

      { id: "keys", label: "API keys", group: "Account" },
      { id: "usage", label: "Usage", group: "Account" },
      { id: "logs", label: "Logs", group: "Account" },
      { id: "link", label: "Connect a provider", group: "Account" },

      { id: "themes", label: "Switch theme", group: "Appearance" },

      { id: "update", label: "Check for updates", group: "App" },
      { id: "doctor", label: "Run diagnostics", group: "App" },
      { id: "help", label: "Help", group: "App" },
      { id: "exit", label: "Exit the app", group: "App" },
    ],
    []
  );

  const themeRows: PaletteRow[] = useMemo(
    () => THEME_NAMES.map((name) => ({ id: name, label: name, current: name === activeThemeName() })),
    // activeThemeName() is read at build time, so this has to rebuild whenever
    // the saved scheme changes or the dot marks the wrong row.
    [config.theme]
  );

  /** Maps a palette row onto the same handlers the slash commands use. */
  const runPaletteAction = useCallback(
    (id: string) => {
      switch (id) {
        case "model":
        case "model2":
          return setModelPickerOpen(true);
        case "themes":
          return setThemePickerOpen(true);
        case "keys":
          return openAccount("keys");
        case "usage":
          return openAccount("usage");
        case "logs":
          return openAccount("logs");
        case "update":
          return void checkForUpdate(version).then((found) => {
            if (found) setUpdateOffer(found);
            else pushSystem(`Already on the latest version (v${version}).`);
          });
        default:
          // Everything else already exists as a slash command, so route through
          // the one implementation rather than duplicating it here.
          return void handleSubmit(`/${id}`);
      }
    },
    [openAccount, version, pushSystem, handleSubmit]
  );

  // Apply the saved scheme once on boot, then repaint whenever it changes.
  useEffect(() => {
    applyTheme(config.theme);
    return subscribeTheme(() => bumpTheme((n) => n + 1));
  }, [config.theme]);

  const chooseTheme = useCallback(
    (name: string) => {
      applyTheme(name);
      const next = { ...config, theme: activeThemeName() };
      setConfig(next);
      saveConfig(next);
    },
    [config]
  );

  // Offer an update once at startup. Deliberately after first paint and fully
  // best-effort: a registry that is slow or down must not delay the prompt.
  useEffect(() => {
    let cancelled = false;
    void checkForUpdate(version).then((found) => {
      if (!cancelled && found) setUpdateOffer(found);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const runUpdate = useCallback(async () => {
    if (!updateOffer) return;
    setUpdateBusy(true);
    const result = await performUpdate(updateOffer);
    setUpdateBusy(false);
    setUpdateOffer(null);
    pushSystem(result.message);
  }, [updateOffer, pushSystem]);

  // Global Ctrl+C (press twice to exit) — always active, alongside whichever
  // other input hook (Composer/PermissionPrompt/AutoModeConfirm) is live.
  useInput((input, key) => {
    // ctrl+p is the command palette. Suppressed while another overlay owns the
    // screen, so it can never stack two modals on top of each other.
    const overlayOpen =
      paletteOpen || themePickerOpen || accountTab !== null || updateOffer !== null || modelPickerOpen;
    if (key.ctrl && input === "p" && !overlayOpen && !pendingPermission && !pendingPlan) {
      setPaletteOpen(true);
      return;
    }
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1500) {
        persistCurrentSession();
        killAllBackgroundJobs();
        exit();
      } else {
        lastCtrlCRef.current = now;
        pushSystem("Press Ctrl+C again to exit.");
      }
    }
  });

  // A tool row starts pending and gets mutated in place once its result
  // lands (see runLoop's "tool_result" handler) — it must stay out of
  // <Static> (which never re-renders an item it already committed) until
  // that mutation has happened, or its final ✓/✗ never appears on screen.
  const isLive = (m: DisplayMessage) => (m.role === "assistant" && m.streaming) || (m.role === "tool" && m.pending);
  const completed = messages.filter((m) => !isLive(m));
  const live = messages.filter(isLive);
  const composerActive =
    !pendingPermission &&
    !pendingPlan &&
    !confirmingAuto &&
    !modelPickerOpen &&
    !paletteOpen &&
    !themePickerOpen &&
    accountTab === null &&
    updateOffer === null;

  const permLabel =
    permissionMode === "auto" ? "Auto" : permissionMode === "plan" ? "Plan" : "Ask";
  const permColor =
    permissionMode === "auto"
      ? PERMISSION_COLORS.auto
      : permissionMode === "plan"
        ? PERMISSION_COLORS.plan
        : theme.accent;
  // Rough context meter — assume a 128k window (honest about being approximate).
  const CONTEXT_WINDOW = 128_000;
  const contextPct = Math.min(99.9, Math.round((contextTokens / CONTEXT_WINDOW) * 1000) / 10);
  const editedFiles = (() => {
    const paths = new Set<string>();
    for (const m of messages) {
      if (
        m.role === "tool" &&
        (m.name === "write_file" || m.name === "edit_file") &&
        typeof m.args.path === "string"
      ) {
        paths.add(m.args.path);
      }
    }
    return paths.size;
  })();
  const modelLabel = model ? describeEntry(model) : catalogLoading ? "loading models…" : "no model — /model";
  const hasConversation = messages.some((m) => m.role === "user" || m.role === "assistant" || m.role === "tool");

  // First launch ever (no config file on disk yet): show the setup screen
  // instead of the normal app. The startup effect above is
  // still running regardless (catalog loading, banner queued) — it just
  // isn't on screen yet — so the moment this finishes, everything is
  // already warm.
  if (!welcomeDone) {
    return <WelcomeScreen version={version} platformSupportsLink={isLocalDiscoveryAvailable()} onLogin={handleLink} onFinish={finishWelcome} />;
  }

  return (
    <Box flexDirection="column">
      <Static key={historyEpoch} items={completed}>
        {(m, i) => (
          <ErrorBoundary key={m.id} label="A message couldn't be displayed">
            <MessageView
              message={m}
              separatorBefore={i > 0 && completed[i - 1]?.role === "tool" && m.role === "assistant"}
            />
          </ErrorBoundary>
        )}
      </Static>
      {live.map((m, i) => {
        const prev = i === 0 ? completed[completed.length - 1] : live[i - 1];
        return (
          <ErrorBoundary key={m.id} label="A message couldn't be displayed">
            <MessageView
              message={m}
              separatorBefore={!!prev && prev.role === "tool" && m.role === "assistant"}
            />
          </ErrorBoundary>
        );
      })}

      {statusText && (
        <Box>
          <Text color={theme.muted}>• {statusText}</Text>
        </Box>
      )}

      {(() => {
        void todoVersion;
        const todos = currentTodos();
        if (todos.length === 0 || todos.every((t) => t.status === "completed")) return null;
        const done = todos.filter((t) => t.status === "completed").length;
        return (
          <Box flexDirection="column" paddingLeft={0}>
            <Text color={theme.muted} dimColor>
              • Todos ({done}/{todos.length})
            </Text>
            {todos.map((t, i) => (
              <Text
                key={i}
                color={t.status === "completed" ? theme.muted : t.status === "in_progress" ? theme.accent : theme.assistant}
                strikethrough={t.status === "completed"}
                dimColor={t.status === "completed"}
              >
                {t.status === "completed" ? "  ✓ " : t.status === "in_progress" ? "  › " : "  · "}
                {t.content}
              </Text>
            ))}
          </Box>
        );
      })()}

      {pendingPlan !== null && (
        <PlanReview plan={pendingPlan} onAnswer={(approve) => planResolveRef.current?.(approve ? "approve" : "deny")} />
      )}
      {pendingPermission && (
        <PermissionPrompt name={pendingPermission.name} summary={pendingPermission.summary} detail={pendingPermission.detail} onAnswer={handlePermissionAnswer} />
      )}
      {confirmingAuto && <AutoModeConfirm onAnswer={handleAutoAnswer} />}
      {modelPickerOpen && (
        <ModelPicker models={catalog} currentKey={model?.key ?? null} onSelect={handleModelPickerSelect} onCancel={handleModelPickerCancel} />
      )}

      {paletteOpen && (
        <Palette
          title="Commands"
          rows={commandRows}
          onSelect={(id) => {
            setPaletteOpen(false);
            runPaletteAction(id);
          }}
          onCancel={() => setPaletteOpen(false)}
        />
      )}

      {themePickerOpen && (
        <Palette
          title="Themes"
          rows={themeRows}
          visible={18}
          initialId={activeThemeName()}
          /* Preview on highlight, the way the reference does — you judge a
             scheme by looking at it, not by reading its name. Cancelling
             restores whatever was saved. */
          onHighlight={(name) => applyTheme(name)}
          onSelect={(name) => {
            chooseTheme(name);
            setThemePickerOpen(false);
          }}
          onCancel={() => {
            applyTheme(config.theme);
            setThemePickerOpen(false);
          }}
        />
      )}

      {accountTab !== null && (
        <AccountView
          apiKey={resolveAquaApiKey(config) ?? ""}
          initialTab={accountTab}
          logs={requestLogs}
          onClose={() => setAccountTab(null)}
        />
      )}

      {updateOffer && (
        <ConfirmDialog
          title="Update Available"
          message={
            updateBusy
              ? `Updating to v${updateOffer.latest}…`
              : `A new release v${updateOffer.latest} is available. Would you like to update now?`
          }
          footnote={updateOffer.install.action}
          confirmLabel={updateOffer.install.canSelfUpdate ? "Confirm" : "Details"}
          onConfirm={() => void runUpdate()}
          onCancel={() => setUpdateOffer(null)}
        />
      )}

      {/* The wordmark stands in for an empty transcript, and gets out of the way
          the moment there is anything to read. */}
      {!hasConversation && (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Splash width={termWidth} />
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {isGenerating && <GenerationStatus />}
        {queuedMessages.length > 0 && (
          <Box flexDirection="column">
            {queuedMessages.map((q, i) => (
              <Text key={i} color={theme.muted} dimColor>
                ↓ queued · {q.length > 64 ? q.slice(0, 61) + "…" : q}
              </Text>
            ))}
          </Box>
        )}
        <Composer
          isActive={composerActive}
          history={submitHistory}
          onSubmit={handleSubmit}
          onTogglePermission={handleTogglePermission}
          onCancel={handleCancel}
          queryFiles={queryFiles}
          mode={mode}
          hasConversation={hasConversation}
          modeLabel={permLabel}
          modeColor={permColor}
          modelLabel={model ? model.display : catalogLoading ? "loading models…" : "no model — /model"}
          providerLabel={model ? providerLabelFor(model) : null}
        />
        {/* Mode and model moved inside the bar, so this row keeps only what it
            alone reports. It disappears entirely when there is nothing to say. */}
        {(contextTokens > 0 || editedFiles > 0) && (
          <Box paddingX={1}>
            <Text color={theme.mutedDim}>
              {contextTokens > 0 ? `context ${contextPct}%` : ""}
              {contextTokens > 0 && editedFiles > 0 ? " · " : ""}
              {editedFiles > 0 ? `${editedFiles} file${editedFiles === 1 ? "" : "s"} edited` : ""}
            </Text>
          </Box>
        )}
        <Hints />
        <Footer projectRoot={projectRoot} version={`v${version}`} width={termWidth} />
      </Box>
    </Box>
  );
}
