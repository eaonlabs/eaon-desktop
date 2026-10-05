import { useEffect } from 'react'
import { create } from 'zustand'
import { Check, CircleAlert, X } from 'lucide-react'

/**
 * A one-line result for an action that has nowhere else to say it: a menu
 * item that copied something, or a folder that couldn't be opened. Most
 * failures belong next to the control that caused them; this is for the
 * ones whose control (a menu) is already gone.
 */
interface NoticeState {
  notice: { id: number; text: string; tone: 'done' | 'error' } | null
  show: (text: string, tone?: 'done' | 'error') => void
  dismiss: () => void
}

export const useNotice = create<NoticeState>((set) => ({
  notice: null,
  show: (text, tone = 'done') => set({ notice: { id: Date.now(), text, tone } }),
  dismiss: () => set({ notice: null })
}))

/** Shorthand for code outside React. */
export const notify = (text: string, tone: 'done' | 'error' = 'done'): void => useNotice.getState().show(text, tone)

export function Notice(): JSX.Element | null {
  const { notice, dismiss } = useNotice()
  useEffect(() => {
    if (!notice) return
    // Errors stay longer: they are the ones someone needs time to read.
    const timer = setTimeout(dismiss, notice.tone === 'error' ? 9000 : 3000)
    return () => clearTimeout(timer)
  }, [notice, dismiss])
  if (!notice) return null
  return (
    <div className="update-toast notice-toast" role={notice.tone === 'error' ? 'alert' : 'status'} key={notice.id}>
      <span className="update-toast__icon" data-tone={notice.tone}>
        {notice.tone === 'error' ? <CircleAlert size={16} strokeWidth={1.9} /> : <Check size={16} strokeWidth={2} />}
      </span>
      <div className="update-toast__body">
        <p className="notice-toast__text">{notice.text}</p>
      </div>
      <button type="button" className="icon-btn update-toast__close" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        <X size={14} strokeWidth={1.9} />
      </button>
    </div>
  )
}
