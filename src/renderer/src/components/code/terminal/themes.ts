/**
 * The ADE's terminal themes: a full terminal palette each (the 16 ANSI
 * colours CLI agents draw with, so Claude Code, Codex and the rest recolour
 * with it), and most with a scene — a small animated pixel-art picture drawn
 * behind the terminal text (scenes.ts). Picked from the theme picker
 * (ThemePicker.tsx), which `/theme` typed in any pane opens.
 *
 * Palettes are the themes' published terminal colours. `eaon` is not a
 * palette: it follows the app's own appearance, as the ADE always has.
 *
 * Plain data, no DOM, so it can be tested without a window.
 */

export type SceneId =
  | 'forest'
  | 'aurora'
  | 'waves'
  | 'sakura'
  | 'synthwave'
  | 'rain'
  | 'digital'
  | 'stars'
  | 'embers'
  | 'clouds'
  | 'dunes'

export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  selection: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface TerminalTheme {
  id: string
  name: string
  mode: 'dark' | 'light'
  /** The picture behind the text, or null for colours alone. */
  scene: SceneId | null
  /** One line about the scene, for the picker. */
  blurb: string
  /** Null for `eaon`, which takes the app's own colours. */
  colors: TerminalColors | null
  /**
   * The app theme (lib/themes.ts) the whole app takes on with this one, in
   * this theme's mode: the colours follow, the scene stays in the terminals.
   * Null for `eaon`, which leaves the app as the person set it.
   */
  app: string | null
}

/** Sixteen ANSI colours in order: black, red, green, yellow, blue, magenta, cyan, white, then the bright eight. */
function palette(
  background: string,
  foreground: string,
  ansi: [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string],
  extra: { cursor?: string; selection?: string } = {}
): TerminalColors {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = ansi
  return {
    background,
    foreground,
    cursor: extra.cursor ?? foreground,
    selection: extra.selection ?? `${blue}55`,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite
  }
}

export const DEFAULT_THEME_ID = 'eaon'

export const TERMINAL_THEMES: TerminalTheme[] = [
  { id: 'eaon', name: 'Eaon', mode: 'dark', scene: null, blurb: 'The app’s own colours, light or dark as the app is', colors: null, app: null },
  {
    id: 'everforest',
    name: 'Everforest',
    mode: 'dark',
    app: 'Everforest',
    scene: 'forest',
    blurb: 'Firefly forest: fireflies drifting over the pines',
    colors: palette('#2d353b', '#d3c6aa', ['#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#7a8478', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#e4dcc8'], { cursor: '#a7c080' })
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    app: 'Nord',
    scene: 'aurora',
    blurb: 'Northern lights over snowy peaks',
    colors: palette('#2e3440', '#d8dee9', ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'], { cursor: '#88c0d0' })
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    mode: 'dark',
    app: 'Kanagawa',
    scene: 'waves',
    blurb: 'The great wave, rolling under a full moon',
    colors: palette('#1f1f28', '#dcd7ba', ['#16161d', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'], { cursor: '#c8c093' })
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    app: 'Tokyo Night',
    scene: 'rain',
    blurb: 'Rain on a city that never sleeps',
    colors: palette('#1a1b26', '#c0caf5', ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'], { cursor: '#c0caf5' })
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    mode: 'dark',
    app: 'Catppuccin',
    scene: 'stars',
    blurb: 'A quiet sky full of stars, and the odd shooting one',
    colors: palette('#1e1e2e', '#cdd6f4', ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'], { cursor: '#f5e0dc' })
  },
  {
    id: 'retro-82',
    name: 'Retro 82',
    mode: 'dark',
    app: 'Synthwave',
    scene: 'synthwave',
    blurb: 'Synthwave sun over a grid that never ends',
    colors: palette('#262335', '#f4eeff', ['#2a2139', '#fe4450', '#72f1b8', '#fede5d', '#36f9f6', '#ff7edb', '#36f9f6', '#e8dfff', '#848bbd', '#fe4450', '#72f1b8', '#fede5d', '#03edf9', '#ff7edb', '#03edf9', '#ffffff'], { cursor: '#ff7edb' })
  },
  {
    id: 'hackerman',
    name: 'Hackerman',
    mode: 'dark',
    app: 'Hackerman',
    scene: 'digital',
    blurb: 'Green code falling in the dark',
    colors: palette('#0a0e0a', '#62ff94', ['#0f1a10', '#ff4b4b', '#2eff6a', '#e6ff57', '#30b3ff', '#c770ff', '#00efff', '#b6f5b6', '#3d5c44', '#ff6b6b', '#62ff94', '#efff8a', '#5cc4ff', '#d699ff', '#5cf4ff', '#e6ffe6'], { cursor: '#2eff6a' })
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    mode: 'dark',
    app: 'Gruvbox',
    scene: 'embers',
    blurb: 'Embers rising from a campfire',
    colors: palette('#282828', '#ebdbb2', ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'], { cursor: '#fabd2f' })
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    app: 'Dracula',
    scene: 'stars',
    blurb: 'Night sky over the castle',
    colors: palette('#282a36', '#f8f8f2', ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'], { cursor: '#ff79c6' })
  },
  {
    id: 'osaka-jade',
    name: 'Osaka Jade',
    mode: 'dark',
    app: 'Osaka Jade',
    scene: 'forest',
    blurb: 'A jade forest at night, fireflies and all',
    colors: palette('#111c18', '#c1c497', ['#23372b', '#ff5345', '#549e6a', '#e5c736', '#509475', '#d2689c', '#2dd5b7', '#c1c497', '#53685b', '#ff6b5e', '#63b07a', '#ede068', '#63b38d', '#e38ab5', '#5ee3cb', '#e6e8c8'], { cursor: '#2dd5b7' })
  },
  {
    id: 'solarized',
    name: 'Solarized',
    mode: 'dark',
    app: 'Solarized',
    scene: 'dunes',
    blurb: 'Sand dunes under a low sun',
    colors: palette('#002b36', '#93a1a1', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#93a1a1', '#b58900', '#839496', '#6c71c4', '#2aa198', '#fdf6e3'], { cursor: '#93a1a1' })
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    mode: 'dark',
    app: 'One Dark',
    scene: null,
    blurb: 'Colours alone',
    colors: palette('#282c34', '#abb2bf', ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'], { cursor: '#61afef' })
  },
  {
    id: 'vantablack',
    name: 'Vantablack',
    mode: 'dark',
    app: 'Vantablack',
    scene: 'stars',
    blurb: 'Deep space, and very little else',
    colors: palette('#000000', '#d4d4d4', ['#000000', '#d75f5f', '#87af87', '#d7af87', '#87afd7', '#af87d7', '#87d7d7', '#d4d4d4', '#5a5a5a', '#e07a7a', '#a3c9a3', '#e3c39f', '#a3c4e3', '#c4a3e3', '#a3e3e3', '#ffffff'], { cursor: '#ffffff' })
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    mode: 'light',
    app: 'Rosé Pine',
    scene: 'sakura',
    blurb: 'Cherry blossom petals on the breeze',
    colors: palette('#faf4ed', '#575279', ['#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279', '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279'], { cursor: '#575279', selection: '#dfdad955' })
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    app: 'Catppuccin',
    scene: 'clouds',
    blurb: 'Clouds over green hills on a bright day',
    colors: palette('#eff1f5', '#4c4f69', ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'], { cursor: '#dc8a78' })
  },
  {
    id: 'flexoki-light',
    name: 'Flexoki Light',
    mode: 'light',
    app: 'Flexoki',
    scene: null,
    blurb: 'Colours alone, ink on paper',
    colors: palette('#fffcf0', '#100f0f', ['#100f0f', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#6f6e69', '#575653', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#b7b5ac'], { cursor: '#100f0f', selection: '#cecdc355' })
  }
]

export function findTheme(id: string | null | undefined): TerminalTheme {
  return TERMINAL_THEMES.find((theme) => theme.id === id) ?? TERMINAL_THEMES[0]
}

/* ------------------------------------------------------------------ colour */

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '').slice(0, 6)
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number]
}

/** `a` mixed toward `b` by `amount` (0 → a, 1 → b), as #rrggbb. */
export function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const at = (x: number, y: number): string =>
    Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, '0')
  return `#${at(ar, br)}${at(ag, bg)}${at(ab, bb)}`
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = rgb(hex).map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
