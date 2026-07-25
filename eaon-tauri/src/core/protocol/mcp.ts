// MCP plugins, frontend side — the cross-platform port of the Mac app's
// MCPConnectionStore prompt/parse machinery. The protocol itself lives in
// Rust (mcp.rs, driven through ipc.mcpCall); this builds the system-prompt
// tool catalog (same water-filling budget idea, same 6000-char hard cap),
// parses the model's `eaon:mcp server="…" tool="…"` fences, and formats the
// per-tool spec fed back on a failed call so the retry is informed.

import type { McpServer, McpToolInfo } from "../types";

/** Hard backstop on the whole catalog block — the exact failure this guards
 *  against (documented on macOS): enough connected servers silently grew the
 *  prompt past what a request could carry, and the model went mute. */
const MAX_CATALOG_CHARACTERS = 6000;

export interface McpToolParameter {
  name: string;
  type: string;
  isRequired: boolean;
  enumValues: string[];
  description: string | null;
}

/** Port of MCPTool.parameters — required first, so tail-truncation never
 *  drops a parameter the call can't succeed without. */
export function toolParameters(tool: McpToolInfo): McpToolParameter[] {
  const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const keys = Object.keys(properties).sort((a, b) => {
    const ra = required.has(a), rb = required.has(b);
    if (ra !== rb) return ra ? -1 : 1;
    return a.localeCompare(b);
  });
  return keys.map((key) => {
    const prop = properties[key] ?? {};
    return {
      name: key,
      type: typeof prop.type === "string" ? prop.type : "any",
      isRequired: required.has(key),
      enumValues: Array.isArray(prop.enum) ? prop.enum.map(String) : [],
      description: typeof prop.description === "string" ? prop.description : null,
    };
  });
}

/** Port of MCPTool.detailedSpec — fed back to the model when a call fails. */
export function detailedSpec(tool: McpToolInfo): string {
  const params = toolParameters(tool);
  if (!params.length) return `${tool.name} takes no arguments — use {} as the body.`;
  const lines = params.map((p) => {
    let line = `  ${p.name} (${p.type}${p.isRequired ? ", required" : ""})`;
    if (p.enumValues.length) line += ` — one of: ${p.enumValues.slice(0, 12).join(" | ")}`;
    if (p.description) {
      const d = p.description.replace(/\n/g, " ");
      line += ` — ${d.length > 140 ? d.slice(0, 140) + "…" : d}`;
    }
    return line;
  });
  return `Parameters for ${tool.name}:\n${lines.join("\n")}`;
}

/** Port of MCPTool.exampleArgumentsJSON — a valid body covering every
 *  required parameter with a type-appropriate placeholder. */
export function exampleArgumentsJSON(tool: McpToolInfo): string {
  const req = toolParameters(tool).filter((p) => p.isRequired);
  if (!req.length) return "{}";
  const fields = req.map((p) => {
    let value: string;
    if (p.enumValues.length) value = JSON.stringify(p.enumValues[0]);
    else if (p.type === "number" || p.type === "integer") value = "1";
    else if (p.type === "boolean") value = "true";
    else if (p.type === "array") value = "[]";
    else if (p.type === "object") value = "{}";
    else value = '"example"';
    return `"${p.name}": ${value}`;
  });
  return `{${fields.join(", ")}}`;
}

/** One tool's one-line catalog entry: name(params) — description. */
function toolLine(tool: McpToolInfo): string {
  const params = toolParameters(tool)
    .map((p) => {
      let piece = p.name;
      if (p.enumValues.length) piece += `: ${p.enumValues.slice(0, 6).map((v) => `"${v}"`).join("|")}`;
      if (!p.isRequired) piece += "?";
      return piece;
    })
    .join(", ");
  let line = `- ${tool.name}(${params})`;
  if (tool.description) {
    const d = tool.description.replace(/\n/g, " ").trim();
    line += ` — ${d.length > 110 ? d.slice(0, 110) + "…" : d}`;
  }
  return line;
}

/** One server's catalog section within `budget` — overflow tools are listed
 *  name-only rather than dropped (still callable, still discoverable). The
 *  name list itself is budgeted too: with hundreds of tools it would
 *  otherwise cost more than the descriptions it replaced. */
function serverSection(server: McpServer, tools: McpToolInfo[], budget: number): string {
  const header = `${server.name} (server id: ${server.id}):`;
  const lines: string[] = [];
  const overflow: string[] = [];
  let used = header.length;
  for (const tool of tools) {
    const line = toolLine(tool);
    if (used + line.length + 1 <= budget) {
      lines.push(line);
      used += line.length + 1;
    } else {
      overflow.push(tool.name);
    }
  }
  let section = [header, ...lines].join("\n");
  if (overflow.length) {
    // The names line must fit INSIDE the same budget — a floor here is
    // exactly how the catalog once silently outgrew its cap.
    const prefix = "\nAlso available (call the same way): ";
    const room = budget - section.length - prefix.length;
    if (room > 12) {
      let names = overflow.join(", ");
      if (names.length > room) names = names.slice(0, room - 1) + "…";
      section += prefix + names;
    }
  }
  return section;
}

/** The truncation last resort — port of the Mac hardCapped: everything
 *  above degrades gracefully per server first; this is the actual hard
 *  guarantee that the catalog can never exceed the cap (the note itself
 *  fits INSIDE the cap, not after it). */
const TRUNCATION_NOTE = "\n…(tool list truncated for length — ask what else is available if you need a tool not listed here)";

function hardCapped(text: string): string {
  if (text.length <= MAX_CATALOG_CHARACTERS) return text;
  const budgetForText = Math.max(0, MAX_CATALOG_CHARACTERS - TRUNCATION_NOTE.length);
  return text.slice(0, budgetForText) + TRUNCATION_NOTE;
}

/** Port of agentInstructionBlock — the fence teaching, one worked example
 *  from a REAL connected tool, and the fairly-budgeted catalog. Null when
 *  nothing usable is connected. */
export function mcpInstructionBlock(
  entries: Array<{ server: McpServer; tools: McpToolInfo[] }>
): string | null {
  const usable = entries.filter((e) => e.tools.length > 0);
  if (!usable.length) return null;

  // Water-filling: settle smallest-need first so a small server is never
  // truncated just because a big one is connected alongside it.
  const full = usable
    .map((e) => ({ ...e, fullText: serverSection(e.server, e.tools, Number.MAX_SAFE_INTEGER) }))
    .sort((a, b) => a.fullText.length - b.fullText.length);
  let remainingBudget = MAX_CATALOG_CHARACTERS;
  let remainingCount = full.length;
  const settled = new Map<string, string>();
  for (const entry of full) {
    const fairShare = Math.floor(remainingBudget / Math.max(1, remainingCount));
    const text = entry.fullText.length <= fairShare ? entry.fullText : serverSection(entry.server, entry.tools, fairShare);
    settled.set(entry.server.id, text);
    // The actual produced length plus the "\n\n" joiner — both real cost.
    remainingBudget -= text.length + 2;
    remainingCount -= 1;
  }
  const sections = usable.map((e) => settled.get(e.server.id) ?? "");

  const names = usable.map((e) => e.server.name).join(", ");

  let example = "";
  const first = usable[0];
  const exampleTool = first.tools.find((t) => toolParameters(t).some((p) => p.isRequired)) ?? first.tools[0];
  if (exampleTool) {
    example = `\n\nFor example, this is a complete, correctly-formed call of ${exampleTool.name} on ${first.server.name}:\n\n\`\`\`eaon:mcp server="${first.server.id}" tool="${exampleTool.name}"\n${exampleArgumentsJSON(exampleTool)}\n\`\`\``;
  }

  return `You can act on the user's connected services through tools. The connected services are exactly: ${names}. No other outside service is connected. To call a tool, use a fenced block naming both the service and the tool:

\`\`\`eaon:mcp server="<server id>" tool="<tool name>"
{"key": "value"}
\`\`\`

The block body must be valid JSON with the tool's arguments, using exactly the parameter names listed for that tool below (or an empty {} for a tool with no parameters). Always close the fence with \`\`\` on its own line. After your reply, any eaon:mcp calls execute and their results come back to you in a message beginning "[Tool results". You then continue — this loops until you reply with no tool calls. If a call fails, the error tells you the tool's exact parameters — fix the call and try again. Once the results answer the user's question, ALWAYS finish with a plain-language reply telling the user what you found — never end the conversation on a tool call or raw results. Only call a tool when the user's request genuinely needs it: these are real accounts and not sandboxed (they can create records, send messages, deploy changes, spend money), so never call one speculatively or "just to check."${example}

Connected services and their tools (parameters in parentheses; values shown in quotes are the only accepted values):
${hardCapped(sections.join("\n\n"))}`;
}

export interface McpCall {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  parseError?: string;
}

/** Extract every \`\`\`eaon:mcp server="x" tool="y" fence. */
export function parseMcpCalls(text: string): McpCall[] {
  const calls: McpCall[] = [];
  const fence = /```[^\S\n]*eaon:mcp[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const header = text.slice(m.index, m.index + m[0].indexOf("\n"));
    const serverId = header.match(/server\s*=\s*"([^"]+)"/)?.[1] ?? "";
    const tool = header.match(/tool\s*=\s*"([^"]+)"/)?.[1] ?? "";
    const body = m[1].trim();
    let args: Record<string, unknown> = {};
    let parseError: string | undefined;
    if (body) {
      try {
        args = JSON.parse(body);
      } catch (e) {
        parseError = String(e);
      }
    }
    calls.push({ serverId, tool, args, parseError });
  }
  return calls;
}

/** Remove executed mcp fences from the visible reply. */
export function stripMcpFences(text: string): string {
  return text
    .replace(/```[^\S\n]*eaon:mcp[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
