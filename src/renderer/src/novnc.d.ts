/** What Eaon uses of noVNC's client (it ships no types). See node_modules/@novnc/novnc/docs/API.md. */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { credentials?: { username?: string; password?: string; target?: string }; shared?: boolean; wsProtocols?: string[] })
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    viewOnly: boolean
    focusOnClick: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    sendCtrlAltDel(): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    focus(): void
    blur(): void
  }
}
