import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardDeck, cardId, markChanges, normalizeUi } from '@shared/workerUi'
import { uiTool } from '../src/main/features/workers/apps'
import { workLog } from '../src/renderer/src/components/chat/workLog'

/**
 * Cards a worker lays out itself (show_ui): what it sends is checked block by
 * block, what can be drawn is kept, and what can't comes back to it as a
 * reason it can act on.
 */

test('a stock card: a live stock block, figures, a line of why and a button', () => {
  const result = normalizeUi({
    title: 'NVIDIA today',
    blocks: [
      { type: 'stock', symbol: '$nvda', range: '5d', news: true },
      { type: 'stats', items: [{ label: 'P/E', value: '54.2' }, { label: 'vs S&P 500', value: '+1.8%', change: '+1.8%' }, { label: 'RSI', value: 71, change: '-3', tone: 'warn' }] },
      { type: 'text', text: '**Up on data-center demand** after the earnings beat.' },
      { type: 'buttons', actions: [{ label: 'Alert me at $150', reply: 'Alert me if NVDA hits $150' }] }
    ]
  })
  assert.ok('ui' in result)
  assert.deepEqual(result.skipped, [])
  const [stock, stats, text, buttons] = result.ui.blocks
  assert.deepEqual(stock, { type: 'stock', symbol: 'NVDA', range: '5d', news: true }, 'the ticker cleaned up')
  assert.ok(stats.type === 'stats')
  assert.deepEqual(stats.items.map((i) => [i.value, i.tone]), [['54.2', undefined], ['+1.8%', 'up'], ['71', 'warn']], 'a change’s sign gives its tone, unless one is given')
  assert.equal(text.type, 'text')
  assert.ok(buttons.type === 'buttons' && buttons.actions[0].reply === 'Alert me if NVDA hits $150')
})

test('charts take points in the shapes a model writes them, and views to switch between', () => {
  const result = normalizeUi({
    blocks: [
      { type: 'chart', style: 'bar', unit: 'GW', series: [{ name: 'Load', points: [3, 5, 4] }] },
      { type: 'chart', points: [['Mon', 1], ['Tue', '2.5']] },
      { type: 'chart', views: [{ label: '1W', series: [{ name: 'A', points: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }] }] }, { label: '1M', series: [{ name: 'A', data: [{ date: 'x', value: 3 }, { date: 'y', value: 4 }] }] }] },
      { type: 'chart', series: [{ name: 'Lonely', points: [1] }] }
    ]
  })
  assert.ok('ui' in result)
  const [bars, pairs, views] = result.ui.blocks
  assert.ok(bars.type === 'chart' && bars.style === 'bar' && bars.unit === 'GW' && bars.views[0].series[0].points.map((p) => p.x).join() === '1,2,3')
  assert.ok(pairs.type === 'chart' && pairs.style === 'line' && pairs.views[0].series[0].points[1].y === 2.5)
  assert.ok(views.type === 'chart' && views.views.map((v) => v.label).join() === '1W,1M' && views.views[1].series[0].points[0].y === 3)
  assert.match(result.skipped.join(), /block 4: chart needs series/, 'one point is no chart, and the worker hears why')
})

test('tabs hold blocks one level deep; tables come out square; nonsense is refused with a reason', () => {
  const result = normalizeUi({
    blocks: [
      { type: 'tabs', tabs: [{ label: 'Bull', blocks: [{ type: 'text', text: 'AI capex' }] }, { label: 'Bear', blocks: [{ type: 'tabs', tabs: [] }, { type: 'text', text: 'Valuation' }] }] },
      { type: 'table', columns: ['Ticker', 'Change'], rows: [['NVDA', '+2.1%'], ['AMD'], ['', '']] },
      { type: 'stock', symbol: 'not a ticker!' },
      { type: 'hologram' }
    ]
  })
  assert.ok('ui' in result)
  const [tabs, table] = result.ui.blocks
  assert.ok(tabs.type === 'tabs' && tabs.tabs[1].blocks.length === 1, 'tabs inside tabs are dropped')
  assert.ok(table.type === 'table')
  assert.deepEqual(table.rows, [['NVDA', '+2.1%'], ['AMD', '']], 'short rows padded, empty ones gone')
  assert.match(result.skipped.join('|'), /block 3: stock needs a US ticker/)
  assert.match(result.skipped.join('|'), /block 4: unknown block type "hologram"/)
  assert.deepEqual(normalizeUi({ blocks: [{ type: 'hologram' }] }), { error: 'Nothing on the card could be drawn: block 1: unknown block type "hologram" (use heading, metric, text, stats, fields, route, chart, stock, table, list, progress, badges, tabs, buttons, divider).' })
  assert.ok('error' in normalizeUi('a card please'))
})

test('show_ui answers the worker with what was shown and what was left out, and its card is drawn as one in the thread', async () => {
  const ok = await uiTool.run({ title: 'NVDA', blocks: [{ type: 'stock', symbol: 'NVDA' }, { type: 'mystery' }] }, {} as never)
  assert.match(String(ok), /Shown to the user: NVDA, 1 block\. Left out, fix and show it again if they matter: block 2: unknown block type "mystery"/)
  const refused = await uiTool.run({ blocks: [] }, {} as never)
  assert.ok(typeof refused === 'object' && refused.isError)
  const part = (status: 'done' | 'error') => ({ type: 'tool' as const, id: 'u1', name: 'show_ui', input: {}, output: 'ok', status })
  assert.deepEqual(workLog([part('done')], true).map((i) => i.kind), ['card'])
  assert.deepEqual(workLog([part('error')], true).map((i) => i.kind), ['tools'], 'a refused card stays in the run, with its reason')
})

test('a worker that looks a stock up shows it live, once, unless its own card already does', () => {
  const tool = (id: string, name: string, input: Record<string, unknown>, status: 'done' | 'error' = 'done') => ({ type: 'tool' as const, id, name, input, output: 'ok', status })
  const said = { type: 'text' as const, text: 'NVDA is at $212.93, down 1.14% today.' }
  // A paragraph and no card, as a smaller model answered: the chart is there anyway.
  const plain = workLog([tool('q', 'trading_quote', { symbols: ['nvda'] }), tool('h', 'trading_history', { symbols: ['NVDA'], range: '1mo' }), said], true)
  assert.deepEqual(plain.map((i) => i.kind), ['tools', 'stocks', 'text'])
  const stocks = plain.find((i) => i.kind === 'stocks')
  assert.ok(stocks?.kind === 'stocks' && stocks.symbols.join() === 'NVDA' && stocks.range === '1d', 'once, at the first look')
  // Its own card draws NVDA: no second one; AMD it didn't draw.
  const drawn = workLog([tool('q', 'trading_quote', { symbols: ['NVDA', 'AMD'] }), tool('u', 'show_ui', { blocks: [{ type: 'tabs', tabs: [{ label: 'A', blocks: [{ type: 'stock', symbol: 'NVDA' }] }, { label: 'B', blocks: [{ type: 'text', text: 'x' }] }] }] }), said], true)
  assert.deepEqual(drawn.filter((i) => i.kind === 'stocks').map((i) => (i.kind === 'stocks' ? i.symbols : [])), [['AMD']])
  assert.deepEqual(workLog([tool('q', 'trading_quote', { symbols: ['NVDA'] }, 'error')], true).map((i) => i.kind), ['tools'], 'a failed look shows nothing')
  assert.deepEqual(workLog([tool('q', 'trading_quote', { symbols: ['NVDA'] })], false).map((i) => i.kind), ['tools'], 'a chat is left as it was')
})

test('a boarding pass: a header with its icon and status, a route, fields with what they were, a ticket edge', () => {
  const result = normalizeUi({
    id: 'flight-nw214',
    icon: 'plane',
    title: 'Northwind',
    subtitle: 'NW 214',
    status: { label: 'Delayed', tone: 'bad' },
    blocks: [
      { type: 'route', mode: 'plane', from: { code: 'LIS', name: 'Lisbon', time: '11:05' }, to: { code: 'CPH', name: 'Copenhagen', time: '15:30' } },
      { type: 'fields', items: [{ label: 'Gate', value: 'B31', was: 'B12', tone: 'warn' }, { label: 'Seat', value: '14A' }, { label: 'Group', value: 2 }, { label: 'Empty' }] },
      { type: 'divider', style: 'ticket' },
      { type: 'route', from: 'LIS', to: {} }
    ]
  })
  assert.ok(!('error' in result))
  if ('error' in result) return
  assert.equal(result.ui.id, 'flight-nw214')
  assert.equal(result.ui.icon, 'plane')
  assert.deepEqual(result.ui.status, { label: 'Delayed', tone: 'bad' })
  assert.deepEqual(result.ui.blocks.map((b) => b.type), ['route', 'fields', 'divider'])
  const fields = result.ui.blocks[1]
  assert.ok(fields.type === 'fields')
  assert.deepEqual(fields.items.map((f) => `${f.label}=${f.value}${f.was ? `<-${f.was}` : ''}`), ['Gate=B31<-B12', 'Seat=14A', 'Group=2'], 'a field with no value is left out')
  assert.deepEqual(result.ui.blocks[2], { type: 'divider', style: 'ticket' })
  assert.match(result.skipped.join(), /route needs from and to/)
})

test('a revenue card: a big figure with its change, switched by week, month and year at the bottom', () => {
  const view = (label: string, value: string, change: string) => ({
    label,
    blocks: [
      { type: 'metric', label: 'Revenue', value, change },
      { type: 'chart', style: 'area', points: [1, 3, 2, 5] }
    ]
  })
  const result = normalizeUi({ id: 'revenue', blocks: [{ type: 'tabs', at: 'bottom', tabs: [view('Week', '$11.2k', '+3.1%'), view('Month', '$48.6k', '+12.4%'), view('Year', '$512k', '-2.0%')] }] })
  assert.ok(!('error' in result))
  if ('error' in result) return
  const tabs = result.ui.blocks[0]
  assert.ok(tabs.type === 'tabs' && tabs.at === 'bottom')
  const metric = tabs.tabs[2].blocks[0]
  assert.deepEqual(metric, { type: 'metric', label: 'Revenue', value: '$512k', change: '-2.0%', tone: 'down' }, 'a falling figure reads as down without a tone')
})

test('a card an agent keeps: shown again by its id, it changes where it first was, and what moved shows its old value', () => {
  const v1 = { id: 'flight', title: 'NW 214', blocks: [{ type: 'fields', items: [{ label: 'Gate', value: 'B12' }, { label: 'Seat', value: '14A' }] }, { type: 'route', from: { code: 'LIS', time: '10:40' }, to: { code: 'CPH', time: '15:05' } }] }
  const v2 = { id: 'flight', title: 'NW 214', status: 'Delayed', blocks: [{ type: 'fields', items: [{ label: 'Gate', value: 'B31' }, { label: 'Seat', value: '14A' }] }, { type: 'route', from: { code: 'LIS', time: '11:05' }, to: { code: 'CPH', time: '15:05' } }] }
  const deck = cardDeck([
    { id: 'call-1', input: v1 },
    { id: 'call-2', input: { title: 'No id', blocks: [{ type: 'text', text: 'x' }] } },
    { id: 'call-3', input: v2 }
  ])
  assert.equal(deck.cards.get('flight')?.first, 'call-1', 'drawn where it first appeared')
  assert.equal(deck.cards.get('flight')?.versions.length, 2)
  assert.equal(deck.byCall.get('call-3'), 'flight')
  assert.equal(deck.byCall.has('call-2'), false, 'a card with no id is its own')

  const now = normalizeUi(v2)
  const before = normalizeUi(v1)
  assert.ok(!('error' in now) && !('error' in before))
  if ('error' in now || 'error' in before) return
  const marked = markChanges(now.ui, before.ui)
  const fields = marked.blocks[0]
  const route = marked.blocks[1]
  assert.ok(fields.type === 'fields' && route.type === 'route')
  assert.deepEqual(fields.items.map((f) => f.was ?? null), ['B12', null], 'the gate moved; the seat didn’t')
  assert.equal(route.from.was, '10:40')
  assert.equal(route.to.was, undefined)
  assert.equal(markChanges(now.ui, null), now.ui, 'a first version has nothing to compare')
})

test('in a chat, a card is drawn as a card; ids are kept to names an agent would give', () => {
  const card = { type: 'tool' as const, id: 'c', name: 'show_ui', input: { blocks: [{ type: 'text', text: 'x' }] }, output: 'Shown', status: 'done' as const }
  assert.deepEqual(workLog([card], false).map((i) => i.kind), ['card'])
  assert.deepEqual(workLog([{ ...card, name: 'show_card' }], false).map((i) => i.kind), ['tools'], 'a worker’s ready-made cards stay theirs')
  assert.equal(cardId('ci:main-build.2'), 'ci:main-build.2')
  assert.equal(cardId('has spaces'), undefined)
  assert.equal(cardId(42), '42')
})
