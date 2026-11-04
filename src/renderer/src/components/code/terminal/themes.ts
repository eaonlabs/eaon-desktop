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
  | 'snow'
  | 'volcano'
  | 'deepsea'
  | 'lighthouse'
  | 'orbit'
  | 'lanterns'
  | 'jellyfish'
  | 'meadow'
  | 'mesa'
  | 'fireworks'
  | 'blackhole'
  | 'circuit'
  | 'koi'
  | 'train'
  | 'storm'
  | 'ufo'
  | 'neoncity'
  | 'satellite'
  | 'skywhale'
  | 'bamboo'
  | 'autumn'
  | 'launch'
  | 'mushrooms'
  | 'windmills'
  | 'beach'
  | 'zen'
  | 'moonbase'

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
  /**
   * Glass: the panes are frosted and see-through, so the wallpaper the app
   * shows (Settings → Appearance → See-through) is the terminals' backdrop.
   * Picking one turns see-through on.
   */
  glass?: boolean
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
    id: 'see-through',
    name: 'See-through',
    mode: 'dark',
    // The app keeps its own look: the point is the wallpaper, not new colours.
    app: null,
    scene: null,
    glass: true,
    blurb: 'Your wallpaper behind the terminals, through frosted glass',
    // Bright and a touch saturated, so text holds up over whatever picture is behind it.
    colors: palette('#0c0c10', '#f5f5f7', ['#2a2a33', '#ff7a85', '#7ee2a8', '#ffd479', '#7cb7ff', '#d39bff', '#6fe3e3', '#e6e6ea', '#8a8a96', '#ff9aa3', '#9df0bf', '#ffe29e', '#a3cdff', '#e2b8ff', '#98eded', '#ffffff'], {
      cursor: '#ffffff',
      selection: '#7cb7ff55'
    })
  },
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
    id: 'iceberg',
    name: 'Iceberg',
    mode: 'dark',
    app: 'Glacier',
    scene: 'snow',
    blurb: 'Snow falling on the peaks, a cabin with its light on',
    colors: palette('#161821', '#c6c8d1', ['#1e2132', '#e27878', '#b4be82', '#e2a478', '#84a0c6', '#a093c7', '#89b8c2', '#c6c8d1', '#6b7089', '#e98989', '#c0ca8e', '#e9b189', '#91acd1', '#ada0d3', '#95c4ce', '#d2d4de'], { cursor: '#c6c8d1' })
  },
  {
    id: 'monokai',
    name: 'Monokai',
    mode: 'dark',
    app: 'Ember',
    scene: 'volcano',
    blurb: 'A volcano, lava running down its sides',
    colors: palette('#272822', '#f8f8f2', ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5'], { cursor: '#f8f8f0' })
  },
  {
    id: 'oceanic-next',
    name: 'Oceanic Next',
    mode: 'dark',
    app: 'Abyss',
    scene: 'deepsea',
    blurb: 'Under the sea: kelp, fish and bubbles in the light from above',
    colors: palette('#1b2b34', '#c0c5ce', ['#343d46', '#ec5f67', '#99c794', '#fac863', '#6699cc', '#c594c5', '#5fb3b3', '#c0c5ce', '#65737e', '#ec5f67', '#99c794', '#fac863', '#6699cc', '#c594c5', '#5fb3b3', '#d8dee9'], { cursor: '#c0c5ce' })
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    mode: 'dark',
    app: 'Cobalt',
    scene: 'lighthouse',
    blurb: 'A lighthouse sweeping the sea at night',
    colors: palette('#011627', '#d6deeb', ['#011627', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#ffffff', '#575656', '#ef5350', '#22da6e', '#ffeb95', '#82aaff', '#c792ea', '#7fdbca', '#ffffff'], { cursor: '#80a4c2' })
  },
  {
    id: 'palenight',
    name: 'Palenight',
    mode: 'dark',
    app: 'Indigo',
    scene: 'orbit',
    blurb: 'A ringed planet, its moons going round',
    colors: palette('#292d3e', '#a6accd', ['#292d3e', '#f07178', '#c3e88d', '#ffcb6b', '#82aaff', '#c792ea', '#89ddff', '#d0d0d0', '#434758', '#ff8b92', '#ddffa7', '#ffe585', '#9cc4ff', '#e1acff', '#a3f7ff', '#ffffff'], { cursor: '#ffcc00' })
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    mode: 'dark',
    app: 'Rosé Pine',
    scene: 'lanterns',
    blurb: 'Paper lanterns rising over still water',
    colors: palette('#191724', '#e0def4', ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'], { cursor: '#524f67' })
  },
  {
    id: 'moonlight',
    name: 'Moonlight',
    mode: 'dark',
    app: 'Plum',
    scene: 'jellyfish',
    blurb: 'Jellyfish drifting up through the dark',
    colors: palette('#222436', '#c8d3f5', ['#1b1d2b', '#ff757f', '#c3e88d', '#ffc777', '#82aaff', '#c099ff', '#86e1fc', '#828bb8', '#444a73', '#ff757f', '#c3e88d', '#ffc777', '#82aaff', '#c099ff', '#86e1fc', '#c8d3f5'], { cursor: '#c8d3f5' })
  },
  {
    id: 'horizon',
    name: 'Horizon',
    mode: 'dark',
    app: 'Rose',
    scene: 'fireworks',
    blurb: 'Fireworks over the city',
    colors: palette('#1c1e26', '#d5d8da', ['#16161c', '#e95678', '#29d398', '#fab795', '#26bbd9', '#ee64ac', '#59e1e3', '#d5d8da', '#5b5858', '#ec6a88', '#3fdaa4', '#fbc3a7', '#3fc4de', '#f075b5', '#6be4e6', '#d5d8da'], { cursor: '#e95678' })
  },
  {
    id: 'andromeda',
    name: 'Andromeda',
    mode: 'dark',
    app: 'Indigo',
    scene: 'blackhole',
    blurb: 'A black hole, its glowing disk swirling round it',
    colors: palette('#262a33', '#e5e5e5', ['#000000', '#cd3131', '#05bc79', '#e5e512', '#2472c8', '#bc3fbc', '#0fa8cd', '#e5e5e5', '#666666', '#cd3131', '#05bc79', '#e5e512', '#2472c8', '#bc3fbc', '#0fa8cd', '#e5e5e5'], { cursor: '#f8f8f0' })
  },
  {
    id: 'oxocarbon',
    name: 'Oxocarbon',
    mode: 'dark',
    app: 'Rose',
    scene: 'neoncity',
    blurb: 'Neon signs and flying cars over a city at night',
    colors: palette('#161616', '#f2f4f8', ['#161616', '#00dfdb', '#00b4ff', '#ff4297', '#00c15a', '#c693ff', '#ff74b8', '#f2f4f8', '#585858', '#00dfdb', '#00b4ff', '#ff4297', '#00c15a', '#c693ff', '#ff74b8', '#f2f4f8'], { cursor: '#ffffff' })
  },
  {
    id: 'poimandres',
    name: 'Poimandres',
    mode: 'dark',
    app: 'Glacier',
    scene: 'koi',
    blurb: 'Koi circling a pond between the lily pads',
    colors: palette('#1a1e28', '#a6accd', ['#1a1e28', '#d0679d', '#5de4c7', '#fffac2', '#89ddff', '#fcc5e9', '#add7ff', '#ffffff', '#a6accd', '#d0679d', '#5de4c7', '#fffac2', '#add7ff', '#fae4fc', '#89ddff', '#ffffff'], { cursor: '#ffffff' })
  },
  {
    id: 'nightfox',
    name: 'Nightfox',
    mode: 'dark',
    app: 'Tokyo Night',
    scene: 'train',
    blurb: 'A night train crossing the viaduct under the moon',
    colors: palette('#192330', '#cdcecf', ['#393b44', '#c94f6d', '#81b29a', '#dbc074', '#719cd6', '#9d79d6', '#63cdcf', '#dfdfe0', '#575860', '#d16983', '#8ebaa4', '#e0c989', '#86abdc', '#baa1e2', '#7ad5d6', '#e4e4e5'], { cursor: '#cdcecf' })
  },
  {
    id: 'tokyo-night-storm',
    name: 'Tokyo Night Storm',
    mode: 'dark',
    app: 'Tokyo Night',
    scene: 'storm',
    blurb: 'Lightning over the hills, and the rain coming down',
    colors: palette('#24283b', '#c0caf5', ['#1d202f', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#4e5575', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'], { cursor: '#c0caf5' })
  },
  {
    id: 'shades-of-purple',
    name: 'Shades of Purple',
    mode: 'dark',
    app: 'Synthwave',
    scene: 'ufo',
    blurb: 'A flying saucer over a farm, beaming up a cow',
    colors: palette('#1e1d40', '#ffffff', ['#000000', '#d90429', '#3ad900', '#ffe700', '#6943ff', '#ff2c70', '#00c5c7', '#c7c7c7', '#686868', '#f92a1c', '#43d426', '#f1d000', '#6871ff', '#ff77ff', '#79e8fb', '#ffffff'], { cursor: '#fad000' })
  },
  {
    id: 'cobalt2',
    name: 'Cobalt2',
    mode: 'dark',
    app: 'Abyss',
    scene: 'satellite',
    blurb: 'A satellite passing high over a blue planet',
    colors: palette('#132738', '#ffffff', ['#000000', '#ff0000', '#38de21', '#ffe50a', '#1460d2', '#ff005d', '#00bbbb', '#bbbbbb', '#555555', '#f40e17', '#3bd01d', '#edc809', '#5555ff', '#ff55ff', '#6ae3fa', '#ffffff'], { cursor: '#f0cc09' })
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    mode: 'dark',
    app: 'Catppuccin',
    scene: 'skywhale',
    blurb: 'A whale swimming slowly through the clouds',
    colors: palette('#24273a', '#cad3f5', ['#494d64', '#ed8796', '#a6da95', '#eed49f', '#8aadf4', '#f5bde6', '#8bd5ca', '#b8c0e0', '#5b6078', '#f2a7b2', '#bde3b0', '#f4e3c1', '#adc5f7', '#f493da', '#a5ded6', '#a5adcb'], { cursor: '#f4dbd6' })
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    mode: 'dark',
    app: 'Catppuccin',
    scene: 'aurora',
    blurb: 'Northern lights over the mountains',
    colors: palette('#303446', '#c6d0f5', ['#51576d', '#e78284', '#a6d189', '#e5c890', '#8caaee', '#f4b8e4', '#81c8be', '#b5bfe2', '#626880', '#eda0a2', '#b9dba2', '#ecd7ae', '#adc2f3', '#f38ed8', '#98d2ca', '#a5adce'], { cursor: '#f2d5cf' })
  },
  {
    id: 'kanagawa-dragon',
    name: 'Kanagawa Dragon',
    mode: 'dark',
    app: 'Kanagawa',
    scene: 'bamboo',
    blurb: 'Bamboo swaying in the mist, its leaves falling',
    colors: palette('#181616', '#c5c9c5', ['#0d0c0c', '#c4746e', '#8a9a7b', '#c4b28a', '#8ba4b0', '#a292a3', '#8ea4a2', '#c8c093', '#a6a69c', '#e46876', '#87a987', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#c5c9c5'], { cursor: '#c8c093' })
  },
  {
    id: 'melange',
    name: 'Melange',
    mode: 'dark',
    app: 'Sand',
    scene: 'autumn',
    blurb: 'Autumn leaves blowing off the maples',
    colors: palette('#292522', '#ece1d7', ['#34302c', '#bd8183', '#78997a', '#e49b5d', '#7f91b2', '#b380b0', '#7b9695', '#c1a78e', '#867462', '#d47766', '#85b695', '#ebc06d', '#a3a9ce', '#cf9bc2', '#89b3b6', '#ece1d7'], { cursor: '#ece1d7' })
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    mode: 'dark',
    app: 'Glacier',
    scene: 'circuit',
    blurb: 'Signals racing along a circuit board',
    colors: palette('#0d1117', '#e6edf3', ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'], { cursor: '#2f81f7' })
  },
  {
    id: 'everblush',
    name: 'Everblush',
    mode: 'dark',
    app: 'Moss',
    scene: 'mushrooms',
    blurb: 'Glowing mushrooms on the forest floor, spores rising',
    colors: palette('#141b1e', '#dadada', ['#232a2d', '#e57474', '#8ccf7e', '#e5c76b', '#67b0e8', '#c47fd5', '#6cbfbf', '#b3b9b8', '#464e50', '#ef7e7e', '#96d988', '#f4d67a', '#71baf2', '#ce89df', '#67cbe7', '#bdc3c2'], { cursor: '#dadada' })
  },
  {
    id: 'ayu-mirage',
    name: 'Ayu Mirage',
    mode: 'dark',
    app: 'Sand',
    scene: 'beach',
    blurb: 'The sun going down over the sea, a palm in the breeze',
    colors: palette('#1f2430', '#cccac2', ['#171b24', '#ed8274', '#87d96c', '#facc6e', '#6dcbfa', '#dabafa', '#90e1c6', '#c7c7c7', '#686868', '#f28779', '#d5ff80', '#ffd173', '#73d0ff', '#dfbfff', '#95e6cb', '#ffffff'], { cursor: '#ffcc66' })
  },
  {
    id: 'ayu',
    name: 'Ayu',
    mode: 'dark',
    app: 'Ember',
    scene: 'launch',
    blurb: 'A rocket on the pad, and every so often, liftoff',
    colors: palette('#0b0e14', '#bfbdb6', ['#11151c', '#ea6c73', '#7fd962', '#f9af4f', '#53bdfa', '#cda1fa', '#90e1c6', '#c7c7c7', '#686868', '#f07178', '#aad94c', '#ffb454', '#59c2ff', '#d2a6ff', '#95e6cb', '#ffffff'], { cursor: '#e6b450' })
  },
  {
    id: 'moonfly',
    name: 'Moonfly',
    mode: 'dark',
    app: 'Vantablack',
    scene: 'moonbase',
    blurb: 'A rover on the moon, the Earth hanging in the sky',
    colors: palette('#080808', '#bdbdbd', ['#323437', '#ff5454', '#8cc85f', '#e3c78a', '#80a0ff', '#cf87e8', '#79dac8', '#c6c6c6', '#949494', '#ff5189', '#36c692', '#c6c684', '#74b2ff', '#ae81ff', '#85dc85', '#e4e4e4'], { cursor: '#9e9e9e' })
  },
  {
    id: 'gruvbox-material',
    name: 'Gruvbox Material',
    mode: 'dark',
    app: 'Gruvbox',
    scene: 'windmills',
    blurb: 'Wind turbines turning on the hills at dusk',
    colors: palette('#282828', '#d4be98', ['#282828', '#ea6962', '#a9b665', '#d8a657', '#7daea3', '#d3869b', '#89b482', '#d4be98', '#7c6f64', '#ea6962', '#a9b665', '#d8a657', '#7daea3', '#d3869b', '#89b482', '#ddc7a1'], { cursor: '#d4be98' })
  },
  {
    id: 'vesper',
    name: 'Vesper',
    mode: 'dark',
    app: 'Sand',
    scene: 'zen',
    blurb: 'Raked sand round the stones of a zen garden, by moonlight',
    colors: palette('#101010', '#ffffff', ['#101010', '#f5a191', '#90b99f', '#e6b99d', '#aca1cf', '#e29eca', '#ea83a5', '#a0a0a0', '#7e7e7e', '#ff8080', '#99ffe4', '#ffc799', '#b9aeda', '#ecaad6', '#f591b2', '#ffffff'], { cursor: '#acb1ab' })
  },
  {
    id: 'material-ocean',
    name: 'Material Ocean',
    mode: 'dark',
    app: 'Glacier',
    scene: 'deepsea',
    blurb: 'Deep under the sea, fish passing through the light',
    colors: palette('#0f111a', '#8f93a2', ['#546e7a', '#ff5370', '#c3e88d', '#ffcb6b', '#82aaff', '#c792ea', '#89ddff', '#ffffff', '#546e7a', '#ff5370', '#c3e88d', '#ffcb6b', '#82aaff', '#c792ea', '#89ddff', '#ffffff'], { cursor: '#ffcc00' })
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
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    mode: 'light',
    app: 'Sand',
    scene: 'meadow',
    blurb: 'A meadow in the breeze, butterflies and all',
    colors: palette('#fbf1c7', '#3c3836', ['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836'], { cursor: '#3c3836', selection: '#d5c4a155' })
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    app: 'Solarized',
    scene: 'mesa',
    blurb: 'Desert mesas, cacti and a tumbleweed',
    colors: palette('#fdf6e3', '#586e75', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'], { cursor: '#586e75', selection: '#eee8d5aa' })
  },
  {
    id: 'flexoki-light',
    name: 'Flexoki Light',
    mode: 'light',
    app: 'Flexoki',
    scene: null,
    blurb: 'Colours alone, ink on paper',
    colors: palette('#fffcf0', '#100f0f', ['#100f0f', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#6f6e69', '#575653', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#b7b5ac'], { cursor: '#100f0f', selection: '#cecdc355' })
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    app: 'Cobalt',
    scene: 'circuit',
    blurb: 'Signals racing along a circuit board, by daylight',
    colors: palette('#ffffff', '#1f2328', ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'], { cursor: '#0969da' })
  },
  {
    id: 'kanagawa-lotus',
    name: 'Kanagawa Lotus',
    mode: 'light',
    app: 'Kanagawa',
    scene: 'koi',
    blurb: 'Koi turning under the lotus leaves',
    colors: palette('#f2ecbc', '#545464', ['#1f1f28', '#c84053', '#6f894e', '#77713f', '#4d699b', '#b35b79', '#597b75', '#545464', '#8a8980', '#d7474b', '#6e915f', '#836f4a', '#6693bf', '#624c83', '#5e857a', '#43436c'], { cursor: '#43436c' })
  },
  {
    id: 'tokyo-night-day',
    name: 'Tokyo Night Day',
    mode: 'light',
    app: 'Tokyo Night',
    scene: 'beach',
    blurb: 'A palm, the waves and the sun over the sea',
    colors: palette('#e1e2e7', '#3760bf', ['#e9e9ed', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#6172b0', '#a1a6c5', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#3760bf'], { cursor: '#3760bf', selection: '#99a7df88' })
  },
  {
    id: 'alabaster',
    name: 'Alabaster',
    mode: 'light',
    app: 'Graphite',
    scene: 'zen',
    blurb: 'A zen garden in the morning light',
    colors: palette('#f7f7f7', '#000000', ['#000000', '#aa3731', '#448c27', '#cb9000', '#325cc0', '#7a3e9d', '#0083b2', '#b7b7b7', '#777777', '#f05050', '#60cb00', '#f2af50', '#007acc', '#e64ce6', '#00aacb', '#f7f7f7'], { cursor: '#007acc', selection: '#bfdbfe88' })
  },
  {
    id: 'dawnfox',
    name: 'Dawnfox',
    mode: 'light',
    app: 'Rosé Pine',
    scene: 'windmills',
    blurb: 'Wind turbines turning over green hills',
    colors: palette('#faf4ed', '#575279', ['#575279', '#b4637a', '#618774', '#ea9d34', '#286983', '#907aa9', '#56949f', '#b2b6bd', '#5f5695', '#c26d85', '#629f81', '#eea846', '#2d81a3', '#9a80b9', '#5ca7b4', '#e6ebf3'], { cursor: '#575279', selection: '#d0d8d888' })
  },
  {
    id: 'melange-light',
    name: 'Melange Light',
    mode: 'light',
    app: 'Sand',
    scene: 'autumn',
    blurb: 'Maple leaves drifting down on an autumn afternoon',
    colors: palette('#f1f1f1', '#54433a', ['#e9e1db', '#c77b8b', '#6e9b72', '#bc5c00', '#7892bd', '#be79bb', '#739797', '#7d6658', '#a98a78', '#bf0021', '#3a684a', '#a06d00', '#465aa4', '#904180', '#3d6568', '#54433a'], { cursor: '#54433a' })
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
