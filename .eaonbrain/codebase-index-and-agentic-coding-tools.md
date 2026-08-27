---
title: Codebase index and agentic coding tools
tags: [eaon-desktop, eaon-work, code-index, embeddings, agentic-coding, tools, rag]
created: 2026-08-22T20:02:01.440Z
updated: 2026-08-22T20:02:01.440Z
---

# Codebase index and agentic coding tools

Builds on [[Eaon Work mode]] (which added the workspace, three basic tools and
the approval round-trip). This note covers the Cursor-style indexing and the
expanded tool set that make Eaon Work actually code on its own.

## What the user asked for

"Give the models' agentic coding capabilities just like how Cursor has… index
files on the computer code by itself and make agentic decisions." So: semantic
codebase search plus enough tools and headroom to act without hand-holding.

## How Cursor actually works (researched, not assumed)

- Merkle tree of file hashes; only changed branches re-sync (~every 5–10 min).
- tree-sitter AST chunking, not fixed-size windows.
- Embeddings uploaded to a remote vector DB (Turbopuffer) under a per-codebase
  namespace, with **obfuscated** file paths; code itself is not stored remotely.
- At query time: embed query → ANN search → get obfuscated path + line range →
  **read the actual code from local disk** → send to the model.
- Agent tools: `codebase_search`, `grep_search`, `file_search`, `read_file`
  (250-line cap), `edit_file`, `list_dir`, `run_terminal_cmd`, `delete_file`.

## What Eaon does differently, and why

**The index is 100% local.** No remote vector store, so no path obfuscation is
needed either — that whole mechanism exists to make a *remote* index safe.
Eaon is BYOK and its premise is that nothing leaves the machine except calls to
the provider you chose; only chunk text of *changed* files is ever sent out, and
only to the embedding provider the user picked.

**No tree-sitter.** It is a native module and a rebuild burden on every Electron
bump. `DECLARATION_RE` in `codeIndex.ts` is a regex-per-language-family pass
finding function/class/type/impl openings across JS/TS, Python, Ruby, Go, Rust,
JVM, C-family, Swift, plus markdown headings. Verified it pulls real symbols
(`runLocalTool`, `localToolsFor`, `describeToolCall`) out of this repo's own
source. Chunks: boundary split → merge runs under 8 lines → hard-split over 90
lines with 6 lines of overlap so a symbol cut in half stays findable.

**Hash map, not a Merkle tree.** A tree's value is negotiating a diff with a
remote side; with a local index a flat `path → sha256` map plus one root hash
gives the same incremental benefit. Root hash equal → instant no-op.

**Hybrid retrieval, always.** Lexical scoring (symbols ×6, path ×3, body
log-scaled) runs *always*; vectors run when configured; results merge by
reciprocal-rank fusion. This is not just quality — it is what keeps the feature
working for Anthropic-only users, because **Anthropic has no embeddings API at
all**. Without the lexical path, `codebase_search` would be dead for them.

## Storage layout

`{userData}/code-index/{sha256(cwd).slice(0,16)}.json` — manifest (files,
chunks, hashes). Vectors go in a sibling `.bin` as raw Float32, because 30k
chunks × 1536 dims ≈ 180 MB and JSON/base64 handles that terribly. Vectors are
L2-normalized at write time so query-time cosine is a plain dot product.
`MAX_CHUNKS = 50_000` guards monorepos; the UI reports `truncated`.

## Tool set (localTools.ts)

Ten tools, gated on a project folder being set: `codebase_search`, `grep`,
`find_file`, `find_symbol`, `list_dir`, `read_file`, `edit_file`, `write_file`,
`delete_file`, `run_command`.

`edit_file` is exact-snippet search/replace and **refuses on 0 or 2+ matches**
with a message telling the model to add surrounding context. Research on edit
formats (Aider's benchmarks) says diff-style is right for strong models and far
cheaper than whole-file rewrites; the refusal matters because a silent
wrong-match edit is much worse than an error the model can recover from.

## Three changes in providers.ts that mattered more than the tools

1. **`MAX_TOOL_ROUNDS` was 8.** Nowhere near enough — search, read, edit, test,
   react is a dozen rounds by itself. Now `maxToolRounds(request)`: 8 for plain
   chat, `settings.codeIndex.maxToolRounds` (default 40, cap 200) when a cwd is
   set, exposed in Settings → Code index.
2. **Smart routing could delete the agent's hands.** `selectTools` scored *all*
   tools by keyword overlap and kept the top 20 — so a phrasing that didn't
   overlap `codebase_search`'s description could drop it. Now only MCP tools are
   routable; local coding tools are always appended.
3. **Approval gating keyed on `name !== 'read_file'`**, which would have
   prompted on every search/grep/list. Now `isMutatingTool()` — only
   edit/write/delete/run prompt.

Also: the thinking trace used to emit a bare `↳ toolName`. Now `toolTrace()` +
`describeToolCall()` add the query/path/command, so ThinkingSteps shows
"Edit src/main/store.ts" instead of ten identical lines.

## The system prompt is not optional

Tool *availability* does not make an agent. `workSystemPrompt(cwd)` in the
renderer store is what produces Cursor-like behavior: search before guessing,
read before editing, `edit_file` over `write_file`, verify with the project's
own test/build command, fix root causes, don't loop more than ~3 times on the
same failure, report honestly.

## Verified, not assumed

Bundled the real modules with esbuild (electron stubbed) and ran them against
this repo — 48 assertions green: chunking, gitignore/node_modules/lockfile
exclusion, incremental rebuild, path-escape refusal on `../`-style paths for
read *and* write, `edit_file` ambiguity refusal, all ten tool schemas.

Then a real embedding run against Ollama + `nomic-embed-text` (15 more
assertions): 768-dim vectors, magnitude 1.0000, related-pair similarity 0.61 vs
unrelated 0.40, 65 files → 495 chunks embedded in 24s, **no-op rebuild 24 ms**
(≈1000× — proves vector reuse). Semantic queries hit the right file, e.g.
"where do we encrypt API keys before saving them" → `src/main/secrets.ts`.

Two real bugs this caught:
- The no-op short-circuit called `getIndexStatus()`, which returns the live
  `lastStatus` while indexing — so it read back the *"indexing, 0 chunks"*
  status it had just published. Split out `statusFromDisk()`.
- A dead embedding provider failed the entire build, costing the user their
  whole index. Now caught: chunks are kept, the index is written lexical-only,
  and `status.error` explains why. Verified by killing Ollama mid-test.

Known, accepted: lexical fusion can inject a false positive (query "streaming
**tokens**…" surfaced `tokens.css` — CSS design tokens). The model gets ~12
hits and can judge; not worth over-tuning.

## Gotcha for future sessions

`codeIndex.ts` briefly contained a **literal NUL byte** — writing `'\0'` inside
a string put a raw 0x00 in the source, which makes `grep` treat the file as
binary and silently find nothing. Use `'\u0000'`. If grep ever mysteriously
matches nothing in a file that clearly contains the text, check for NUL bytes
with `python3 -c "print(open(f,'rb').read().count(b'\x00'))"`.
