import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react'

/* ------------------------------------------------------------------ Popover */

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start'

interface PopoverProps {
  anchor: RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  placement?: Placement
  offset?: number
  width?: number
  children: ReactNode
  className?: string
}

/** Menu surface anchored to a trigger, kept inside the viewport. */
export function Popover({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  offset = 6,
  width,
  children,
  className
}: PopoverProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0, top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const trigger = anchor.current?.getBoundingClientRect()
      const surface = ref.current
      if (!trigger || !surface) return
      const margin = 8
      // offsetWidth/Height, not getBoundingClientRect: the open animation starts
      // at scale(0.94), and a client rect reports the *transformed* size — so
      // measuring mid-animation under-reported the height and the flip below
      // decided it fit when it did not. ResizeObserver cannot rescue this
      // either, since a transform never changes the border-box it observes.
      const w = width ?? surface.offsetWidth
      const h = surface.offsetHeight
      let top: number
      let left: number

      switch (placement) {
        case 'bottom-end':
          top = trigger.bottom + offset
          left = trigger.right - w
          break
        case 'top-start':
          top = trigger.top - h - offset
          left = trigger.left
          break
        case 'top-end':
          top = trigger.top - h - offset
          left = trigger.right - w
          break
        case 'right-start':
          top = trigger.top - 5
          left = trigger.right + offset
          break
        case 'left-start':
          top = trigger.top - 5
          left = trigger.left - w - offset
          break
        default:
          top = trigger.bottom + offset
          left = trigger.left
      }

      // Flip vertically rather than run off the bottom edge.
      if (top + h > window.innerHeight - margin) {
        const flipped = placement.startsWith('bottom') ? trigger.top - h - offset : window.innerHeight - h - margin
        top = Math.max(margin, flipped)
      }
      if (left + w > window.innerWidth - margin) left = Math.max(margin, trigger.right - w)
      if (left < margin) left = margin
      if (top < margin) top = margin

      setStyle({ top, left, ...(width ? { width } : {}), opacity: 1 })
    }
    place()
    const observer = new ResizeObserver(place)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, placement, offset, width, anchor])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <>
      <div className="layer layer--transparent" onMouseDown={onClose} onContextMenu={onClose} />
      <div ref={ref} className={`menu ${className ?? ''}`} style={style} role="menu">
        {children}
      </div>
    </>,
    document.body
  )
}

/* --------------------------------------------------------------- Menu items */

export function MenuItem({
  icon,
  title,
  description,
  hint,
  checked,
  submenu,
  disabled,
  onClick,
  open,
  ...rest
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  hint?: ReactNode
  checked?: boolean
  submenu?: boolean
  disabled?: boolean
  open?: boolean
  onClick?: () => void
  onMouseEnter?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu__item ${description ? 'menu__item--tall' : ''}`}
      data-open={open || undefined}
      disabled={disabled}
      onClick={onClick}
      {...rest}
    >
      {icon !== undefined && <span className="menu__item-icon">{icon}</span>}
      <span className="menu__item-body">
        <span className="menu__item-title">{title}</span>
        {description && <span className="menu__item-desc">{description}</span>}
      </span>
      {hint !== undefined && <span className="menu__item-hint">{hint}</span>}
      {checked && (
        <span className="menu__item-check">
          <Check size={15} strokeWidth={2.2} />
        </span>
      )}
      {submenu && (
        <span className="menu__item-check">
          <ChevronRight size={15} strokeWidth={2} />
        </span>
      )}
    </button>
  )
}

export function MenuSeparator(): JSX.Element {
  return <div className="menu__sep" />
}

export function MenuSearch({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}): JSX.Element {
  return (
    <div className="menu__search">
      <Search size={14} strokeWidth={2} />
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  )
}

/* -------------------------------------------------------------------- Modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  showClose = true,
  width
}: {
  open: boolean
  onClose: () => void
  title: string
  children?: ReactNode
  actions?: ReactNode
  showClose?: boolean
  width?: number
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="layer layer--scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        {showClose && (
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        )}
        <h2 className="modal__title">{title}</h2>
        {children && <div className="modal__body">{children}</div>}
        <div className="modal__actions">{actions}</div>
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ Controls */

export function Switch({
  checked,
  onChange,
  dimmed,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  dimmed?: boolean
  disabled?: boolean
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      data-on={checked}
      data-dimmed={dimmed || undefined}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className="segment" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className="segment__item"
          data-active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  icon,
  width
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
  icon?: ReactNode
  width?: number
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="select"
        data-open={open || undefined}
        style={width ? { width } : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {(current?.icon ?? icon) && <span className="chip__icon">{current?.icon ?? icon}</span>}
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {current?.label ?? value}
        </span>
        <span className="select__chevron">
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        width={Math.max(width ?? 0, 168)}
      >
        {options.map((option) => (
          <MenuItem
            key={option.value}
            icon={option.icon}
            title={option.label}
            checked={option.value === value}
            onClick={() => {
              onChange(option.value)
              setOpen(false)
            }}
          />
        ))}
      </Popover>
    </>
  )
}

export function Slider({
  value,
  min = 0,
  max = 100,
  onChange
}: {
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}): JSX.Element {
  const fill = ((value - min) / (max - min)) * 100
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider__value">{value}</span>
    </div>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder,
  variant,
  trailing,
  autoFocus
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  variant?: 'sm' | 'pill'
  trailing?: ReactNode
  autoFocus?: boolean
}): JSX.Element {
  return (
    <div className={`search-field ${variant ? `search-field--${variant}` : ''}`}>
      <span className="search-field__icon">
        <Search size={variant ? 14 : 16} strokeWidth={2} />
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoFocus={autoFocus}
      />
      {trailing}
    </div>
  )
}

/* --------------------------------------------------------- Settings helpers */

export function Card({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`card ${className ?? ''}`}>{children}</div>
}

export function Row({
  title,
  description,
  children,
  onClick
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  onClick?: () => void
}): JSX.Element {
  return (
    <div className="row" onClick={onClick}>
      <div className="row__body">
        <div className="row__title">{title}</div>
        {description && <div className="row__desc">{description}</div>}
      </div>
      {children && <div className="row__trail">{children}</div>}
    </div>
  )
}

export function Section({
  label,
  children
}: {
  label?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings__section">
      {label && <div className="settings__section-label">{label}</div>}
      {children}
    </section>
  )
}

/* -------------------------------------------------------------- Focus utils */

const MenuCloseContext = createContext<() => void>(() => {})
export const useMenuClose = (): (() => void) => useContext(MenuCloseContext)
export const MenuCloseProvider = MenuCloseContext.Provider

/** Small helper for controlled disclosure state on a trigger element. */
export function useDisclosure(): {
  open: boolean
  setOpen: (value: boolean) => void
  toggle: () => void
  close: () => void
} {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => setOpen((v) => !v), [])
  return { open, setOpen, toggle, close }
}
