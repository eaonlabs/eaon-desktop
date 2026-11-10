import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { effectiveBinding, formatBinding, matchesChord, type KeyLike } from '@shared/keybindings'
import { useApp } from '../state/store'
import { isMac } from './platform'

/**
 * Where the app reads a command's key. Every place that listens for a
 * shortcut asks here, so a key changed in Settings → Keyboard shortcuts works
 * at once and the old one stops: the window's key handler (App.tsx), the
 * browser panel, the chat's find and terminal keys, the terminals' own key
 * layer. The rules are shared/keybindings.ts's, which the app menu in the
 * main process reads too.
 */

/** A key press, as the shortcut rules read it. */
export const keyOf = (event: KeyboardEvent | ReactKeyboardEvent): KeyLike => ({
  key: event.key,
  meta: event.metaKey,
  ctrl: event.ctrlKey,
  alt: event.altKey,
  shift: event.shiftKey,
  code: event.code,
  altGraph: event.getModifierState?.('AltGraph') ?? false
})

/** A command's key now: its saved key or its default; null for a command left without one. */
export const bindingOf = (id: string): string | null => effectiveBinding(id, useApp.getState().settings?.shortcuts, isMac)

/** Whether `event` is the key of command `id`. */
export const isKey = (id: string, event: KeyboardEvent | ReactKeyboardEvent): boolean => matchesChord(bindingOf(id), keyOf(event), isMac)

/** A command's key, redrawn when it is changed. */
export const useBinding = (id: string): string | null => useApp((s) => effectiveBinding(id, s.settings?.shortcuts, isMac))

/** A command's key as this platform writes it (⇧⌘A, Ctrl+Shift+A), or '' when it has none. */
export const useBindingLabel = (id: string): string => formatBinding(useBinding(id), isMac)

/** The same, outside React. */
export const bindingLabel = (id: string): string => formatBinding(bindingOf(id), isMac)
