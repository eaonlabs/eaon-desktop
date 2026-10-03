---
title: Composer "/" and "@" menus, and @mentioning workers
tags: [eaon-desktop, composer, workers, plugins, gotcha]
created: 2026-10-02T02:58:43.862Z
updated: 2026-10-02T02:58:43.862Z
---

Since Oct 2 2026 both composers (Chat's `Composer.tsx` and a worker's `workers/WorkerComposer.tsx`) have typeahead menus: "/" for commands and "@" for mentions. The shared pieces are in `components/composer/`:
- `suggest.ts` holds the pure helpers (`findTrigger`, `rankItems`, `replaceTrigger`, `removeMention`), tested in `test/composerSuggest.test.ts`.
- `SuggestMenu.tsx` holds the `useSuggest` hook and the list.
- `sources.tsx` builds the rows both composers share (plugins, tools, skills, permission levels).

## Decisions
- **Each row does what the same + menu row does.** The menus are a faster way in, not a second set of switches. Plugins are on or off everywhere, never per chat, so "@Notion" switches the plugin on if it was off, leaves `@Notion` in the text so the agent knows which one the user means, and shows a chip while that word is still in the text (`liveMentions`).
- **A skill picked from "/" is written into the message as `Use the <name> skill:`.** It isn't hidden state. The agent's skill guidance then loads it, and the user sees exactly what was asked.
- **There is no "@worker" in Chat.** Workers are their own tab.
- **Workers' + menu is Chat's minus Swarm and Plan.** Workers coordinate with each other instead of spawning helpers, and a plan would wait on an approval nobody gives in an unattended run. That's the same reason `runner.ts` forces `work: { swarm: false, plan: false }`. The worker's menu offers:
  - Goal, which sends `options.goal` so `engine.send` sets `worker.goal`;
  - its own browser, shown only once it has opened one;
  - computer use and plugins, both global, as in Chat;
  - Permissions, which edits the worker's own `access` through `workers.save`.

## @mentioning a colleague in Workers
`engine.send` parses `@Name` from the text with `mentionedWorkers` in `shared/workers.ts`. The match is whole-word, case-insensitive, longest name first, and never the worker itself. Each mentioned colleague gets its own copy of the mail, with `via: { workerId, name }`, and its turn header reads `[From the user, in a message to Ada that @mentioned you]`. The worker being written to gets `mentions` and a line saying the others already have the message, so it doesn't forward it again. This is group-chat behaviour: the colleague hears it right away, instead of only if the first worker's model decides to pass it on with `message_worker`. Only `send` (the app's composer) routes this way. `receive` (chat-app guests, see [[Chat apps: Workers in Discord, Telegram and WhatsApp]]) doesn't, so a guest can't reach other workers by naming them. The engine side is in [[Eaon Workers engine: threads, heartbeats and mail]].

## Gotchas
- **Component CSS loads before the global sheets.** `main.tsx` imports `App` before `styles/*.css`, so a component's own CSS file comes first in the bundle, and a rule of the same specificity in `controls.css` beats it. `.suggest-menu { position: absolute }` lost to `.menu { position: fixed }`, and the menu sat off-screen: it was in the DOM but invisible in screenshots. Use `.menu.suggest-menu`, or any higher-specificity selector, when overriding a global class from a component stylesheet.
- **The menu is not a `Popover`.** A Popover lays a click-catcher over the whole window. That would swallow clicks in the text box and steal the typing flow. The list is rendered inside `.composer-stack` (`position: relative`), rows act on `mousedown` with `preventDefault`, and the textarea keeps focus.
- **Driving it over CDP:** `Input.insertText` triggers React's onChange (and the caret update), and `Input.dispatchKeyEvent` with `rawKeyDown` plus `key: 'Enter'` reaches the menu's key handling. See [[Driving the capture harness over CDP for scripted app states]].
