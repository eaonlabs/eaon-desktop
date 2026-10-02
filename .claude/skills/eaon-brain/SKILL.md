---
name: eaon-brain
description: >-
  Project memory for this repository, shared by every agent session through the
  eaon-brain MCP tools (brain_search, brain_list, brain_read, brain_write,
  brain_link, brain_related). Use this skill at the start of any non-trivial
  task in this repo, before reading source files to work out how something
  behaves, and again before finishing once you have learned something worth
  keeping — an architectural decision and its reasoning, a convention, a
  non-obvious gotcha, or how a subsystem actually fits together. Also use it
  whenever asked to remember, record, note down, write up, upload, save, index,
  or look up what previous sessions figured out, and whenever you catch
  yourself about to rediscover something. Search the brain before you explore
  the source tree; upload what you learned to it before you hand back — every
  session, not just the ones that felt hard.
---

# Eaon Brain

This repository has a memory. It is plain markdown in `.eaonbrain/`, one file
per note, linked with `[[wiki links]]`, and reachable from any agent through
the `eaon-brain` MCP server. Everything written there outlives this session
and is read by whoever — or whatever — works here next.

That is the whole point. A coding session spends much of its budget
reconstructing things that were already worked out: why a module is shaped that
way, which of two plausible approaches was tried and abandoned, the one flag
that makes the build reproducible. None of that is in the code, most of it is
not in the commit log, and by default it dies when the session ends. The brain
is where it survives.

## Start by finding out what is already known

Before exploring the source tree for background, ask the brain. It is cheaper
than reading files and it carries reasoning that code cannot.

1. `brain_list` — the whole index, newest first, with tags and link counts.
   Read it when you arrive somewhere unfamiliar. It is short, and it tells you
   the shape of what is known and what the project calls things.
2. `brain_search` — for anything specific. Search **before** you grep. If the
   task touches auth, search "auth" first; a two-line note about the token
   refresh gotcha saves twenty minutes of reading.
3. `brain_read` — the full note, plus what it links to and what links back.
   Follow the links: neighbours are usually the context you did not know to
   ask for.
4. `brain_related` — backlinks plus notes that share vocabulary but are not
   linked yet. Use it when a note is nearly right but you suspect there is
   more.

A search that returns nothing is useful information too: it means this is
genuinely unexplored, and whatever you work out is worth writing down.

## Then work

Nothing about the brain changes how you do the task. Use it as context, verify
what it says against the code — notes can go stale, and a note that disagrees
with reality is worth fixing while you are here.

## Before you finish, upload what you learned

This is not a step for the sessions that happened to hit something hard. Do it
every time, including tasks that felt routine — the routine ones are exactly
where a useful convention or a quiet gotcha slips past unrecorded, because
nothing about doing them prompted a second thought. Ending a task without
checking is how the same rediscovery keeps happening to whoever works here next.

Ask yourself: *if a fresh session started this task tomorrow, what would I want
it to already know?* That answer is the note. Upload it with `brain_write`.
Writing an existing title updates that note rather than creating a second one,
so search first and prefer extending a good note over starting a near-duplicate.

### Worth recording

- **A decision and why** — including the option you rejected and what was wrong
  with it. The reasoning is the part that cannot be recovered from the diff.
- **How a subsystem actually behaves**, especially where it differs from how it
  looks. "The renderer never owns the terminal; it is re-attached on mount" is
  worth more than any amount of re-reading.
- **Conventions** the codebase follows but never states.
- **Gotchas that cost you time.** If you got something wrong once, the note
  stops the next session getting it wrong too. These are the highest-value
  notes in any brain.
- **Constraints from outside the code** — a platform limitation, an API that
  rate-limits, something that only reproduces on one machine.

### Not worth recording

- Task lists, progress, or what you did this session. The brain is not a log.
- Anything obvious from reading the code. A note that restates a function
  signature costs attention and earns nothing.
- Speculation you have not checked. A confident wrong note is worse than no
  note, because the next session will believe it.
- Secrets, tokens, or anything you would not commit — this folder is committed.

None of this is a reason to default to silence. These four are what to leave
out, not a bar so high that most sessions clear it; when a piece of what you
learned is genuinely borderline, upload it anyway. A note that turns out to be
obvious in hindsight costs one small file nobody has to reread; a fact nobody
wrote down costs the next session the same hour it just cost you.

## Indexing: how to write a note that gets found again

A memory nobody can find is the same as one that was never written. Three
things make a note findable.

**Title it as a thing, not as an event.** "Auth flow end to end" is findable
next month; "Fixed the login bug" is not, because nobody will search for it.
Short, specific, noun-shaped. The title is also the identity — writing the same
title again updates the note, which is how a note improves over time.

**Reuse the existing tag vocabulary.** Run `brain_list` and look at the tags
already in use before inventing one. `terminal` and `terminals` and `pty`
as three separate tags for the same idea is how an index stops working. Two or
three tags per note is plenty; tags are for grouping, not for describing.

**Link generously.** Write `[[Other Memory]]` inline, in the sentence where it
is relevant, so the link explains itself:

> Panes reattach on mount rather than re-rendering, which is why
> [[Terminals outlive React]] matters here.

Links are what turn a folder of notes into something you can explore. A note
with no links in or out is nearly invisible — if you write one, connect it to
something before you finish, with `brain_link` if a sentence does not fit.

Linking to a memory that does not exist yet is fine and useful: it records that
there is a gap, and the link resolves by itself the moment somebody writes it.
When `brain_write` reports unresolved links, treat them as a short list of
notes worth writing — not as an error.

## Building context for a big task

For anything spanning several parts of the system, spend the first minute
building a map instead of diving in:

1. `brain_list` for the index.
2. `brain_search` each area the task touches.
3. `brain_read` the two or three that matter, and follow their links.
4. Note the gaps — areas with nothing recorded. Those are where you should
   expect to be slow, and where your notes afterwards will be worth the most.

Then work, and when you finish, close the gaps you found.

## A worked example

You were asked to make agent sessions survive a restart. You searched, found
[[Restoring agent sessions across a restart]] already covers the transcript
side, read it, and discovered the missing piece is that the pty environment
must be rebuilt identically or the agent CLI re-authenticates. That is new, it
is not visible in the code, and it cost you an hour.

```
brain_write(
  title: "Rebuilding the pty environment on restore",
  tags: ["terminal", "process", "restore"],
  content:
    "A restored pane must be given the same environment as the original or the "
    "agent CLI treats it as a new machine and asks for auth again. The variables "
    "that matter are the config-dir override and PATH; everything else can drift.\n\n"
    "This is why restore reads the saved env rather than rebuilding it from the "
    "current process — see [[PTY environment]] for how it is assembled, and "
    "[[Restoring agent sessions across a restart]] for the rest of the flow."
)
```

Short, specific, links to its neighbours, and it says *why*. The next session
that touches restore will find it on the first search.

## Before you hand back

Last thing, every time, task felt hard or not: what did this session learn
that was not already in the brain? If genuinely nothing, fine — that happens.
If anything, upload it with `brain_write` before you consider the task done.
Not a closing courtesy after the real work — the other half of why searching
the brain was worth doing at the start, for whoever opens this project next.

<!-- eaon-brain-skill v4 -->
