// Named colour schemes.
//
// The palette used to be a single frozen object imported directly by ~20
// components. Rather than thread a context through all of them, `theme` (in
// theme.ts) stays one stable object identity whose fields are *reassigned* when
// the scheme changes, and App bumps a counter to force Ink to repaint. That is a
// deliberate trade: a mutable module-level palette is not how you would do this
// in a long-lived multi-tenant app, but this is one process rendering one
// terminal, and it keeps the switch to a one-line call instead of a 20-file
// refactor.
//
// Only foreground, accent and panel colours are themed. The terminal's own
// background stays whatever the user chose — repainting the full viewport would
// fight their terminal profile and leave artefacts wherever Ink doesn't draw.

export interface Theme {
  /** Primary accent: selection fill, focus bar, brand moments. */
  accent: string;
  /** Text drawn on top of an accent fill. Must contrast with `accent`. */
  accentFg: string;
  /** Softer accent for secondary emphasis. */
  accentSoft: string;
  /** Deep accent, used for wordmark depth. */
  accentDeep: string;

  /** Group headings inside modals. */
  heading: string;

  assistant: string;
  user: string;
  reasoning: string;
  toolName: string;

  success: string;
  error: string;
  warning: string;
  info: string;

  diffAdded: string;
  diffRemoved: string;
  diffAddedBg: string;
  diffRemovedBg: string;

  /** Secondary text. */
  muted: string;
  /** Tertiary text — chrome, footers, hints. */
  mutedDim: string;
  border: string;
  separator: string;

  /** Fill behind the composer and modal panels. */
  composerBg: string;
  /** Legacy alias some callers still reference. */
  composerBorder: string;

  /** The two greys the block wordmark alternates between. */
  wordmarkDim: string;
  wordmarkBright: string;
}

/**
 * `opencode` is the default and the one the reference screenshots show: quiet
 * greys, a blue mode label, and an apricot selection fill.
 */
const opencode: Theme = {
  accent: "#E8B48B",
  accentFg: "#1A1A1A",
  accentSoft: "#F0C9A8",
  accentDeep: "#8B5A38",
  heading: "#A78BFA",
  assistant: "#E8E8EE",
  user: "#C8C8D0",
  reasoning: "#7A7A88",
  toolName: "#E8E8EE",
  success: "#3FB950",
  error: "#FF6467",
  warning: "#E3B341",
  info: "#6FA8DC",
  diffAdded: "#B9E6C3",
  diffRemoved: "#F3B8BD",
  diffAddedBg: "#1C3A26",
  diffRemovedBg: "#42232A",
  muted: "#8A8A96",
  mutedDim: "#5C5C66",
  border: "#3A3A44",
  separator: "#3A3A44",
  composerBg: "#1C1C1C",
  composerBorder: "#454550",
  wordmarkDim: "#6E6E6E",
  wordmarkBright: "#EDEDED",
};

/** Shorthand: start from opencode and override what differs. */
const from = (base: Theme, over: Partial<Theme>): Theme => ({ ...base, ...over });

export const THEMES: Record<string, Theme> = {
  opencode,

  eaon: from(opencode, {
    accent: "#F0954F",
    accentFg: "#14100C",
    accentSoft: "#F7A765",
    accentDeep: "#8B3A28",
    heading: "#F0954F",
    info: "#6FA8DC",
    wordmarkBright: "#F5F5F5",
  }),

  "lucent-orng": from(opencode, {
    accent: "#E8562A",
    accentFg: "#150703",
    accentSoft: "#F07A50",
    accentDeep: "#8A2E12",
    heading: "#E8562A",
    muted: "#9A8378",
    mutedDim: "#6A5750",
    wordmarkDim: "#6B4A3C",
    wordmarkBright: "#F0E4DC",
  }),

  orng: from(opencode, {
    accent: "#FF8A3D",
    accentFg: "#180C02",
    accentSoft: "#FFA96B",
    accentDeep: "#8A4308",
    heading: "#FF8A3D",
    wordmarkDim: "#6B5540",
    wordmarkBright: "#FFF0E2",
  }),

  matrix: from(opencode, {
    accent: "#7BFF7B",
    accentFg: "#001400",
    accentSoft: "#A8FFA8",
    accentDeep: "#1F6B1F",
    heading: "#5BE05B",
    assistant: "#8FFF8F",
    user: "#6FDF6F",
    reasoning: "#3E8E3E",
    toolName: "#8FFF8F",
    muted: "#4FBF4F",
    mutedDim: "#2E7A2E",
    border: "#1F5F1F",
    separator: "#1F5F1F",
    info: "#7BFF7B",
    composerBg: "#0A160A",
    wordmarkDim: "#2E7A2E",
    wordmarkBright: "#8FFF8F",
  }),

  tokyonight: from(opencode, {
    accent: "#7AA2F7",
    accentFg: "#11121D",
    accentSoft: "#A6C0FB",
    accentDeep: "#3D59A1",
    heading: "#BB9AF7",
    assistant: "#C0CAF5",
    user: "#A9B1D6",
    reasoning: "#565F89",
    toolName: "#C0CAF5",
    muted: "#787C99",
    mutedDim: "#515670",
    border: "#2A2E45",
    separator: "#2A2E45",
    success: "#9ECE6A",
    error: "#F7768E",
    warning: "#E0AF68",
    info: "#7DCFFF",
    composerBg: "#1A1B26",
    wordmarkDim: "#414868",
    wordmarkBright: "#C0CAF5",
  }),

  nord: from(opencode, {
    accent: "#88C0D0",
    accentFg: "#2E3440",
    accentSoft: "#A9CFDC",
    accentDeep: "#5E81AC",
    heading: "#B48EAD",
    assistant: "#ECEFF4",
    user: "#D8DEE9",
    reasoning: "#616E88",
    toolName: "#ECEFF4",
    muted: "#7B88A1",
    mutedDim: "#4C566A",
    border: "#3B4252",
    separator: "#3B4252",
    success: "#A3BE8C",
    error: "#BF616A",
    warning: "#EBCB8B",
    info: "#81A1C1",
    composerBg: "#2E3440",
    wordmarkDim: "#4C566A",
    wordmarkBright: "#ECEFF4",
  }),

  "one-dark": from(opencode, {
    accent: "#61AFEF",
    accentFg: "#1E2127",
    accentSoft: "#8CC5F3",
    accentDeep: "#3A6E96",
    heading: "#C678DD",
    assistant: "#ABB2BF",
    user: "#9DA5B4",
    reasoning: "#5C6370",
    toolName: "#ABB2BF",
    muted: "#7F8794",
    mutedDim: "#5C6370",
    border: "#3E4451",
    separator: "#3E4451",
    success: "#98C379",
    error: "#E06C75",
    warning: "#E5C07B",
    info: "#56B6C2",
    composerBg: "#21252B",
    wordmarkDim: "#4B5263",
    wordmarkBright: "#ABB2BF",
  }),

  monokai: from(opencode, {
    accent: "#FD971F",
    accentFg: "#1B1D1E",
    accentSoft: "#FEB757",
    accentDeep: "#9A5A0C",
    heading: "#AE81FF",
    assistant: "#F8F8F2",
    user: "#DCDCD2",
    reasoning: "#75715E",
    toolName: "#F8F8F2",
    muted: "#8F8B76",
    mutedDim: "#5F5C4E",
    border: "#3E3D32",
    separator: "#3E3D32",
    success: "#A6E22E",
    error: "#F92672",
    warning: "#E6DB74",
    info: "#66D9EF",
    composerBg: "#272822",
    wordmarkDim: "#5F5C4E",
    wordmarkBright: "#F8F8F2",
  }),

  rosepine: from(opencode, {
    accent: "#EBBCBA",
    accentFg: "#191724",
    accentSoft: "#F2D5D4",
    accentDeep: "#9C6A69",
    heading: "#C4A7E7",
    assistant: "#E0DEF4",
    user: "#CDCAD9",
    reasoning: "#6E6A86",
    toolName: "#E0DEF4",
    muted: "#908CAA",
    mutedDim: "#605D7A",
    border: "#26233A",
    separator: "#26233A",
    success: "#31748F",
    error: "#EB6F92",
    warning: "#F6C177",
    info: "#9CCFD8",
    composerBg: "#1F1D2E",
    wordmarkDim: "#4A4661",
    wordmarkBright: "#E0DEF4",
  }),

  solarized: from(opencode, {
    accent: "#B58900",
    accentFg: "#002B36",
    accentSoft: "#D0A62B",
    accentDeep: "#7A5C00",
    heading: "#6C71C4",
    assistant: "#EEE8D5",
    user: "#D5CFBE",
    reasoning: "#586E75",
    toolName: "#EEE8D5",
    muted: "#839496",
    mutedDim: "#586E75",
    border: "#073642",
    separator: "#073642",
    success: "#859900",
    error: "#DC322F",
    warning: "#CB4B16",
    info: "#268BD2",
    composerBg: "#073642",
    wordmarkDim: "#586E75",
    wordmarkBright: "#EEE8D5",
  }),

  synthwave84: from(opencode, {
    accent: "#FF7EDB",
    accentFg: "#241B2F",
    accentSoft: "#FFA9E7",
    accentDeep: "#A1478E",
    heading: "#B36BFF",
    assistant: "#F4EEFF",
    user: "#D8CCEA",
    reasoning: "#7A6E92",
    toolName: "#F4EEFF",
    muted: "#9A8CB5",
    mutedDim: "#6A5E82",
    border: "#3A2F4D",
    separator: "#3A2F4D",
    success: "#72F1B8",
    error: "#FE4450",
    warning: "#FEDE5D",
    info: "#36F9F6",
    composerBg: "#241B2F",
    wordmarkDim: "#5A4C72",
    wordmarkBright: "#F4EEFF",
  }),

  palenight: from(opencode, {
    accent: "#C792EA",
    accentFg: "#242739",
    accentSoft: "#DBB6F2",
    accentDeep: "#82609B",
    heading: "#82AAFF",
    assistant: "#EEFFFF",
    user: "#CBD3DE",
    reasoning: "#697098",
    toolName: "#EEFFFF",
    muted: "#8796B0",
    mutedDim: "#5C6685",
    border: "#32374D",
    separator: "#32374D",
    success: "#C3E88D",
    error: "#F07178",
    warning: "#FFCB6B",
    info: "#89DDFF",
    composerBg: "#292D3E",
    wordmarkDim: "#4E5579",
    wordmarkBright: "#EEFFFF",
  }),

  material: from(opencode, {
    accent: "#80CBC4",
    accentFg: "#212121",
    accentSoft: "#A7DBD6",
    accentDeep: "#4E8B85",
    heading: "#C792EA",
    assistant: "#EEFFFF",
    user: "#CFD8DC",
    reasoning: "#546E7A",
    toolName: "#EEFFFF",
    muted: "#8796A0",
    mutedDim: "#546E7A",
    border: "#37474F",
    separator: "#37474F",
    success: "#C3E88D",
    error: "#F07178",
    warning: "#FFCB6B",
    info: "#89DDFF",
    composerBg: "#263238",
    wordmarkDim: "#4A5D66",
    wordmarkBright: "#EEFFFF",
  }),

  mercury: from(opencode, {
    accent: "#C0C6CF",
    accentFg: "#16181C",
    accentSoft: "#D8DDE4",
    accentDeep: "#7A828E",
    heading: "#9FA7B3",
    assistant: "#EDEFF2",
    user: "#CBD0D8",
    reasoning: "#6E747E",
    toolName: "#EDEFF2",
    muted: "#8A9099",
    mutedDim: "#5E646D",
    border: "#2E3238",
    separator: "#2E3238",
    info: "#A8B2BF",
    composerBg: "#1B1E22",
    wordmarkDim: "#565C65",
    wordmarkBright: "#EDEFF2",
  }),

  nightowl: from(opencode, {
    accent: "#7FDBCA",
    accentFg: "#011627",
    accentSoft: "#A6E8DC",
    accentDeep: "#4A8B80",
    heading: "#C792EA",
    assistant: "#D6DEEB",
    user: "#BCC7D6",
    reasoning: "#5F7E97",
    toolName: "#D6DEEB",
    muted: "#8BA1B8",
    mutedDim: "#5F7E97",
    border: "#1D3B53",
    separator: "#1D3B53",
    success: "#ADDB67",
    error: "#EF5350",
    warning: "#FFEB95",
    info: "#82AAFF",
    composerBg: "#011627",
    wordmarkDim: "#43698A",
    wordmarkBright: "#D6DEEB",
  }),

  "osaka-jade": from(opencode, {
    accent: "#5FCF8F",
    accentFg: "#0C1614",
    accentSoft: "#8ADFB0",
    accentDeep: "#31795A",
    heading: "#6FD3C0",
    assistant: "#DDEAE4",
    user: "#BFD2CA",
    reasoning: "#5A7A70",
    toolName: "#DDEAE4",
    muted: "#7E9A90",
    mutedDim: "#546C64",
    border: "#1E332C",
    separator: "#1E332C",
    success: "#5FCF8F",
    error: "#E8737D",
    warning: "#E0BA6A",
    info: "#6FD3C0",
    composerBg: "#101C18",
    wordmarkDim: "#3E5A50",
    wordmarkBright: "#DDEAE4",
  }),
};

export const DEFAULT_THEME_NAME = "opencode";

/** Alphabetical, matching how the picker in the reference screenshots lists them. */
export const THEME_NAMES: string[] = Object.keys(THEMES).sort();

export function resolveTheme(name: string | null | undefined): Theme {
  return (name && THEMES[name]) || THEMES[DEFAULT_THEME_NAME];
}
