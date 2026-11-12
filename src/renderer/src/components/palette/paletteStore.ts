import { create } from 'zustand'

/** Whether the command palette is open. Opened by its key (App.tsx's GlobalKeys), or from anywhere with `openPalette()`. */
export const usePalette = create<{ open: boolean }>(() => ({ open: false }))

export const openPalette = (): void => usePalette.setState({ open: true })
export const closePalette = (): void => usePalette.setState({ open: false })
export const togglePalette = (): void => usePalette.setState((s) => ({ open: !s.open }))
