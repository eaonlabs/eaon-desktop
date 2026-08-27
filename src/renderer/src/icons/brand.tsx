import type { ReactNode } from 'react'
import openaiLogo from '../assets/providers/openai.png'
import azureLogo from '../assets/providers/azure.png'
import anthropicLogo from '../assets/providers/anthropic.png'
import openrouterLogo from '../assets/providers/openrouter.png'
import mistralLogo from '../assets/providers/mistral.svg'
import groqLogo from '../assets/providers/groq.png'
import xaiLogo from '../assets/providers/xai.png'
import geminiLogo from '../assets/providers/gemini.png'
import minimaxLogo from '../assets/providers/minimax.png'
import huggingfaceLogo from '../assets/providers/huggingface.png'
import nvidiaLogo from '../assets/providers/nvidia.png'
import ollamaLogo from '../assets/providers/ollama.png'
import llamaCppLogo from '../assets/providers/llama-cpp.png'

/**
 * Icons for the integrations and model providers shown in the directory.
 *
 * The plugin/app integrations further down are simplified marks drawn inline —
 * same silhouette and colour cues, no artwork in the bundle. The model
 * providers are the real logos, shipped from `assets/providers` and rendered
 * through `ImageTile` so they sit at the same size and corner radius as the
 * drawn ones.
 */

interface TileProps {
  size?: number
  radius?: number
}

function Tile({
  size = 40,
  radius,
  bg,
  border,
  children
}: TileProps & { bg: string; border?: string; children: ReactNode }): JSX.Element {
  return (
    <span
      className="icon-tile"
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size * 0.235),
        background: bg,
        boxShadow: border ? `inset 0 0 0 1px ${border}` : undefined
      }}
    >
      <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
        {children}
      </svg>
    </span>
  )
}

/** Renders a real provider logo asset as a rounded tile, matching the Tile
    helper's sizing so hand-drawn and photographic icons sit consistently
    in the same list. `bg` is only needed for logos shipped without their
    own background fill. */
function ImageTile({
  size = 40,
  bg,
  src
}: TileProps & { bg?: string; src: string }): JSX.Element {
  return (
    <span
      className="icon-tile"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.235),
        background: bg,
        overflow: 'hidden'
      }}
    >
      <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </span>
  )
}

const docLines = (color: string): ReactNode => (
  <>
    <rect x="12" y="16" width="16" height="2.2" rx="1.1" fill={color} />
    <rect x="12" y="21" width="16" height="2.2" rx="1.1" fill={color} />
    <rect x="12" y="26" width="10" height="2.2" rx="1.1" fill={color} />
  </>
)

export function DocumentsIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="linear-gradient(180deg,#3b82f6,#2563eb)">
      <path d="M11 8h11l7 7v17a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="#fff" opacity="0.95" />
      <path d="M22 8l7 7h-7z" fill="#bfdbfe" />
      {docLines('#3b82f6')}
    </Tile>
  )
}

export function PdfIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="linear-gradient(180deg,#f87171,#dc2626)">
      <path d="M11 8h11l7 7v17a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="#fff" opacity="0.95" />
      <path d="M22 8l7 7h-7z" fill="#fecaca" />
      <text x="20" y="27" textAnchor="middle" fontSize="9" fontWeight="700" fill="#dc2626" fontFamily="system-ui">
        PDF
      </text>
    </Tile>
  )
}

export function SpreadsheetsIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="linear-gradient(180deg,#34d399,#059669)">
      <rect x="10" y="9" width="20" height="22" rx="2" fill="#fff" opacity="0.95" />
      <path d="M10 15h20M10 21h20M10 27h20M17 9v22M24 9v22" stroke="#059669" strokeWidth="1.6" />
    </Tile>
  )
}

export function PresentationsIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="linear-gradient(180deg,#fbbf24,#f59e0b)">
      <rect x="10" y="10" width="20" height="20" rx="2" fill="#fff" opacity="0.95" />
      <rect x="14" y="16" width="12" height="8" rx="1.4" fill="#f59e0b" />
    </Tile>
  )
}

export function TemplateIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <circle cx="15" cy="15" r="5.5" fill="#f472b6" />
      <rect x="21" y="9.5" width="11" height="11" rx="2.4" fill="#60a5fa" />
      <path d="M13 32l6-10 6 10z" fill="#fbbf24" />
    </Tile>
  )
}

export function VisualizeIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="linear-gradient(180deg,#93c5fd,#3b82f6)">
      <path
        d="M20 9l2.6 6.6L29 18l-6.4 2.4L20 27l-2.6-6.6L11 18l6.4-2.4z"
        fill="#fff"
      />
      <circle cx="28.5" cy="27.5" r="2.4" fill="#fff" opacity="0.9" />
    </Tile>
  )
}

export function GmailIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <path d="M8 13v15h5V19l7 5 7-5v9h5V13l-12 8.5z" fill="#ea4335" />
      <path d="M8 13h4l8 5.6L28 13h4l-12 8.5z" fill="#c5221f" />
    </Tile>
  )
}

export function GithubIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#0d1117" border="rgba(255,255,255,0.14)">
      <path
        d="M20 8a12 12 0 0 0-3.8 23.4c.6.1.8-.26.8-.58v-2c-3.34.73-4.04-1.6-4.04-1.6-.55-1.4-1.34-1.77-1.34-1.77-1.1-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.8 1.3 3.5 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.94 0-1.32.47-2.39 1.24-3.23-.13-.3-.54-1.53.11-3.18 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.65.25 2.88.12 3.18.78.84 1.24 1.91 1.24 3.23 0 4.61-2.8 5.63-5.48 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.21.7.82.58A12 12 0 0 0 20 8z"
        fill="#fff"
      />
    </Tile>
  )
}

export function DriveIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <path d="M16 9h8l8 14h-8z" fill="#ffc107" />
      <path d="M16 9l-8 14 4 7 8-14z" fill="#4285f4" />
      <path d="M12 30h16l4-7H16z" fill="#0f9d58" />
    </Tile>
  )
}

export function CalendarIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <rect x="8" y="10" width="24" height="22" rx="2.6" fill="#4285f4" />
      <rect x="8" y="10" width="24" height="6" rx="2.6" fill="#1a73e8" />
      <text x="20" y="28" textAnchor="middle" fontSize="12" fontWeight="600" fill="#fff" fontFamily="system-ui">
        31
      </text>
    </Tile>
  )
}

export function NotionIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.18)">
      <path d="M13 12h4l8 11V12h3v17h-4l-8-11.4V29h-3z" fill="#111" />
    </Tile>
  )
}

export function SlackIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <rect x="17.6" y="8" width="4.8" height="12" rx="2.4" fill="#e01e5a" />
      <rect x="20" y="20" width="12" height="4.8" rx="2.4" fill="#ecb22e" />
      <rect x="17.6" y="20" width="4.8" height="12" rx="2.4" fill="#2eb67d" />
      <rect x="8" y="15.2" width="12" height="4.8" rx="2.4" fill="#36c5f0" />
    </Tile>
  )
}

export function GranolaIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#d9e021">
      <path
        d="M20 11a9 9 0 1 0 9 9 7 7 0 1 0-7-7 5 5 0 1 1 5 5"
        fill="none"
        stroke="#1a1a1a"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </Tile>
  )
}

export function FirefliesIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <path d="M13 10h14v5h-9v4h8v5h-8v6h-5z" fill="#ec4899" />
    </Tile>
  )
}

export function OutlookIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <rect x="19" y="12" width="13" height="16" rx="1.6" fill="#0f6cbd" opacity="0.85" />
      <rect x="8" y="9" width="14" height="22" rx="2.4" fill="#0364b8" />
      <ellipse cx="15" cy="20" rx="4.6" ry="5.4" fill="#fff" />
      <ellipse cx="15" cy="20" rx="2.2" ry="3" fill="#0364b8" />
    </Tile>
  )
}

export function PlaudIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#111111" border="rgba(255,255,255,0.14)">
      <path d="M20 10l8 20h-4.2l-1.5-4h-4.6l-1.5 4H12z" fill="#fff" />
    </Tile>
  )
}

export function CanvaIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="linear-gradient(135deg,#7d2ae8,#00c4cc)">
      <text x="20" y="27" textAnchor="middle" fontSize="18" fontWeight="700" fill="#fff" fontFamily="Georgia, serif">
        C
      </text>
    </Tile>
  )
}

export function ChromeIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#ffffff" border="rgba(0,0,0,0.12)">
      <circle cx="20" cy="20" r="12" fill="#4285f4" />
      <path d="M20 8a12 12 0 0 1 10.4 6H20a6 6 0 0 0-5.2 3L9.6 12A12 12 0 0 1 20 8z" fill="#ea4335" />
      <path d="M9.6 12l5.2 5a6 6 0 0 0 .3 5.6l-5.2 8.6A12 12 0 0 1 9.6 12z" fill="#fbbc05" />
      <path d="M30.4 14A12 12 0 0 1 20 32c-.6 0-1.2 0-1.8-.1l5.6-9.4A6 6 0 0 0 26 20a6 6 0 0 0-.8-3z" fill="#34a853" />
      <circle cx="20" cy="20" r="5" fill="#fff" />
      <circle cx="20" cy="20" r="3.6" fill="#4285f4" />
    </Tile>
  )
}

/* ---------------------------------------------------------- Model providers */

export function OpenAiIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={openaiLogo} />
}

export function AzureIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={azureLogo} />
}

export function AnthropicIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={anthropicLogo} />
}

export function OpenRouterIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={openrouterLogo} />
}

export function MistralIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={mistralLogo} bg="#ffffff" />
}

export function GroqIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={groqLogo} />
}

export function XaiIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={xaiLogo} />
}

export function GeminiIcon({ size = 40 }: TileProps): JSX.Element {
  return <img src={geminiLogo} alt="" width={size} height={size} style={{ display: 'block', objectFit: 'contain' }} />
}

export function MiniMaxIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={minimaxLogo} />
}

export function HuggingFaceIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={huggingfaceLogo} />
}

export function NvidiaIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={nvidiaLogo} />
}

export function LlamaCppIcon(props: TileProps): JSX.Element {
  // The mark is orange on transparency, so it needs a light tile behind it.
  return <ImageTile {...props} src={llamaCppLogo} bg="#ffffff" />
}

export function MlxIcon(props: TileProps): JSX.Element {
  return (
    <Tile {...props} bg="#0d0d0d">
      <text x="20" y="25" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="system-ui">
        MLX
      </text>
    </Tile>
  )
}

export function OllamaIcon(props: TileProps): JSX.Element {
  return <ImageTile {...props} src={ollamaLogo} />
}

/** The gradient cube used for every skill entry. */
export function SkillIcon({ size = 40 }: TileProps): JSX.Element {
  const id = `sk${size}`
  return (
    <span
      className="icon-tile"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.235),
        background: 'var(--surface-3)',
        boxShadow: 'inset 0 0 0 1px var(--border)'
      }}
    >
      <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#f0abfc" />
          </linearGradient>
          <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fdba74" />
            <stop offset="100%" stopColor="#fb7185" />
          </linearGradient>
          <linearGradient id={`${id}c`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#7dd3fc" />
          </linearGradient>
        </defs>
        <path d="M20 9l9 5-9 5-9-5z" fill={`url(#${id}a)`} />
        <path d="M11 14l9 5v11l-9-5z" fill={`url(#${id}b)`} />
        <path d="M29 14l-9 5v11l9-5z" fill={`url(#${id}c)`} />
      </svg>
    </span>
  )
}

export function GenericIcon({ size = 40, letter, color }: TileProps & { letter: string; color: string }): JSX.Element {
  return (
    <Tile size={size} bg={color}>
      <text x="20" y="27" textAnchor="middle" fontSize="17" fontWeight="600" fill="#fff" fontFamily="system-ui">
        {letter}
      </text>
    </Tile>
  )
}

export const BRAND_ICONS: Record<string, (props: TileProps) => JSX.Element> = {
  documents: DocumentsIcon,
  pdf: PdfIcon,
  spreadsheets: SpreadsheetsIcon,
  presentations: PresentationsIcon,
  'template-creator': TemplateIcon,
  visualize: VisualizeIcon,
  gmail: GmailIcon,
  github: GithubIcon,
  'google-drive': DriveIcon,
  'google-calendar': CalendarIcon,
  notion: NotionIcon,
  slack: SlackIcon,
  granola: GranolaIcon,
  fireflies: FirefliesIcon,
  'outlook-calendar': OutlookIcon,
  'outlook-email': OutlookIcon,
  plaud: PlaudIcon,
  canva: CanvaIcon,
  chrome: ChromeIcon,
  openai: OpenAiIcon,
  azure: AzureIcon,
  anthropic: AnthropicIcon,
  openrouter: OpenRouterIcon,
  mistral: MistralIcon,
  groq: GroqIcon,
  xai: XaiIcon,
  gemini: GeminiIcon,
  minimax: MiniMaxIcon,
  huggingface: HuggingFaceIcon,
  'nvidia-nim': NvidiaIcon,
  'llama-cpp': LlamaCppIcon,
  mlx: MlxIcon,
  ollama: OllamaIcon
}

export function BrandIcon({ id, size = 40 }: { id: string; size?: number }): JSX.Element {
  const Component = BRAND_ICONS[id]
  if (Component) return <Component size={size} />
  return <GenericIcon size={size} letter={id.charAt(0).toUpperCase()} color="#4b5563" />
}
