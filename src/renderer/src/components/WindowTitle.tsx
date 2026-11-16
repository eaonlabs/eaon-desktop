import type { JSX } from 'react'

/**
 * Eaon's mark and name at the top left, where a Windows window shows its
 * own: the sidebar's top row, and Settings'. Shown on Windows only
 * (windows.css); a Mac has its traffic lights there.
 */
export function WindowTitle(): JSX.Element {
  return (
    <span className="titlebar__app">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M186.6 50A100 100 0 1 0 186.6 150H103A15 15 0 0 1 103 120H197.98A100 100 0 0 0 197.98 80H103A15 15 0 0 1 103 50Z"
        />
      </svg>
      Eaon
    </span>
  )
}
