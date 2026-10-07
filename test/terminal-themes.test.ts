import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feedInput, type LineState } from '../src/renderer/src/components/code/terminal/input'
import { contrast, DEFAULT_THEME_ID, findTheme, mix, TERMINAL_THEMES } from '../src/renderer/src/components/code/terminal/themes'

/**
 * The ADE's terminal themes (code/terminal/themes.ts) and the `/theme`
 * typed into a pane that opens their picker (code/terminal/input.ts).
 */

/** Types `text` a key at a time, the way xterm hands keystrokes over, ending with Enter. */
function type(text: string, start: LineState = ''): { line: LineState; command: string | null; erase: number; sent: string[] } {
  let line = start
  const sent: string[] = []
  let last = { line, command: null as string | null, erase: 0 }
  for (const key of [...text.split(''), '\r']) {
    const fed = feedInput(line, key)
    line = fed.line
    last = fed
    if (!fed.command) sent.push(key)
  }
  return { ...last, sent }
}

test('/theme and /themes typed at an empty prompt open the picker; the Enter never reaches the CLI', () => {
  for (const command of ['/theme', '/themes', '/Theme']) {
    const result = type(command)
    assert.equal(result.command, 'theme', command)
    assert.equal(result.erase, command.length, 'what the CLI saw is taken back')
    assert.ok(!result.sent.includes('\r'))
  }
})

test('anything else goes to the CLI as typed', () => {
  for (const text of ['/them', '/themex', 'set /theme', '/theme please', '/model', 'ls -la', '']) {
    assert.equal(type(text).command, null, JSON.stringify(text))
  }
})

test('a corrected line still counts, and Ctrl+U or Ctrl+C start the line again', () => {
  assert.equal(type('/themz\x7fe').command, 'theme', 'a backspace')
  let line: LineState = '/model'
  line = feedInput(line, '\x15').line
  assert.equal(type('/theme', line).command, 'theme', 'after Ctrl+U')
  line = feedInput('rm -rf', '\x03').line
  assert.equal(type('/theme', line).command, 'theme', 'after Ctrl+C')
})

test('focus and mouse reports from the terminal change nothing on the line', () => {
  // Claude Code turns on focus reporting: clicking into its pane sends ESC [ I first.
  assert.equal(type('/theme', feedInput('', '\x1b[I').line).command, 'theme')
  let line: LineState = feedInput('', '/the').line
  line = feedInput(line, '\x1b[O\x1b[I').line
  line = feedInput(line, '\x1b[<0;12;5M').line
  line = feedInput(line, '\x1b[M #!').line
  assert.equal(type('me', line).command, 'theme')
})

test('xterm’s own answers to a starting CLI change nothing, and Escape starts the line again', () => {
  for (const reply of ['\x1b[?62;22c', '\x1b[>0;276;0c', '\x1b[12;1R', '\x1b[?2026;2$y', '\x1b]11;rgb:1a1a/1b1b/2626\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\']) {
    assert.equal(type('/theme', feedInput('', reply).line).command, 'theme', JSON.stringify(reply))
  }
  // Escape, then /theme: what someone does after closing the CLI's own menu.
  assert.equal(type('/theme', feedInput(null, '\x1b').line).command, 'theme')
})

test('a line it cannot follow is never taken: arrow keys, history, a paste', () => {
  // ↑ recalls something from history: what is on the line is no longer known.
  assert.equal(type('/theme', feedInput('', '\x1b[A').line).command, null)
  let line: LineState = ''
  line = feedInput(line, '/the').line
  line = feedInput(line, '\x1b[D').line // ← moves the cursor
  line = feedInput(line, 'me').line
  assert.equal(feedInput(line, '\r').command, null)
  assert.equal(feedInput('', '\x1b[200~/theme\x1b[201~').line, null, 'a bracketed paste')
  assert.equal(feedInput('', '/theme\r').command, null, 'a pasted line with its newline is not a typed one')
  // The next Enter starts a clean line again.
  assert.equal(feedInput(null, '\r').line, '')
})

/**
 * The palettes are the themes' published ones and stay that way: someone who
 * picks Gruvbox wants Gruvbox's red, even at 2.7:1. So this holds them to
 * what matters: body text at WCAG AA, and no accent colour fading out.
 */
test('every theme reads: text on its background passes AA, and no ANSI colour fades into it', () => {
  for (const theme of TERMINAL_THEMES) {
    if (!theme.colors) continue
    const c = theme.colors
    assert.ok(contrast(c.foreground, c.background) >= 4.5, `${theme.name}: text ${contrast(c.foreground, c.background).toFixed(2)}:1`)
    for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      assert.ok(contrast(c[name], c.background) >= 2, `${theme.name} ${name}: ${contrast(c[name], c.background).toFixed(2)}:1`)
    }
  }
})

test('every palette is complete and well formed, and each theme says whether it is light', () => {
  const ids = new Set<string>()
  for (const theme of TERMINAL_THEMES) {
    assert.ok(!ids.has(theme.id), `duplicate id ${theme.id}`)
    ids.add(theme.id)
    if (!theme.colors) continue
    for (const [key, value] of Object.entries(theme.colors)) {
      assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${theme.name}.${key} = ${value}`)
    }
    const light = contrast(theme.colors.background, '#000000') > contrast(theme.colors.background, '#ffffff')
    assert.equal(theme.mode, light ? 'light' : 'dark', `${theme.name} is marked ${theme.mode}`)
  }
})

test('the default follows the app, and an unknown id falls back to it', () => {
  assert.equal(findTheme(DEFAULT_THEME_ID).colors, null)
  assert.equal(findTheme('no-such-theme').id, DEFAULT_THEME_ID)
  assert.equal(findTheme(undefined).id, DEFAULT_THEME_ID)
  assert.ok(TERMINAL_THEMES.filter((t) => t.scene).length >= 10, 'most themes come with a scene')
})

test('colour mixing for the scenes lands where it should', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000')
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff')
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
})

/* ------------------------------------------------------- the app follows the theme */

import { appearanceFor, previewFor, settingsFor } from '../src/renderer/src/components/code/terminal/appLook'
import { THEMES } from '../src/renderer/src/lib/themes'
import type { Settings } from '@shared/types'

const cobalt = { preset: 'Cobalt', accent: '#0A84FF', fontFamily: 'System default', fontWeight: 'Medium', translucentSidebar: true }
function settingsWith(over: Partial<Settings['ade']> = {}): Settings {
  return {
    appearance: {
      mode: 'system',
      light: { ...cobalt, background: '#FFFFFF', foreground: '#1A1C1F', contrast: 45 },
      dark: { ...cobalt, background: '#111111', foreground: '#FCFCFC', contrast: 60 },
      pointerCursors: false,
      reduceMotion: 'system',
      fontSize: 14,
      fontSmoothing: true,
      appIcon: 'default'
    },
    ade: { theme: 'eaon', scenes: true, appBefore: null, ...over }
  } as unknown as Settings
}

test('every terminal theme but Eaon names an app theme that exists', () => {
  for (const theme of TERMINAL_THEMES) {
    if (theme.id === DEFAULT_THEME_ID) assert.equal(theme.app, null)
    else assert.ok(THEMES.some((t) => t.name === theme.app), `${theme.name} → ${theme.app}`)
  }
})

test('picking a theme restyles the app in its mode, keeps what isn’t colour, and remembers the app’s own look', () => {
  const before = settingsWith()
  const saved = settingsFor(findTheme('nord'), before)
  const nord = THEMES.find((t) => t.name === 'Nord')!
  assert.equal(saved.ade?.theme, 'nord')
  assert.equal(saved.appearance?.mode, 'dark')
  assert.equal(saved.appearance?.dark.background, nord.dark.background)
  assert.equal(saved.appearance?.dark.preset, 'Nord')
  assert.equal(saved.appearance?.dark.fontWeight, 'Medium', 'the weight is the person’s, not the theme’s')
  assert.deepEqual(saved.ade?.appBefore, { mode: 'system', light: before.appearance.light, dark: before.appearance.dark })
  assert.equal(saved.appearance?.fontSize, 14)
  // A light terminal theme turns the app light.
  assert.equal(settingsFor(findTheme('rose-pine-dawn'), before).appearance?.mode, 'light')
})

test('a second theme keeps the first snapshot; Eaon puts the app’s own look back and forgets it', () => {
  const afterNord = { ...settingsWith(), ...settingsFor(findTheme('nord'), settingsWith()) } as Settings
  const afterGruvbox = { ...afterNord, ...settingsFor(findTheme('gruvbox'), afterNord) } as Settings
  assert.deepEqual(afterGruvbox.ade.appBefore, afterNord.ade.appBefore, 'still the look from before any terminal theme')
  const back = settingsFor(findTheme('eaon'), afterGruvbox)
  assert.equal(back.ade?.theme, 'eaon')
  assert.equal(back.ade?.appBefore, null)
  assert.equal(back.appearance?.mode, 'system')
  assert.equal(back.appearance?.dark.background, '#111111')
  // Eaon with nothing to put back leaves the app alone.
  assert.equal(settingsFor(findTheme('eaon'), settingsWith()).appearance, undefined)
})

test('the preview shows each theme’s app look, and for Eaon the app’s own', () => {
  const plain = settingsWith()
  assert.equal(previewFor(findTheme('dracula'), plain)?.dark.preset, 'Dracula')
  assert.equal(previewFor(findTheme('eaon'), plain), null, 'nothing to show but what is there')
  const themed = { ...plain, ...settingsFor(findTheme('nord'), plain) } as Settings
  assert.equal(previewFor(findTheme('eaon'), themed)?.dark.background, '#111111')
  assert.equal(appearanceFor(findTheme('eaon'), plain.appearance), null)
})
