// Slash commands — pure request/outcome, no side effects here. The Ink App
// component (the one place that owns real state) interprets an Outcome and
// does the actual work (mutating state, hitting the network for /models or
// /init). Keeps the command table testable without a terminal.

import type { EaonMode, PermissionMode } from "../types.js";

export type SlashCommandOutcome =
  | { kind: "message"; text: string }
  | { kind: "set_mode"; mode: EaonMode }
  | { kind: "set_permission"; mode: PermissionMode }
  | { kind: "set_model"; query: string }
  | { kind: "open_model_picker" }
  | { kind: "open_themes" }
  | { kind: "open_account"; tab: "keys" | "usage" | "logs" }
  | { kind: "check_update" }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "list_models" }
  | { kind: "pull_model"; name: string }
  | { kind: "init_project" }
  | { kind: "resume"; sessionId?: string }
  | { kind: "cost" }
  | { kind: "link" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "compact" }
  | { kind: "context" }
  | { kind: "doctor" }
  | { kind: "show_config" }
  | { kind: "memory" }
  | { kind: "export"; path?: string }
  | { kind: "rewind"; checkpointId?: string }
  | { kind: "diff" }
  | { kind: "copy" }
  | { kind: "bashes" }
  | { kind: "error"; text: string };

export interface SlashCommandSpec {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  run: (argsText: string) => SlashCommandOutcome;
}

export const COMMANDS: SlashCommandSpec[] = [
  {
    name: "help",
    description: "Show available commands and keyboard shortcuts.",
    run: () => ({ kind: "help" }),
  },
  {
    name: "mode",
    description: "Eaon is one agent — use shift+tab for plan / sandboxed / auto.",
    usage: "/mode",
    run: (args) => {
      const wanted = args.trim().toLowerCase();
      if (!wanted || wanted === "agent" || wanted === "chat" || wanted === "claw" || "claw".startsWith(wanted)) {
        return {
          kind: "message",
          text: "Eaon is one agent now — there's no separate Chat mode. Use shift+tab (or /permission) to cycle plan · sandboxed · auto.",
        };
      }
      return {
        kind: "error",
        text: `"${wanted}" isn't used anymore. Eaon is one agent — try /permission plan|sandboxed|auto.`,
      };
    },
  },
  {
    name: "permission",
    aliases: ["perm"],
    description: "Show or set how much it can do unattended: plan, sandboxed, or auto.",
    usage: "/permission [plan|sandboxed|auto]",
    run: (args) => {
      const wanted = args.trim().toLowerCase();
      if (!wanted) return { kind: "message", text: "Usage: /permission plan | sandboxed | auto  (or press Shift+Tab to cycle).\n\n- plan: researches and proposes, changes nothing until you approve\n- sandboxed: asks before every change\n- auto: runs unattended" };
      if (wanted.startsWith("auto")) return { kind: "set_permission", mode: "auto" };
      if (wanted.startsWith("sand")) return { kind: "set_permission", mode: "sandboxed" };
      if (wanted.startsWith("plan")) return { kind: "set_permission", mode: "plan" };
      return { kind: "error", text: `"${wanted}" isn't a permission mode. Try: plan, sandboxed, auto.` };
    },
  },
  {
    name: "plan",
    description: "Switch to plan mode — it researches and proposes a plan, and changes nothing until you approve it.",
    run: () => ({ kind: "set_permission", mode: "plan" }),
  },
  {
    name: "rewind",
    description: "Undo file changes the agent made. With no argument, lists restore points.",
    usage: "/rewind [id]",
    run: (args) => ({ kind: "rewind", checkpointId: args.trim() || undefined }),
  },
  {
    name: "diff",
    description: "Show uncommitted git changes in this project.",
    run: () => ({ kind: "diff" }),
  },
  {
    name: "copy",
    description: "Copy the last reply to the clipboard.",
    run: () => ({ kind: "copy" }),
  },
  {
    name: "bashes",
    aliases: ["jobs"],
    description: "List background commands started by the agent.",
    run: () => ({ kind: "bashes" }),
  },
  {
    name: "model",
    description: "Switch the active model — opens a picker with no argument.",
    usage: "/model [name]",
    run: (args) => {
      const query = args.trim();
      if (!query) return { kind: "open_model_picker" };
      return { kind: "set_model", query };
    },
  },
  {
    name: "models",
    description: "List every model available right now (Aqua, BYOK, local Ollama).",
    run: () => ({ kind: "list_models" }),
  },
  {
    name: "pull",
    description: "Download a model with Ollama.",
    usage: "/pull <ollama-model-name>",
    run: (args) => {
      const name = args.trim();
      if (!name) return { kind: "error", text: "Usage: /pull <model-name>, e.g. /pull qwen3.6" };
      return { kind: "pull_model", name };
    },
  },
  {
    name: "init",
    description: "Scan this project and write EAON.md so the agent starts with real context next time.",
    run: () => ({ kind: "init_project" }),
  },
  {
    name: "clear",
    description: "Clear the on-screen conversation (starts a fresh session).",
    run: () => ({ kind: "clear" }),
  },
  {
    name: "new",
    description: "Same as /clear — start a fresh session.",
    run: () => ({ kind: "clear" }),
  },
  {
    name: "resume",
    aliases: ["sessions"],
    description: "Resume a previous session. With no name, lists recent sessions.",
    usage: "/resume [session-id]",
    run: (args) => ({ kind: "resume", sessionId: args.trim() || undefined }),
  },
  {
    name: "cost",
    aliases: ["usage"],
    description: "Show approximate usage for this session.",
    run: () => ({ kind: "cost" }),
  },
  {
    name: "link",
    description: "Open a browser to import from Eaon Desktop, or set / edit API keys, base URLs, and providers.",
    run: () => ({ kind: "link" }),
  },
  {
    name: "status",
    aliases: ["stats"],
    description: "Show session, model, and config status.",
    run: () => ({ kind: "status" }),
  },
  {
    name: "compact",
    description: "Summarize the conversation so far and continue with a fresh, smaller context.",
    run: () => ({ kind: "compact" }),
  },
  {
    name: "context",
    description: "Show how much of the model's context this session is using.",
    run: () => ({ kind: "context" }),
  },
  {
    name: "doctor",
    description: "Check your setup: Node, Ollama, Aqua key, config file.",
    run: () => ({ kind: "doctor" }),
  },
  {
    name: "config",
    description: "Show the config file path and current settings (keys redacted).",
    run: () => ({ kind: "show_config" }),
  },
  {
    name: "memory",
    description: "Open this project's EAON.md (project memory/instructions) in your editor.",
    run: () => ({ kind: "memory" }),
  },
  {
    name: "export",
    description: "Export this conversation as a Markdown file.",
    usage: "/export [path]",
    run: (args) => ({ kind: "export", path: args.trim() || undefined }),
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "Exit Eaon.",
    run: () => ({ kind: "exit" }),
  },
  {
    name: "themes",
    aliases: ["theme"],
    description: "Switch colour scheme.",
    run: () => ({ kind: "open_themes" }),
  },
  {
    name: "keys",
    description: "Show the API keys on your Eaon account.",
    run: () => ({ kind: "open_account", tab: "keys" }),
  },
  {
    name: "usage",
    description: "Tokens, requests and latency for your account.",
    run: () => ({ kind: "open_account", tab: "usage" }),
  },
  {
    name: "logs",
    description: "Requests made from this machine.",
    run: () => ({ kind: "open_account", tab: "logs" }),
  },
  {
    name: "account",
    description: "Account panel — keys, usage and logs.",
    run: (args) => {
      const wanted = args.trim().toLowerCase();
      if (wanted.startsWith("us")) return { kind: "open_account", tab: "usage" };
      if (wanted.startsWith("lo")) return { kind: "open_account", tab: "logs" };
      return { kind: "open_account", tab: "keys" };
    },
  },
  {
    name: "update",
    description: "Check for a newer Eaon CLI and install it.",
    run: () => ({ kind: "check_update" }),
  },
];

const COMMAND_INDEX = new Map<string, SlashCommandSpec>();
for (const cmd of COMMANDS) {
  COMMAND_INDEX.set(cmd.name, cmd);
  for (const alias of cmd.aliases ?? []) COMMAND_INDEX.set(alias, cmd);
}

/** Parses a leading "/name rest of the line" — returns null if `text`
 * doesn't start with a recognized command (so an ordinary message that
 * happens to start with "/" still sends normally). */
export function parseSlashCommand(text: string): { command: SlashCommandSpec; args: string } | null {
  if (!text.startsWith("/")) return null;
  const withoutSlash = text.slice(1);
  const spaceIndex = withoutSlash.search(/\s/);
  const name = (spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex)).toLowerCase();
  const command = COMMAND_INDEX.get(name);
  if (!command) return null;
  const args = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1);
  return { command, args };
}

export function matchingCommands(prefix: string): SlashCommandSpec[] {
  const lower = prefix.toLowerCase();
  const seen = new Set<SlashCommandSpec>();
  const results: SlashCommandSpec[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.name.startsWith(lower) && !seen.has(cmd)) {
      seen.add(cmd);
      results.push(cmd);
    }
  }
  return results;
}
