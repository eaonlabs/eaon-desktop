#!/bin/sh
# Claude Code runs this before each Bash tool call, with the call as JSON on
# stdin. Exit code 2 blocks the call; what's printed on stderr goes back to
# Claude as the reason, so it can ask you instead. Anything else lets it run.
#
# Only a few commands that are hard to undo are stopped:
#   rm -r of /, ~, $HOME or /*; a force push (--force-with-lease still works);
#   git reset --hard; git clean -f with -d or -x; mkfs; dd onto a disk;
#   chmod -R 777 /; a fork bomb.

input=$(cat)
# The command string from {"tool_input":{"command":"..."}}, close enough for matching.
cmd=$(printf '%s' "$input" | tr '\n' ' ' | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p')
[ -n "$cmd" ] || cmd=$input

block() {
  echo "Blocked by the Guardrails mod: $1. If you really mean to, ask the user to run it themselves." >&2
  exit 2
}

has() { printf '%s' "$cmd" | grep -Eq -- "$1"; }

has 'rm[[:space:]]+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]+-[a-zA-Z-]+)*[[:space:]]+(/|/\*|~|~/|\$HOME|\$\{HOME\})(["'"'"'[:space:];&|]|$)' && block 'it deletes everything under / or your home folder'
has 'git[[:space:]]+push([[:space:]]+[^;&|]*)?[[:space:]](--force|-f)([[:space:];&|"]|$)' && block 'a force push rewrites history on the remote (use --force-with-lease if you must)'
has 'git[[:space:]]+push([[:space:]]+[^;&|]*)?[[:space:]]\+[A-Za-z0-9_./-]+' && block 'a +branch push is a force push'
has 'git[[:space:]]+reset[[:space:]]+([^;&|]*[[:space:]])?--hard' && block 'git reset --hard throws away uncommitted work'
has 'git[[:space:]]+clean[[:space:]]+(-[a-zA-Z]*f[a-zA-Z]*[dx]|-[a-zA-Z]*[dx][a-zA-Z]*f)' && block 'git clean -fd deletes untracked files for good'
has '(^|[[:space:];&|])mkfs(\.[a-z0-9]+)?[[:space:]]' && block 'mkfs formats a disk'
has '(^|[[:space:];&|])dd[[:space:]][^;&|]*of=/dev/' && block 'dd onto a device overwrites a disk'
has 'chmod[[:space:]]+-R[[:space:]]+0?777[[:space:]]+/([[:space:];&|]|$)' && block 'it opens every file on the computer to everyone'
has ':\(\)[[:space:]]*\{[[:space:]]*:[[:space:]]*\|[[:space:]]*:' && block 'that is a fork bomb'
exit 0
