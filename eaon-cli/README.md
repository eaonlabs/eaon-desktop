# Eaon

An agentic coding agent that lives in your terminal. Give it a task, and it
reads your code, writes files, runs commands, and checks its own work — with
whatever model you want behind it, local or hosted.

```bash
npx eaon-cli
```

That's it. No install, no config file, no account.

## Install

```bash
npm install -g eaon-cli
```

Then run it from anywhere with:

```bash
eaon
```

Requires Node.js 18.17+.

## Bring your own model

Eaon isn't tied to one provider. It works with:

- **Local models** via [Ollama](https://ollama.com) — nothing leaves your
  machine. `/pull qwen3.6` to grab one, `/model` to switch.
- **Any OpenAI-compatible endpoint** — Groq, Together, OpenRouter, your own
  vLLM box. Add it to `~/.eaon/cli/config.json`.
- **Anthropic Messages** and **Google Gemini** native APIs.
- **Eaon Desktop** users on macOS: `/link` imports your keys and providers
  from the app automatically.

## How much rope it gets

Press **Shift+Tab** to cycle three modes:

| Mode | What it does |
| --- | --- |
| **Plan** | Researches and proposes a plan. Changes nothing until you approve it. The safe way to start something big. |
| **Sandboxed** | Asks before every change. The default. |
| **Auto** | Runs unattended. |

Plan mode is the one worth knowing about. Ask for something substantial, and
Eaon reads the actual code, searches the web where it's unsure, then comes
back with a concrete plan naming real files. Approve it and it carries the
whole thing out without stopping to ask you what's next.

## What it can actually do

- **Read and change code** — `read_file`, `write_file`, `edit_file`, `grep`,
  `glob`. It reads a file before editing it, so it never writes over
  something it hasn't seen.
- **Run things** — shell commands, plus `run_shell_background` for dev
  servers and long builds that shouldn't block the conversation.
- **Look things up** — real web search and page fetching, so it checks a
  library's current API instead of guessing from training data.
- **Delegate** — hands self-contained chunks of work to sub-agents and gets
  back a report, keeping its own context clear on big jobs.
- **Track its work** — a live todo list you can watch it work through.

## Undo

Eaon snapshots every file before it changes it.

```
/rewind          # list restore points
/rewind a1b2c3   # roll back to one
```

Covers files changed through its file tools (not changes made by shell
commands — use git for those).

## While it's working

- Type and press Enter to **queue** a message — it picks it up when the
  current work finishes, without derailing it.
- **Esc** interrupts.

## Input shortcuts

| Prefix | Does |
| --- | --- |
| `!npm test` | Run a shell command yourself; the output goes into context |
| `@src/app.ts` | Attach a file to your message (autocompletes) |
| `# always use pnpm` | Save a note to project memory (`EAON.md`) |
| `/help` | Every command |

## Commands

`/help` `/plan` `/permission` `/model` `/models` `/pull` `/init` `/clear`
`/resume` `/rewind` `/diff` `/copy` `/bashes` `/compact` `/context` `/cost`
`/link` `/status` `/doctor` `/config` `/memory` `/export` `/exit`

## Flags

```bash
eaon                              # interactive
eaon -c                           # continue the last session here
eaon -r <id>                      # resume a specific session
eaon --permission-mode plan       # start in plan mode
eaon -p "fix the failing test"    # one-shot, scriptable
eaon -p "..." --auto -m agent     # non-interactive agent run
```

## Project memory

Run `/init` and Eaon writes an `EAON.md` describing your project. It reads
that file at the start of every session in that directory, so conventions,
build commands and gotchas carry over. Add to it with `#` from the composer.

## Privacy

Your code goes to whichever model provider you configure — and nowhere else.
Point it at Ollama and nothing leaves your machine at all. `/link` reads
credentials from Eaon Desktop locally on macOS; no telemetry, no backend.

## License

MIT
