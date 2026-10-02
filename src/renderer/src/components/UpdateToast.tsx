import { useState } from 'react'
import { Download, X } from 'lucide-react'
import { useApp } from '../state/store'

/** Floats over every view once an update has finished downloading — the one
 * moment worth interrupting the user for. Checking/downloading stays ambient,
 * visible only in the header's Downloads panel (DownloadsPanel.tsx). */
export function UpdateToast(): JSX.Element | null {
  const status = useApp((s) => s.updateStatus)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  if (status.state !== 'downloaded' || status.version === dismissedVersion) return null

  return (
    <div className="update-toast" role="status">
      <span className="update-toast__icon">
        <Download size={16} strokeWidth={1.9} />
      </span>
      <div className="update-toast__body">
        <div className="update-toast__title">Update ready</div>
        <p className="update-toast__desc">Version {status.version} will install the next time you restart.</p>
        <div className="update-toast__actions">
          <button className="btn btn--primary btn--sm" onClick={() => void window.api.updater.install()}>
            Restart now
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setDismissedVersion(status.version)}>
            Later
          </button>
        </div>
      </div>
      <button className="icon-btn update-toast__close" aria-label="Dismiss" onClick={() => setDismissedVersion(status.version)}>
        <X size={14} strokeWidth={1.9} />
      </button>
    </div>
  )
}
