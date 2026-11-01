/**
 * The environment the user's Claude Code runs in for Eaon: theirs, without
 * what would take it off their plan or over Eaon's choices, and naming Eaon.
 *
 * - A key (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) would win over their
 *   sign-in and be charged per use; `CLAUDE_CODE_SIMPLE` skips the sign-in.
 * - `CLAUDE_CODE_EFFORT_LEVEL` would override the effort picked in Eaon, and
 *   `MCP_TOOL_TIMEOUT` would cut off Eaon's tools while an approval waits.
 * - An Eaon started from inside a Claude Code session (a developer's
 *   terminal) doesn't pass that session on.
 */
const DROPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MCP_TOOL_TIMEOUT',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT'
]

export function claudeCodeEnv(base: Record<string, string | undefined>, clientVersion: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: `eaon/${clientVersion}` }
  for (const name of DROPPED) delete env[name]
  return env
}
