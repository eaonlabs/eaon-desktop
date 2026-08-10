// What's actually rendered on screen — distinct from Turn (types.ts), which
// is what gets sent to the provider. A tool_call_requested/tool_result pair
// collapses into ONE display row that starts pending and fills in a result.

/** How a run of handleLink() (the /link flow) actually ended — shared
 * between the /link command (which only cares about side effects) and
 * WelcomeScreen (which shows a closing status line matching the outcome). */
export type LinkOutcome = "linked" | "nothing_selected" | "nothing_found" | "cancelled" | "timed_out" | "no_platform_support" | "error";

export type DisplayMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; reasoning: string; streaming: boolean }
  | { id: string; role: "system"; text: string; tone: "info" | "error" | "success" }
  | {
      id: string;
      role: "tool";
      name: string;
      summary: string;
      detail?: string;
      args: Record<string, unknown>;
      pending: boolean;
      /** The agent-loop call id this row displays — results are matched
       * back to their row by this, never by tool name (two same-named
       * calls in one turn would otherwise collide). */
      callId?: string;
      result?: { isError: boolean; text: string };
    };
