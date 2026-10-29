import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUi } from '@shared/workerUi'
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
  assert.deepEqual(normalizeUi({ blocks: [{ type: 'hologram' }] }), { error: 'Nothing on the card could be drawn: block 1: unknown block type "hologram" (use heading, text, stats, chart, stock, table, list, progress, badges, tabs, buttons, divider).' })
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
