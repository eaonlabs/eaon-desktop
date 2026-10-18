// Preload for captureWeb.cjs's "hold" shots: the relay's answers to the
// page's requests never arrive, so the page stays as it is while loading.
const Native = window.WebSocket
window.WebSocket = class extends Native {
  set onmessage(handler) {
    super.onmessage = (event) => {
      if (typeof event.data === 'string' && event.data.includes('"t":"res"')) return
      handler(event)
    }
  }
}
