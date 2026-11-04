import { APP_CONTROL_CLI } from '@shared/appControl'
import { commandLines } from './commands'

/**
 * What an agent should read before using app control. The same text is the
 * `guide` command, what `eaon-apps guide` prints, and (shortened) the Work
 * prompt's note while the tool is offered.
 */

const LOOP = [
  'App control reads desktop apps through the accessibility tree (the one screen readers use) and acts on elements by ref. It never takes screenshots and never moves the pointer, so it works on apps in the background while the user keeps working.',
  '',
  'The loop: observe, act, verify.',
  '1. Observe. `snapshot` an app (its focused window by default). Start with `-i` (only what can be operated) or `--skeleton` (a shallow map), then drill into a branch with `--root <ref>`. `find` searches by role, name, text, value, id or state when you know what you want.',
  '2. Act on a ref: click, type, set-value, select, check, expand, scroll-to, menu, press. Refs look like @s4k2p9xq:e12; the part before the colon is the snapshot they came from.',
  '3. Verify. Every action returns the element as it is afterwards (`after`). A successful action does not prove the interface changed: check `after`, or `wait` for the text, window or state that should follow, before the next step.',
  '',
  'Refs go stale when their snapshot is dropped (the latest 48 are kept) or the element disappears; you get STALE_REF, so take a new snapshot. Never guess a ref.',
  'Prefer `menu --app X "File > Save"` over hunting for buttons, and `press` for keyboard shortcuts. `type` inserts at a field’s cursor; `set-value` replaces its whole value.',
  'Some elements can’t be operated through the tree (custom-drawn canvases, games). Pointer gestures (hover, drag, clicks at coordinates) refuse with NEEDS_POINTER; computer use does those. key-down, key-up, mouse-down and mouse-up are reserved and always refuse.',
  'Eaon itself, password managers and sign-in prompts are off limits (PROTECTED), and so are password fields: ask the user to do those steps.',
  'Ask before sending, purchasing or deleting anything.'
]

export function appControlGuide(): string {
  return [
    ...LOOP,
    '',
    `Commands (as \`${APP_CONTROL_CLI} <command>\` in a terminal; every command prints one JSON envelope {version, ok, command, data | error}):`,
    commandLines()
  ].join('\n')
}

/** Appended to the Work prompt while the tool is offered. Short: it is sent every turn. */
export function appControlPromptNote(): string {
  return [
    'App control (app_control): operate desktop apps through their accessibility tree, without screenshots or the pointer. Observe (snapshot -i, find), act on refs (click, type, select, menu, press), then verify from the returned `after` or with wait.',
    'Refs come only from snapshot, find, list-windows or list-surfaces, and go stale; never invent one. Prefer menu paths and keyboard shortcuts. Eaon, password managers and password fields are off limits. Ask before sending, buying or deleting anything.'
  ].join('\n')
}
