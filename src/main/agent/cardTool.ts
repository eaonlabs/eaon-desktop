import { normalizeUi, uiSummary, ROUTE_MODES, UI_BLOCK_TYPES, UI_ICONS } from '@shared/workerUi'
import { registerToolSource, type AgentTool } from './tools'

/**
 * show_ui: a card the agent lays out itself from blocks (shared/workerUi.ts),
 * in a worker's thread or in Chat: a figure and its trend, a flight, a
 * build's status, a comparison, a plan with tabs. Drawn by Eaon in its own
 * style; nothing the agent writes runs. A card with an id is one the agent
 * keeps: showing it again by that id changes it where it first appeared.
 */
export const uiTool: AgentTool = {
  name: 'show_ui',
  description: `Put a card you design in the conversation, for answers that read better as a small app than as text: a figure and its trend, a flight or delivery, a build or deploy's status, comparing options, a budget, a plan, results.
Give it an id ("revenue", "flight-nw214", "ci-main") when it shows something that changes: calling show_ui again with the same id CHANGES that card where it first appeared instead of adding a new one, so you can keep it up to date as things move (send the whole card each time). A field or a route time that changed shows its old value struck through by itself; set was to say what it was yourself.
Header: title, subtitle (a code or detail beside it: "NW 214"), icon (${UI_ICONS.join('|')}), status {label: "Delayed", tone}.
Blocks (each {type, …}):
- metric {label, value, change: "+12.4%", tone} — one big figure with its change in a pill
- stats {items:[{label, value, change, tone: up|down|neutral|good|warn|bad|info}]} — 2 to 4 figures side by side
- fields {items:[{label, value, was, tone}], columns: 2-4} — labelled values in a grid (Gate B31, Seat 14A); tone warn colours a value that changed
- route {from:{code: "LIS", name, time, was}, to:{…}, mode: ${ROUTE_MODES.join('|')}} — from → to, big codes
- chart {style: line|area|bar, unit, series:[{name, points:[{x, y}]}]} or views:[{label: "Week", series}] to switch (at: "bottom" puts the switch under it)
- tabs {tabs:[{label, blocks}], at: "bottom"} — views of the card the user switches between; at bottom it is a segmented control under them, so a metric and its chart can change together (Week · Month · Year)
- stock {symbol: "NVDA", range: 1d|5d|1mo|6mo|1y, news: true} — LIVE price, move and chart Eaon fetches itself
- heading {text, detail} · text {text} (short; **bold** works) · divider {style: "ticket"} (a boarding-pass edge) · progress {label, value, max} · badges {items:[{label, tone}]}
- table {columns, rows:[[...]]} (sortable) · list {items:[{title, detail, value, tone}]}
- buttons {actions:[{label, reply (sent to you as the user's answer) | url}]}
Keep it to what answers the question, and say the one-line takeaway in your reply too. Never put a number on a card you made up: use what a tool, a file, the web or the user gave you.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The card’s name, to change it later by showing it again with the same id.' },
      title: { type: 'string' },
      subtitle: { type: 'string' },
      icon: { type: 'string', enum: [...UI_ICONS] },
      status: { type: 'object', properties: { label: { type: 'string' }, tone: { type: 'string' } }, required: ['label'] },
      blocks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: UI_BLOCK_TYPES } }, required: ['type'], additionalProperties: true } }
    },
    required: ['blocks']
  },
  mutating: false,
  describe: (input) => (typeof input.title === 'string' && input.title.trim()) || 'A card',
  run: async (input) => {
    const result = normalizeUi(input)
    if ('error' in result) return { text: result.error, isError: true }
    const skipped = result.skipped.length ? ` Left out, fix and show it again if they matter: ${result.skipped.join('; ')}.` : ''
    const kept = result.ui.id ? ` It is card "${result.ui.id}": show_ui with that id again changes it.` : ''
    return `Shown to the user: ${uiSummary(result.ui)}, ${result.ui.blocks.length} block${result.ui.blocks.length === 1 ? '' : 's'}.${kept}${skipped}`
  }
}

// Chat (and its IDE) on Eaon's own loop. A worker gets the same tool with its own apps (features/workers/apps.ts).
const inChat = (query: { mode: string; depth: number; request: { workerId?: string } }): boolean => query.mode === 'work' && query.depth === 0 && !query.request.workerId

registerToolSource({
  id: 'cards',
  tools: (query) => (inChat(query) ? [uiTool] : []),
  guidance: (query) =>
    inChat(query)
      ? 'When an answer has figures, a status or choices (test or benchmark results, a build or deploy, usage, a comparison, a plan), you can show it as a card with show_ui and say the takeaway in a line. Give a card that will change an id and update it with show_ui as things move rather than repeating it. Don’t use cards for code, diffs or plain explanations.'
      : null
})
