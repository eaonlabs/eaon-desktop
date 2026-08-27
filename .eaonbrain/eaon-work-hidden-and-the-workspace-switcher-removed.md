---
title: Eaon Work hidden and the workspace switcher removed
tags: [eaon-desktop, eaon-work, workspaces, sidebar, ui]
created: 2026-08-26T01:44:14.640Z
updated: 2026-08-26T01:44:14.640Z
---

# Eaon Work hidden and the workspace switcher removed

User asked to "remove eaon work as a option for now and remove the selector for
now". Explicitly temporary, so this hides the product rather than deleting it —
everything in [[Eaon Work mode]] is still in the tree and still compiles.

## What changed

- **`store.ts` — `DEFAULT_WORKSPACES`** is now a single entry,
  `{ id: 'work', name: 'Eaon', kind: 'chat' }`.
- **`store.ts` — `migrateWorkspaces()`** rewritten. It used to force the
  canonical *two*; it now folds everything into the one chat workspace and
  forces `settings.activeWorkspaceId` to it. That second half matters: with no
  switcher, an install last left in Eaon Work would open to an empty chat list
  with no control to get out. Chats and projects in other workspaces get their
  `workspaceId` rewritten rather than dropped, same principle as the original
  migration.
- **`Sidebar.tsx`** — the `.workspace__button` (name + `ChevronDown`, opening
  `WorkspaceMenu`) is now a static `<span className="workspace__title">`.
  `WorkspaceMenu`, `WORKSPACE_DESCRIPTIONS`, `workspaceAnchor`,
  `workspaceMenu`, the `ChevronDown` import and the `Workspace` type import are
  gone. The search and bell buttons in `.workspace__actions` are untouched.
- **`app.css`** — `.workspace__button` → `.workspace__title`; dropped the
  `:hover` rule (a static label must not offer a click affordance) and folded
  the now-dead `.workspace__name`'s ellipsis rules into it. The old
  "optical padding" comment (`3px 3px 3px 6px`, compensating for empty space
  inside the chevron's SVG box — see [[Matching the Eaon Desktop Figma frames]])
  no longer applies without the chevron: plain `3px 6px` now, which with the
  container's `8px` keeps the label 14px from the sidebar edge, matching the
  nav rows.

## What deliberately did NOT change

Everything gated on `isWork` (`workspace?.kind === 'work'`) stays in place —
the Pull requests nav item, the "What should we build?" home hero and
suggestion cards, the project-folder bar, `localTools.ts`, the approval flow,
`setWorkspace`/`setWorkCwd` in the store, and `Workspace.kind`/`cwd` in the
types. `isWork` is simply always false now, so none of it renders. Restoring
the product should be: add the second entry back to `DEFAULT_WORKSPACES`,
revert the migration to the two-id canonical form, and put the button + menu
back in the sidebar header.

## Verified

Ran against the real user-data dir: `workspaces.json` went from two entries to
one, `activeWorkspaceId` stayed `work`, both existing chats survived with their
`workspaceId` intact (neither had ever lived in Eaon Work). Screenshotted the
result via the `EAON_CAPTURE` harness pointed at a throwaway
`--user-data-dir` — worth repeating, because that harness **resets chats and
projects**, so running it against the real dir to check a UI change would
destroy chat history. A backup of the store dir was taken first regardless.

**One thing was lost:** the Eaon Work workspace had a saved project folder,
`/Users/sanshraychada/Downloads/portfolio website`. Dropping the entry drops
that `cwd`; it's one re-pick when the product returns.

Links: [[Eaon Work mode]], [[Sidebar nav layout]]
