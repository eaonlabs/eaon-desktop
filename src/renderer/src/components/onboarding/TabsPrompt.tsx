import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { APP_TABS, shownTabs, tabsPromptDue, TAB_HINT, TAB_LABEL, type AppTab } from '@shared/tabs'
import { useApp } from '../../state/store'
import { Modal } from '../ui'
import { TAB_ICON } from '../ModeSwitch'
import { useOnboarding } from './onboardingStore'
import '../../styles/tabsPicker.css'

/**
 * "Pick your tabs", once, for an install set up before the IDE had its own
 * tab: it updated into four tabs it never chose. The tabs are drawn as the
 * top bar draws them, and the bar is the control: click a tab to show or
 * hide it, drag it (or ⌥← ⌥→) to move it. Done and Escape keep what's
 * picked; it isn't asked again.
 *
 * Whether it's up is kept apart from whether it's due: the first change
 * saves the tabs, which alone would make it no longer due and close it.
 */
export function TabsPrompt(): JSX.Element | null {
  const due = useApp((s) => tabsPromptDue(s.settings))
  // Answered in another window: this one's goes too.
  const asked = useApp((s) => s.settings?.onboarding.tabsAsked === true)
  const patchSettings = useApp((s) => s.patchSettings)
  const open = useOnboarding((s) => s.tabsOpen)
  const setTabsOpen = useOnboarding((s) => s.setTabsOpen)
  const touring = useOnboarding((s) => s.tourOpen)

  useEffect(() => {
    if (due && !touring) setTabsOpen(true)
  }, [due, touring, setTabsOpen])
  useEffect(() => {
    if (asked) setTabsOpen(false)
  }, [asked, setTabsOpen])

  const close = (): void => {
    setTabsOpen(false)
    void patchSettings({ onboarding: { tabsAsked: true } })
  }

  // A tour started from the Help menu goes over it; it waits under, and comes back after.
  return (
    <Modal
      open={open && !touring}
      onClose={close}
      title="Pick your tabs"
      width={480}
      showClose={false}
      actions={
        <>
          <span className="modal__why">You can change them later in Settings → General.</span>
          <button type="button" className="btn btn--primary" autoFocus onClick={close}>
            Done
          </button>
        </>
      }
    >
      <p className="tabs-prompt__lead">The IDE has its own tab now. Keep the ones you use.</p>
      <TabsBar />
    </Modal>
  )
}

/** A tab being dragged: where it started, where it would land, how far the pointer has taken it, and where the row's tabs were when it began. */
type Drag = { from: number; to: number; dx: number; dropping: boolean; rects: DOMRect[]; gap: number }

const DROP_MS = 180

/**
 * Every tab in one row, the hidden ones drawn as dashed outlines where they
 * were, so one switched off and on again comes back to its place. Under the
 * row, what the tab under the pointer (or focus) is for.
 */
function TabsBar(): JSX.Element {
  const setting = useApp((s) => s.settings?.general.tabs)
  const patchSettings = useApp((s) => s.patchSettings)
  const shown = shownTabs(setting)
  const [order, setOrder] = useState<AppTab[]>(() => [...shown, ...APP_TABS.filter((tab) => !shown.includes(tab))])
  const [about, setAbout] = useState<AppTab | null>(null)
  const [lastOne, setLastOne] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The drop just landed: the row is in its new order, so the tabs jump to it rather than slide again.
  const [settling, setSettling] = useState(false)
  const buttons = useRef(new Map<AppTab, HTMLButtonElement>())
  const press = useRef<{ x: number; from: number; rects: DOMRect[]; gap: number } | null>(null)
  const moved = useRef(false)

  useEffect(() => {
    if (!settling) return
    const frame = requestAnimationFrame(() => setSettling(false))
    return () => cancelAnimationFrame(frame)
  }, [settling])

  const save = (row: AppTab[], on: readonly AppTab[]): void => void patchSettings({ general: { tabs: row.filter((tab) => on.includes(tab)) } })

  const toggle = (tab: AppTab): void => {
    if (shown.includes(tab) && shown.length === 1) {
      setLastOne(true)
      return
    }
    setLastOne(false)
    save(order, shown.includes(tab) ? shown.filter((t) => t !== tab) : [...shown, tab])
  }

  const reorder = (from: number, to: number): void => {
    if (from === to) return
    const row = [...order]
    const [tab] = row.splice(from, 1)
    row.splice(to, 0, tab)
    setOrder(row)
    save(row, shown)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, from: number): void => {
    if (event.button !== 0 || drag) return
    const rects = order.map((tab) => buttons.current.get(tab)!.getBoundingClientRect())
    press.current = { x: event.clientX, from, rects, gap: rects.length > 1 ? rects[1].left - rects[0].right : 0 }
    moved.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = press.current
    if (!start) return
    const { from, rects, gap } = start
    let dx = event.clientX - start.x
    // A wobble on a click isn't a drag.
    if (!moved.current && Math.abs(dx) < 4) return
    moved.current = true
    // It stays inside the row.
    dx = Math.min(Math.max(dx, rects[0].left - rects[from].left), rects[rects.length - 1].right - rects[from].right)
    const centre = rects[from].left + rects[from].width / 2 + dx
    const to = rects.filter((rect, i) => i !== from && rect.left + rect.width / 2 < centre).length
    setDrag({ from, to, dx, dropping: false, rects, gap })
  }

  const onPointerUp = (cancelled: boolean): void => {
    press.current = null
    if (!drag || drag.dropping) return
    const { from, to, rects } = drag
    if (cancelled || from === to) {
      setDrag({ ...drag, to: from, dx: 0, dropping: true })
      setTimeout(() => setDrag(null), DROP_MS)
      return
    }
    // Slide into its place, then take it.
    const slot = to > from ? rects[to].right - rects[from].right : rects[to].left - rects[from].left
    setDrag({ ...drag, dx: slot, dropping: true })
    setTimeout(() => {
      reorder(from, to)
      setDrag(null)
      setSettling(true)
    }, DROP_MS)
  }

  // Where each tab sits while one is dragged: those it passes step aside by its width.
  const offset = (i: number): number => {
    if (!drag) return 0
    if (i === drag.from) return drag.dx
    const span = drag.rects[drag.from].width + drag.gap
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -span
    if (drag.from > drag.to && i >= drag.to && i < drag.from) return span
    return 0
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!by) return
    event.preventDefault()
    const next = at + by
    if (next < 0 || next >= order.length) return
    if (event.altKey) reorder(at, next)
    else buttons.current.get(order[next])?.focus()
  }

  return (
    <div className="tabs-prompt__stage">
      <div className="tabs-bar" role="group" aria-label="Tabs" data-settling={settling || undefined}>
        {order.map((tab, i) => {
          const on = shown.includes(tab)
          return (
            <button
              key={tab}
              ref={(node) => void (node ? buttons.current.set(tab, node) : buttons.current.delete(tab))}
              type="button"
              className="tabs-bar__tab"
              data-tab={tab}
              aria-pressed={on}
              aria-description={`${TAB_HINT[tab]}. Option and the arrow keys move it.`}
              data-drag={drag?.from === i ? (drag.dropping ? 'drop' : 'drag') : undefined}
              style={{ translate: `${offset(i)}px 0` }}
              onPointerDown={(event) => onPointerDown(event, i)}
              onPointerMove={onPointerMove}
              onPointerUp={() => onPointerUp(false)}
              onPointerCancel={() => onPointerUp(true)}
              onPointerEnter={() => setAbout(tab)}
              onPointerLeave={() => setAbout((now) => (now === tab ? null : now))}
              onFocus={() => setAbout(tab)}
              onBlur={() => setAbout((now) => (now === tab ? null : now))}
              onKeyDown={(event) => onKeyDown(event, i)}
              onClick={() => {
                // The click that ends a drag drops the tab; it doesn't also switch it.
                if (moved.current) moved.current = false
                else toggle(tab)
              }}
            >
              {TAB_ICON[tab](15)}
              {TAB_LABEL[tab]}
            </button>
          )
        })}
      </div>
      <p className="tabs-prompt__about" aria-hidden="true">
        {lastOne && shown.length === 1 ? (
          'One tab stays: show another first.'
        ) : about && !drag ? (
          <>
            <b>{TAB_LABEL[about]}</b> {TAB_HINT[about]}
          </>
        ) : (
          'Click a tab to show or hide it. Drag to reorder.'
        )}
      </p>
    </div>
  )
}
