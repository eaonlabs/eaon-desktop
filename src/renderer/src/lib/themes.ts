import type { ThemePalette } from '@shared/types'

/** The four values a theme writes into settings for one appearance. */
export type Palette = Pick<ThemePalette, 'accent' | 'background' | 'foreground' | 'contrast'>

export interface ThemeTone extends Palette {
  /**
   * Share of the usual step the secondary text tones fade toward the
   * background (`--text-fade`, default 1). Not stored in settings — it belongs
   * to the theme, and `useTheme()` looks it up by preset name. Coloured
   * palettes put foreground and background closer together than the neutral
   * ones, so a full-strength fade would drop `--text-2` under WCAG AA; each
   * value here is the largest that keeps it at 4.5:1 on every surface
   * (test/themes.test.ts holds them to it).
   */
  textFade?: number
}

export interface Theme {
  name: string
  /**
   * Neutral themes keep a near-grey canvas and let the accent carry the colour;
   * coloured ones put the hue into the background and every surface mixed from it.
   */
  group: 'neutral' | 'coloured'
  light: ThemeTone
  dark: ThemeTone
}

/**
 * Every surface, border and text tone in the app is mixed from `--bg`, `--fg`
 * and `--contrast` (see tokens.css), so a theme only has to supply those four
 * values per appearance to restyle the whole interface.
 *
 * Dark backgrounds are the palette's *raised* layer, not its editor
 * background: tokens.css paints the canvas 22% darker than `--bg` and uses
 * `--bg` itself for the sidebar, so picking the raised tone lands the canvas on
 * (or very near) the palette's own base. Nord is the clearest case — Nord1
 * `#3B4252` as `--bg` puts the canvas on Nord0 `#2E3440`.
 *
 * Named themes use colours from their published palettes. Where a palette's
 * usual body-text colour would leave no room for a readable secondary tone, the
 * next stronger text colour from the same family stands in: Solarized base2 /
 * base02 rather than base0 / base00, Tokyo Night Light's ink rather than Day's
 * blue, Kanagawa lotusInk2 rather than lotusInk1, One Dark's highlight text.
 * Everforest Light's #5C6A72 is the one ink darkened along its own hue
 * (#434F56): at 4.9:1 it passes on its own, but any secondary tone faded from
 * it would not.
 */
export const THEMES: Theme[] = [
  {
    name: 'Cobalt',
    group: 'neutral',
    light: { accent: '#0A84FF', background: '#FFFFFF', foreground: '#1A1C1F', contrast: 45 },
    dark: { accent: '#0A84FF', background: '#111111', foreground: '#FCFCFC', contrast: 60 }
  },
  {
    name: 'Graphite',
    group: 'neutral',
    light: { accent: '#5A6472', background: '#F7F7F8', foreground: '#16181D', contrast: 38 },
    dark: { accent: '#8A93A0', background: '#0E0E10', foreground: '#F2F2F4', contrast: 52 }
  },
  {
    name: 'Glacier',
    group: 'neutral',
    light: { accent: '#4C7FA8', background: '#F6F8FA', foreground: '#16202A', contrast: 40 },
    dark: { accent: '#7FB3D5', background: '#0D1117', foreground: '#E8EFF5', contrast: 56 }
  },
  {
    name: 'Indigo',
    group: 'neutral',
    light: { accent: '#6355FF', background: '#FCFBFF', foreground: '#1A1830', contrast: 42 },
    dark: { accent: '#8B7DFF', background: '#100F1A', foreground: '#EFEDFA', contrast: 58 }
  },
  {
    name: 'Moss',
    group: 'neutral',
    light: { accent: '#2F9E68', background: '#FBFDFB', foreground: '#16201A', contrast: 40 },
    dark: { accent: '#3FBF7F', background: '#0F1411', foreground: '#EEF6F1', contrast: 58 }
  },
  {
    name: 'Ember',
    group: 'neutral',
    light: { accent: '#E4572E', background: '#FFFDFB', foreground: '#221A16', contrast: 42 },
    dark: { accent: '#FF6B3D', background: '#141010', foreground: '#F8F1EC', contrast: 64 }
  },
  {
    name: 'Rose',
    group: 'neutral',
    light: { accent: '#E0407A', background: '#FFFBFC', foreground: '#241419', contrast: 42 },
    dark: { accent: '#FF6B9A', background: '#150F12', foreground: '#F9EDF1', contrast: 60 }
  },
  {
    name: 'Sand',
    group: 'neutral',
    light: { accent: '#A97142', background: '#FBF7F0', foreground: '#22190F', contrast: 40 },
    dark: { accent: '#D9A066', background: '#14110C', foreground: '#F5EEE2', contrast: 56 }
  },

  /* ---- Coloured ---- */

  {
    // Snow Storm / Frost by day; Nord1 raised over Nord0 by night.
    name: 'Nord',
    group: 'coloured',
    light: { accent: '#5E81AC', background: '#ECEFF4', foreground: '#2E3440', contrast: 40, textFade: 0.75 },
    dark: { accent: '#88C0D0', background: '#3B4252', foreground: '#ECEFF4', contrast: 40, textFade: 0.63 }
  },
  {
    // Alucard (Dracula's official light variant) and Dracula.
    name: 'Dracula',
    group: 'coloured',
    light: { accent: '#644AC9', background: '#FFFBEB', foreground: '#1F1F1F', contrast: 42, textFade: 0.98 },
    dark: { accent: '#BD93F9', background: '#282A36', foreground: '#F8F8F2', contrast: 50, textFade: 0.93 }
  },
  {
    // Tokyo Night Day's paper with Tokyo Night Light's ink; Tokyo Night.
    name: 'Tokyo Night',
    group: 'coloured',
    light: { accent: '#2E7DE9', background: '#E1E2E7', foreground: '#343B58', contrast: 38, textFade: 0.58 },
    dark: { accent: '#7AA2F7', background: '#1A1B26', foreground: '#C0CAF5', contrast: 50, textFade: 0.77 }
  },
  {
    // Latte and Mocha.
    name: 'Catppuccin',
    group: 'coloured',
    light: { accent: '#8839EF', background: '#EFF1F5', foreground: '#4C4F69', contrast: 38, textFade: 0.4 },
    dark: { accent: '#CBA6F7', background: '#1E1E2E', foreground: '#CDD6F4', contrast: 50, textFade: 0.82 }
  },
  {
    name: 'Gruvbox',
    group: 'coloured',
    light: { accent: '#AF3A03', background: '#FBF1C7', foreground: '#3C3836', contrast: 40, textFade: 0.7 },
    dark: { accent: '#FE8019', background: '#282828', foreground: '#EBDBB2', contrast: 46, textFade: 0.8 }
  },
  {
    // base3 / base02 by day, base02 raised over base03 by night.
    name: 'Solarized',
    group: 'coloured',
    light: { accent: '#268BD2', background: '#FDF6E3', foreground: '#073642', contrast: 40, textFade: 0.84 },
    dark: { accent: '#268BD2', background: '#073642', foreground: '#EEE8D5', contrast: 44, textFade: 0.8 }
  },
  {
    // Dawn, and the main palette's surface raised over base.
    name: 'Rosé Pine',
    group: 'coloured',
    light: { accent: '#B4637A', background: '#FAF4ED', foreground: '#575279', contrast: 38, textFade: 0.34 },
    dark: { accent: '#EBBCBA', background: '#1F1D2E', foreground: '#E0DEF4', contrast: 50, textFade: 0.9 }
  },
  {
    // One Light and One Dark.
    name: 'One Dark',
    group: 'coloured',
    light: { accent: '#4078F2', background: '#FAFAFA', foreground: '#383A42', contrast: 40, textFade: 0.73 },
    dark: { accent: '#61AFEF', background: '#282C34', foreground: '#D7DAE0', contrast: 46, textFade: 0.73 }
  },
  {
    // Light medium, and Dark hard (bg0 #272E33 over bg_dim #1E2326).
    name: 'Everforest',
    group: 'coloured',
    light: { accent: '#35A77C', background: '#FDF6E3', foreground: '#434F56', contrast: 38, textFade: 0.49 },
    dark: { accent: '#A7C080', background: '#272E33', foreground: '#D3C6AA', contrast: 40, textFade: 0.57 }
  },
  {
    // Lotus and Wave.
    name: 'Kanagawa',
    group: 'coloured',
    light: { accent: '#4D699B', background: '#F2ECBC', foreground: '#43436C', contrast: 38, textFade: 0.49 },
    dark: { accent: '#7E9CD8', background: '#1F1F28', foreground: '#DCD7BA', contrast: 50, textFade: 0.82 }
  },

  /* For the ADE's terminal themes that have no app theme above (see
     components/code/terminal/themes.ts): picking one there restyles the app too. */
  {
    // Osaka Jade's light and dark palettes.
    name: 'Osaka Jade',
    group: 'coloured',
    light: { accent: '#17866F', background: '#F6F5DD', foreground: '#111C18', contrast: 40, textFade: 0.85 },
    dark: { accent: '#2DD5B7', background: '#172820', foreground: '#D4D7AE', contrast: 46, textFade: 0.75 }
  },
  {
    // Green phosphor: Matrix-style by night, a pale terminal green by day.
    name: 'Hackerman',
    group: 'coloured',
    light: { accent: '#1A7F37', background: '#EEF3EA', foreground: '#14301A', contrast: 40, textFade: 0.85 },
    dark: { accent: '#2EFF6A', background: '#0F1A10', foreground: '#B6F5B6', contrast: 50, textFade: 0.9 }
  },
  {
    // Black on white, and white on the blackest black.
    name: 'Vantablack',
    group: 'neutral',
    light: { accent: '#000000', background: '#FFFFFF', foreground: '#000000', contrast: 40, textFade: 1 },
    dark: { accent: '#E6E6E6', background: '#0A0A0A', foreground: '#EDEDED', contrast: 46, textFade: 1 }
  },
  {
    // Flexoki's paper and its night.
    name: 'Flexoki',
    group: 'coloured',
    light: { accent: '#205EA6', background: '#FFFCF0', foreground: '#100F0F', contrast: 40, textFade: 0.9 },
    dark: { accent: '#DA702C', background: '#1C1B1A', foreground: '#CECDC3', contrast: 46, textFade: 0.75 }
  },

  /* Originals, built in OKLCH around one hue each so the tones stay put as they
     lighten and darken. */
  {
    name: 'Abyss',
    group: 'coloured',
    light: { accent: '#1479B0', background: '#EFF9FD', foreground: '#0C2F52', contrast: 42, textFade: 0.87 },
    dark: { accent: '#43D5DC', background: '#0B263D', foreground: '#E1F2F8', contrast: 52, textFade: 0.93 }
  },
  {
    name: 'Forest',
    group: 'coloured',
    light: { accent: '#298646', background: '#F3F7E9', foreground: '#0A3723', contrast: 42, textFade: 0.84 },
    dark: { accent: '#90D281', background: '#102A1A', foreground: '#E8EFD8', contrast: 52, textFade: 0.9 }
  },
  {
    name: 'Plum',
    group: 'coloured',
    light: { accent: '#A8347F', background: '#FDF3FC', foreground: '#431D41', contrast: 42, textFade: 0.89 },
    dark: { accent: '#F38ABE', background: '#341832', foreground: '#F9E9F7', contrast: 52, textFade: 0.94 }
  },
  {
    name: 'Synthwave',
    group: 'coloured',
    light: { accent: '#D0268C', background: '#FBEEFE', foreground: '#341A62', contrast: 42, textFade: 0.89 },
    dark: { accent: '#F252A6', background: '#261547', foreground: '#FBECFF', contrast: 54, textFade: 0.98 }
  }
]
