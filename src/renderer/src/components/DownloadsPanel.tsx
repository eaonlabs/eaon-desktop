import { useRef, type ReactNode, type RefObject } from 'react'
import { Boxes, Download, RefreshCw } from 'lucide-react'
import { useApp } from '../state/store'
import { Popover, useDisclosure } from './ui'
import { downloadPercent, repoName } from '../lib/format'
import type { ModelDownloadProgress, UpdateStatus } from '@shared/types'

/** Header button + popover showing every download in flight — Hugging Face
 * models and app updates alike, both sourced from the global store so this
 * works no matter which page is open. See .eaonbrain/local-model-hub.md and
 * the updater notes for where each side's progress actually comes from. */

function isUpdateVisible(state: string): boolean {
  return state === 'available' || state === 'downloading' || state === 'downloaded'
}

/** One ring on the button can only show one number — average every active
 * download rather than picking one arbitrarily. A phase with no byte count of
 * its own (just started, or wrapping up with Ollama) is pinned to a sensible
 * stand-in rather than left out, so it still nudges the average. */
function overallPercent(modelDownloads: Record<string, ModelDownloadProgress>, updateStatus: UpdateStatus): number | null {
  const percents: number[] = []
  for (const p of Object.values(modelDownloads)) {
    percents.push(p.phase === 'downloading' ? downloadPercent(p) : 100)
  }
  if (updateStatus.state === 'downloading') percents.push(updateStatus.percent)
  else if (updateStatus.state === 'available') percents.push(0)
  else if (updateStatus.state === 'downloaded') percents.push(100)
  if (percents.length === 0) return null
  return Math.round(percents.reduce((sum, p) => sum + p, 0) / percents.length)
}

export function DownloadsButton(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const modelDownloads = useApp((s) => s.modelDownloads)
  const updateStatus = useApp((s) => s.updateStatus)

  const percent = overallPercent(modelDownloads, updateStatus)

  return (
    <span className="download-btn-wrap">
      <button
        ref={anchor}
        className="icon-btn"
        data-active={menu.open || undefined}
        onClick={menu.toggle}
        aria-label="Downloads"
        title="Downloads"
      >
        <Download size={16} strokeWidth={1.9} />
      </button>
      {percent !== null && <ProgressRing percent={percent} />}
      <DownloadsPanel anchor={anchor} open={menu.open} onClose={menu.close} />
    </span>
  )
}

/** Thin ring drawn around (not inside) the button, filling clockwise from 12
 * o'clock — the same reading as a download badge on an app icon. */
function ProgressRing({ percent, size = 27 }: { percent: number; size?: number }): JSX.Element {
  const stroke = 1.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, percent))
  const offset = circumference * (1 - clamped / 100)

  return (
    <svg className="download-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

function DownloadsPanel({
  anchor,
  open,
  onClose
}: {
  anchor: RefObject<HTMLElement>
  open: boolean
  onClose: () => void
}): JSX.Element {
  const modelDownloads = useApp((s) => s.modelDownloads)
  const updateStatus = useApp((s) => s.updateStatus)

  const entries = Object.entries(modelDownloads)
  const showUpdate = isUpdateVisible(updateStatus.state)
  const empty = entries.length === 0 && !showUpdate

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-start" width={320} className="downloads-panel">
      <div className="menu__label">Downloads</div>
      {empty ? (
        <div className="downloads-empty">
          <Download size={26} strokeWidth={1.6} />
          <p>
            Your download progress
            <br />
            will appear here
          </p>
        </div>
      ) : (
        <div className="downloads-list">
          {updateStatus.state === 'downloading' && (
            <DownloadRow
              icon={<RefreshCw size={15} strokeWidth={1.9} />}
              title="Eaon Desktop update"
              subtitle="Downloading update…"
              percent={updateStatus.percent}
            />
          )}
          {updateStatus.state === 'available' && (
            <DownloadRow
              icon={<RefreshCw size={15} strokeWidth={1.9} />}
              title="Eaon Desktop update"
              subtitle={`Version ${updateStatus.version} — starting download…`}
            />
          )}
          {updateStatus.state === 'downloaded' && (
            <DownloadRow
              icon={<RefreshCw size={15} strokeWidth={1.9} />}
              title="Update ready"
              subtitle={`Version ${updateStatus.version} — restart to install`}
              action={{ label: 'Restart', onClick: () => void window.api.updater.install() }}
            />
          )}
          {entries.map(([k, p]) => (
            <DownloadRow
              key={k}
              icon={<Boxes size={15} strokeWidth={1.9} />}
              title={repoName(p.repoId)}
              subtitle={p.phase === 'registering' ? 'Registering with Ollama…' : p.filename}
              percent={p.phase === 'downloading' ? downloadPercent(p) : undefined}
            />
          ))}
        </div>
      )}
    </Popover>
  )
}

function DownloadRow({
  icon,
  title,
  subtitle,
  percent,
  action
}: {
  icon: ReactNode
  title: string
  subtitle: string
  percent?: number
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="download-row">
      <span className="download-row__icon">{icon}</span>
      <div className="download-row__body">
        <div className="download-row__top">
          <span className="download-row__title">{title}</span>
          {percent !== undefined && <span className="download-row__pct">{percent}%</span>}
        </div>
        <span className="download-row__subtitle">{subtitle}</span>
        {percent !== undefined && (
          <div className="download-row__bar">
            <div className="download-row__bar-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {action && (
        <button className="btn btn--sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
