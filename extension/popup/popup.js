/*
 * The toolbar popup. It holds no state of its own: the service worker pushes
 * a fresh snapshot over a port whenever anything changes, and every button is
 * a request back over the same port.
 */

const $ = (id) => document.getElementById(id)

const port = chrome.runtime.connect({ name: 'popup' })
const waiting = new Map()
let nextId = 1
let state = null

function request(type, payload = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    port.postMessage({ id, type, ...payload })
  })
}

port.onMessage.addListener((message) => {
  if (message.type === 'state') {
    state = message.state
    render()
  } else if (message.type === 'reply') {
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  }
})

const STATUS_TEXT = {
  connected: 'Connected',
  connecting: 'Connecting…',
  offline: 'Not connected',
  unpaired: 'Not paired',
  error: 'Can’t connect',
  paused: 'Stopped'
}

function show(id, visible) {
  $(id).hidden = !visible
}

function setIcon(img, url) {
  if (url && /^(https?|data):/i.test(url)) img.src = url
  else img.removeAttribute('src')
}

function render() {
  const s = state
  const pairing = s.status === 'connecting' && s.message === 'Pairing…'
  const view =
    s.status === 'connected'
      ? 'connected'
      : s.status === 'error'
        ? 'error'
        : !s.paired || s.status === 'unpaired' || pairing
          ? 'pair'
          : 'offline'

  const badge = s.status === 'connected' && s.paused ? 'paused' : s.status
  $('status').dataset.state = badge
  $('status-text').textContent = STATUS_TEXT[badge] || s.status

  show('view-pair', view === 'pair')
  show('view-offline', view === 'offline')
  show('view-connected', view === 'connected')
  show('view-error', view === 'error')
  show('unpair', s.paired)
  $('version').textContent = `Extension ${s.version}${s.appVersion && view === 'connected' ? ` · Eaon ${s.appVersion}` : ''}`

  if (view === 'pair') {
    $('pair-button').disabled = pairing
    $('pair-button').textContent = pairing ? 'Pairing…' : 'Pair'
    if (document.activeElement !== $('port')) $('port').value = s.port
    if (s.message && !pairing && s.status === 'unpaired') {
      $('pair-error').textContent = s.message
      show('pair-error', true)
    }
  }

  if (view === 'offline') {
    $('offline-title').textContent = s.status === 'connecting' ? 'Connecting to Eaon…' : 'Eaon isn’t reachable'
    $('offline-text').textContent =
      s.status === 'connecting'
        ? `Looking for the Eaon app on port ${s.port}.`
        : 'Open the Eaon app and check that Browser extension is on in its Settings. This extension reconnects on its own within 30 seconds.'
  }

  if (view === 'error') $('error-text').textContent = s.message

  if (view === 'connected') renderConnected(s)
}

function renderConnected(s) {
  show('agent-tab', Boolean(s.agentTab))
  show('agent-tab-empty', !s.agentTab)
  if (s.agentTab) {
    $('agent-tab-title').textContent = s.agentTab.title
    $('agent-tab').title = s.agentTab.url
    setIcon($('agent-tab-icon'), s.agentTab.favIconUrl)
  }

  const tab = s.activeTab
  show('this-tab', Boolean(tab) && !(s.agentTab && tab.id === s.agentTab.id && tab.inGroup))
  if (tab) {
    $('this-tab-title').textContent = tab.title
    setIcon($('this-tab-icon'), tab.favIconUrl)
    let note
    if (!tab.scriptable) note = 'Chrome doesn’t let extensions control this page.'
    else if (tab.inGroup) note = 'In the Eaon tab group, so the agent can use it.'
    else if (tab.shared) note = 'Shared: the agent can read and control this tab.'
    else note = 'Private: the agent can’t see this tab.'
    $('this-tab-note').textContent = note
    show('share', tab.scriptable && !tab.inGroup && !tab.shared)
    show('unshare', tab.scriptable && !tab.inGroup && tab.shared)
  }

  show('control', !s.paused)
  show('paused', s.paused)
}

// ------------------------------------------------------------------ Events

$('code').addEventListener('input', (event) => {
  // Accept "k7qm4p", "K7Q M4P" or "K7Q-M4P"; show it the way Eaon does.
  const raw = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  event.target.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw
  show('pair-error', false)
})

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  show('pair-error', false)
  const result = await request('pair', { code: $('code').value, port: $('port').value })
  if (!result.ok) {
    $('pair-error').textContent = result.error || 'Pairing failed.'
    show('pair-error', true)
    $('code').focus()
    $('code').select()
  } else {
    $('code').value = ''
  }
})

$('port').addEventListener('change', async () => {
  const result = await request('set-port', { port: $('port').value })
  if (!result.ok) {
    $('pair-error').textContent = result.error
    show('pair-error', true)
  }
})

$('retry').addEventListener('click', () => request('retry'))
$('retry-error').addEventListener('click', () => request('retry'))
$('unpair').addEventListener('click', () => request('unpair'))
$('stop').addEventListener('click', () => request('stop'))
$('resume').addEventListener('click', () => request('resume'))
$('agent-tab').addEventListener('click', () => request('show-agent-tab'))
$('share').addEventListener('click', () => state?.activeTab && request('share', { tabId: state.activeTab.id }))
$('unshare').addEventListener('click', () => state?.activeTab && request('unshare', { tabId: state.activeTab.id }))
