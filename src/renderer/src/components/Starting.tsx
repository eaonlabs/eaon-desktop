import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../state/store'
import { ErrorDetails } from './ui'

/**
 * Before the saved data is in. Blank at first (it usually takes well under a
 * second), then a note if it is slow, and the reason with a retry if loading
 * failed: that used to leave an empty window with no way out.
 */
export function Starting(): JSX.Element {
  const { initError, init } = useApp(useShallow((s) => ({ initError: s.initError, init: s.init })))
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 12_000)
    return () => clearTimeout(timer)
  }, [])
  if (!initError && !slow) return <div className="app" />
  return (
    <div className="crash-screen" role="alert">
      <div className="crash-screen__drag" />
      <div className="empty-state">
        <div className="empty-state__title">{initError ? "Eaon couldn't load your chats and settings" : 'Eaon is taking longer than usual to start'}</div>
        <div className="empty-state__body">
          {initError
            ? 'Nothing has been deleted. Try again; if it keeps failing, quit Eaon and open it again.'
            : 'It is still loading your chats and settings. If nothing changes, reload the window.'}
        </div>
        {initError && <ErrorDetails detail={initError} />}
        <button className="btn btn--primary" onClick={() => (initError ? void init() : window.location.reload())}>
          {initError ? 'Try again' : 'Reload'}
        </button>
      </div>
    </div>
  )
}
